# Server Specification

## Overview

Production HTTPS/WSS server for Teammater project. Replaces Caddy with optimized Rust implementation.

**Purpose:** Serve static web application files, proxy WebSocket connections to the EchoWire STT backend, own the OBS Studio WebSocket connection and broker all OBS state/commands to browser and mobile clients, broadcast OBS overlay data, relay BLE heart rate monitor data, and relay Zigbee2MQTT climate sensor readings.

## Architecture

All internal services launch independently at startup. Each service manages its own lifecycle — retrying on failure without affecting other services. HTTP endpoints return `503 Service Unavailable` when a dependent service is not ready.

```
┌───────────────────────────────────────────────────────┐
│  Axum Server (HTTPS :8443, HTTP :8442)                │
│  ├─ GET /*                  → ServeDir                │
│  ├─ GET /echowire           → WS proxy (mDNS)         │
│  ├─ GET /obs                → WS smart bus            │
│  ├─ GET /api/health         → 200 OK                  │
│  ├─ GET /api/info           → {lan_ip, version}       │
│  └─ ANY /api/import/health-app → log + 200            │
└───────────────┬───────────────────────────────────────┘
                │ internal channels
   ┌────────────┼──────────────┬──────────────┐
   │            │              │              │
┌──▼──────────┐ │  ┌───────────▼──────────┐  │
│ mDNS disc.  │ │  │  OBS WebSocket client│  │
│ _echowire.  │ │  │  ws://localhost:4455 │  │
│ _tcp        │ │  │  → obs broadcast chan│  │
└─────────────┘ │  └──────────────────────┘  │
           ┌────▼──────────────────────────┐  │
           │  BLE heart rate               │  │
           │  device: HeartCast            │  │
           │  → obs broadcast chan         │  │
           └───────────────────────────────┘  │
           ┌───────────────────────────────┐  │
           │  Zigbee2MQTT climate (T1)     │  │
           │  ws://c:8081/api              │  │
           │  → obs broadcast chan         │  │
           └───────────────────────────────┘  │
                                     ┌────────▼──────┐
                                     │ Log ring buf  │
                                     │ last 5 lines  │
                                     └───────────────┘
```

## Services

### HTTPS / HTTP Server
- HTTPS on `0.0.0.0:8443` (TLS 1.3, HTTP/1.1 forced for WebSocket compat)
- HTTP on `0.0.0.0:8442` (plain, for local tooling)
- Static files served from project root (`.`)
- Auto-generates self-signed cert in `server/certs/` on first run
- **LAN IP detection**: enumerates all network interfaces via `if-addrs` crate; prefers 192.168.x.x → 172.16–31.x.x → 10.x.x.x (avoids VPN/tunnel interfaces); falls back to UDP connect trick if no private IP found
- **Cert SAN**: cert includes both `localhost` and the detected LAN IP as Subject Alternative Names
- **Cert regeneration**: on startup, if stored cert SAN does not include current LAN IP, regenerate cert
- `/api/info` returns `{"lan_ip": "192.168.x.x", "port": 8443}` — used by main page to build mobile QR code URL

### mDNS Discovery
- Browses for `_echowire._tcp.local.` continuously
- On resolve: stores `EchoWireService { name, host, port, addresses }` in shared state
- On remove: clears stored service
- Notifies active `/echowire` proxy connections via `watch::Sender<u64>` (generation counter)
- Retries after 5s on daemon/browse failure; loops forever

### EchoWire WebSocket Proxy (`/echowire`)
- Returns `503` immediately if no EchoWire service is discovered yet
- Subscribes to generation watch **before** reading backend URL — no race between URL capture and change detection
- Rejects upgrade if generation changed while the WS handshake was in flight
- Drops connection when backend address changes (generation watch fires)
- Bidirectional forwarding: text, binary, ping, pong; close terminates session

### OBS Smart Bus (`/obs`)

The `/obs` WebSocket endpoint is the central hub for OBS state, commands, logs, and viewer data. Behavior depends on message type.

**Requires `?token=<secret>`** (added after this section was first written —
see `src/security.rs`). The bus is not read-only: it carries `twitch_timeout`/
`twitch_shoutout`/`cmd_*` that the main page executes with the streamer's
Twitch moderator token, and both listeners bind `0.0.0.0`. The upgrade is
rejected with `401` before it completes if the token is missing or wrong.
The token is generated on first run into `server/certs/bus_token.txt`
(gitignored, and itself blocked by the same path guard); `GET /api/info`
returns it only to loopback callers, and the QR flow carries it to the phone
in the URL fragment. See `bus-token.js` (client side) for the acquisition logic.

**On client connect**, server immediately sends:
1. Last 5 log lines from ring buffer as individual `log` messages
2. Current `obs_state` snapshot (if OBS is connected)
3. Latest cached `sysinfo`, `now_playing`, and `climate` messages (whichever have been seen) — so a reconnecting overlay shows current values without waiting for the next (possibly slow) report

**Message routing rules:**

| Message `type` | Origin | Server action |
|----------------|--------|---------------|
| `obs_config` | browser OBS module | Update OBS connection config (url+password) via watch channel; triggers OBS reconnect if URL changed; **not** relayed |
| `cmd_*` | any client | Execute against OBS via mpsc channel; **not** relayed |
| `log` | main page | Add to ring buffer; relay to all other clients |
| `viewer_count`, `now_playing`, `music_*` | any client | Relay to all other clients |
| `obs_state`, `obs_scene`, `obs_streaming`, `obs_recording` | OBS client task | Broadcast to all clients (`sender_id = u64::MAX`) |
| BLE `heartrate` | BLE task | Broadcast to all clients (`sender_id = u64::MAX`) |
| anything else | any client | Relay to all other clients |

**Channel capacity:** 16 messages (lagged receivers drop silently).

**Log ring buffer:** fixed-size array of 5 entries in server shared state. Each incoming `log` message overwrites oldest. Sent to new WS clients before the `obs_state` snapshot.

### OBS WebSocket Client Service (`src/obs.rs`)

Owns the single connection to OBS Studio. URL and password are **not hardcoded** — they are pushed by the browser OBS module via an `obs_config` bus message on WebSocket open. The task waits for a non-empty URL via a `watch::Receiver<ObsConfig>` before attempting to connect; reconnects immediately when config changes.

**Authentication:** OBS WebSocket 5.x — SHA-256 HMAC of password + salt, sends `Identify` with `rpcVersion: 1`.

**Startup:**
1. Connect to OBS. On failure: log warning, retry after 5s, forever.
2. Authenticate.
3. Send `GetSceneList`, `GetCurrentProgramScene`, `GetStreamStatus`, `GetRecordStatus`.
4. Publish `obs_state` snapshot to broadcast channel.
5. Subscribe to OBS events: `SceneListChanged`, `CurrentProgramSceneChanged`, `StreamStateChanged`, `RecordStateChanged`, `RecordFileSaved`.
6. Start 2s poll timer for `GetStreamStatus` and `GetRecordStatus` (stats update).

**State maintained in shared `Arc<RwLock<SharedObsState>>`:**
```rust
pub struct SharedObsState {
    pub connected: bool,
    pub scene: String,
    pub scenes: Vec<String>,
    pub streaming: Option<StreamingInfo>,
    pub recording: Option<RecordingInfo>,
}

pub struct StreamingInfo {
    pub active: bool,
    pub timecode: String,        // "HH:MM:SS.mmm" from OBS outputTimecode
    pub dropped_frames: u32,
    pub total_frames: u32,
    pub bitrate_kbps: u32,       // computed from outputBytes diff between polls
}

pub struct RecordingInfo {
    pub active: bool,
    pub paused: bool,
    pub timecode: String,        // cumulative active time from OBS outputTimecode
}
```

**Recording timecode:** uses OBS's own `outputTimecode` from `GetRecordStatus` — it already represents cumulative active recording time (excludes pauses). No manual tracking needed.

**Bitrate calculation:** `(outputBytes_diff * 8) / poll_interval_secs / 1000` kbps, updated every 2s poll.

**Command handling** — when `/obs` bus receives a `cmd_*` message, the OBS client service processes it:
- `cmd_switch_scene` → `SetCurrentProgramScene`
- `cmd_start_record` → `StartRecord`
- `cmd_stop_record` → `StopRecord`
- `cmd_pause_record` → `PauseRecord`
- `cmd_resume_record` → `ResumeRecord`

On disconnect from OBS: publish `{"type":"obs_state","connected":false}` to broadcast channel, retry connect after 5s.

### BLE Heart Rate Monitor
- Device: `HeartCast` (name match via `contains`)
- Service: Heart Rate `0x180D` / Characteristic: `0x2A37`
- Manager and adapter initialized once — Manager must stay alive (owns CoreBluetooth event loop)
- Init retries with 5s delay if adapter unavailable (e.g., Bluetooth off at startup)

**Scan loop** (`scan_until_found`):
- Never returns an error — all transient failures retried internally
- Subscribes to adapter events before `start_scan` to avoid missing early advertisements
- 5s scan windows; warns and retries on timeout or stream error

**Session loop** (`run_ble`):
- Subscribes to adapter events before `peripheral.notifications()` to avoid missing `DeviceDisconnected`
- Three exit conditions, all handled:
  1. `DeviceDisconnected` event
  2. Notification stream ends (`None`)
  3. Watchdog: no HR packet for 10s → assumes silent device loss
- `peripheral.disconnect()` capped at 2s timeout (CoreBluetooth event loop may already be dead)
- After exit: 5s delay, then new scan cycle

**Logging:** only on zero ↔ non-zero transitions (suppresses per-second noise)

**Published message format:**
```json
{"type": "heartrate", "heartrate": 72}
```
`type` is REQUIRED. mobile.html dispatches on `msg.type` and silently dropped
every typeless reading; obs.js sniffs the `heartrate` field directly, so it
accepts either. Emit both fields — a new sensor copied from the old typeless
shape would reintroduce the bug, spec-driven this time.

### Zigbee2MQTT Climate Sensor (`src/zigbee.rs`)

Zigbee2MQTT is MQTT-first with no REST API. Its frontend WebSocket bridge is the
dependency-free path into device state (reuses `tokio-tungstenite`), so the task
connects there rather than to the MQTT broker.

- Connects to `ws://c:8081/api`; on connect Z2M replays retained device state, so the first reading arrives immediately
- Watches one device by friendly name: `T1` (Xiaomi WSDCGQ01LM temperature/humidity sensor). Address and device name are hardcoded
- Frames are `{"topic":"<friendly_name>","payload":{...}}`; task filters `topic == "T1"` and reads `temperature` / `humidity` from the payload
- Carries the last-known value of each metric, so a report containing only one attribute still broadcasts a complete pair; values rounded to one decimal
- Broadcasts to the obs channel (`sender_id = u64::MAX`):
  ```json
  {"type":"climate","temperature":23.4,"humidity":61.8}
  ```
- Answers WS `Ping` with `Pong` to avoid mid-stream drops
- Reconnects after `Z2M_RECONNECT_DELAY` on close/error; never affects other services — if Z2M is unreachable the task just retries and the overlay's climate widget never appears
- Latest reading cached in `last_climate` and replayed to new `/obs` clients (T1 reports on change — minutes to ~an hour — so late joiners must not wait)

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/*` | Static file serving from project root |
| GET | `/echowire` | WebSocket proxy to EchoWire STT backend |
| GET | `/obs` | WebSocket smart bus (OBS state, commands, logs, BLE) |
| GET | `/api/health` | `200 OK` health check |
| GET | `/mobile` | Serves `mobile.html` (phone remote control page) |
| GET | `/api/info` | `{"lan_ip":"192.168.x.x","port":8443}` |
| ANY | `/api/import/health-app` | Logs method, URI, headers, body → `200 OK` |

## Configuration

All configuration is compile-time, spread across the module each constant
belongs to (see `## File Structure` below) since the `main.rs` split. Names
below are current as of that split — grep for the name rather than trusting
this table blindly the next time something moves.

| Constant | Where | Value | Description |
|----------|-------|-------|-------------|
| `HTTPS_ADDR` | `main.rs` | `0.0.0.0:8443` | HTTPS bind address |
| `HTTP_ADDR` | `main.rs` | `0.0.0.0:8442` | HTTP bind address |
| `CERT_PATH` | `main.rs` | `server/certs/cert.pem` | TLS certificate |
| `KEY_PATH` | `main.rs` | `server/certs/key.pem` | TLS private key |
| `MAX_HEALTH_APP_BODY` | `main.rs` | 1 MiB | Cap on `/api/import/health-app` body size |
| `BUS_TOKEN_PATH` | `security.rs` | `server/certs/bus_token.txt` | `/obs` shared secret |
| `OBS_BROADCAST_CAPACITY` | `state.rs` | 16 | Broadcast channel buffer |
| `LOG_RING_SIZE` | `state.rs` | 5 | Log lines buffered for late joiners |
| `OBS_POLL_INTERVAL` | `obs.rs` | 2s | Streaming/recording stats poll rate |
| `OBS_RECONNECT_DELAY_MAX` | `obs.rs` | 300s | Cap on the reconnect backoff (starts at 1s, doubles) |
| `MDNS_RETRY_DELAY` | `echowire.rs` | 5s | mDNS daemon restart delay |
| `SERVICE_TYPE` | `echowire.rs` | `_echowire._tcp.local.` | mDNS service type |
| `DEVICE_NAME` | `ble.rs` | `HeartCast` | BLE device name substring |
| `RECONNECT_DELAY` | `ble.rs` | 5s | BLE scan/reconnect delay |
| `SCAN_WINDOW` | `ble.rs` | 5s | BLE scan burst duration |
| `HR_WATCHDOG` | `ble.rs` | 10s | Silence timeout before reconnect |
| `Z2M_ADDR` | `zigbee.rs` | `ws://c:8081/api` | Zigbee2MQTT frontend WS bridge |
| `Z2M_DEVICE` | `zigbee.rs` | `T1` | Watched sensor friendly name |
| `Z2M_RECONNECT_DELAY` | `zigbee.rs` | 5s | Zigbee reconnect delay on failure |

The OBS *Studio* WebSocket address (`ws://localhost:4455` by default) is
deliberately NOT a constant here — it's runtime-pushed by the browser OBS
module via an `obs_config` bus message, see the section above.

Runtime: `RUST_LOG=info` (default), `RUST_LOG=debug` for verbose output.

## File Structure

```
server/
├── Cargo.toml
├── Cargo.lock
├── SPEC.md             # This file
├── src/
│   ├── main.rs         # main(): tracing/TLS/AppState setup, task spawns, router, dual-listener serve
│   ├── state.rs        # AppState, ObsMessage, OBS_BROADCAST_CAPACITY, LOG_RING_SIZE
│   ├── security.rs     # is_sensitive_path / deny_sensitive_paths guard, bus token generation
│   ├── bus.rs          # /obs client protocol: upgrade, welcome burst, message routing
│   ├── obs.rs          # OBS Studio WebSocket client, state machine, command dispatch
│   ├── echowire.rs     # /echowire WS proxy + mDNS discovery of the STT backend
│   ├── ble.rs          # BLE heart rate monitor
│   ├── sysinfo_task.rs # Host CPU usage / temperature poller
│   ├── zigbee.rs       # Zigbee2MQTT climate sensor (T1) via WS bridge
│   └── tls.rs          # Certificate generation with LAN IP SAN
└── certs/             # Auto-generated (not in git)
    ├── cert.pem
    ├── key.pem
    └── bus_token.txt  # /obs shared secret
```

## Build & Run

```bash
# From project root
cd server && cargo build --release
cd .. && ./server/target/release/teammater-server
```

Server must run from project root to serve static files correctly.

## Logging Reference

```
INFO  🚀 HTTPS listening on https://0.0.0.0:8443
INFO  🌐 HTTP  listening on http://0.0.0.0:8442
INFO  📱 Mobile URL: https://192.168.1.42:8443/mobile
INFO  🎬 OBS connecting to ws://localhost:4455...
INFO  🎬 OBS connected, scene: Gaming (5 scenes)
WARN  🎬 OBS disconnected, retrying in 5s...
INFO  💓 BLE adapter ready
INFO  💓 Scanning for 'HeartCast' (5s window)...
INFO  💓 Found: VI [HeartCast-iPhon]
INFO  💓 Connected to HeartCast
INFO  💓 Heart Rate: 82 bpm          ← logged on 0↔non-0 transition only
WARN  💓 No HR data for 10s, assuming device gone
WARN  💓 BLE session ended, reconnecting...
WARN  💓 start_scan failed: ..., retrying...
INFO  ✅ EchoWire: ... at host:port
WARN  ⚠️  EchoWire removed: ...
WARN  🔄 Backend changed, dropping connection
```

## Version History

### v0.4.0 (2026-07-11)
- Zigbee2MQTT climate source (`src/zigbee.rs`) — server-side task on the Z2M frontend WS bridge (`ws://c:8081/api`), watching sensor `T1`, broadcasting `{"type":"climate",...}` to the `/obs` bus; zero new dependencies (reuses `tokio-tungstenite`)
- Latest climate cached (`last_climate`) and replayed to new clients in the connect welcome burst
- OBS overlay: room temperature + humidity widget (`#climate-widget`) with sparklines and comfort color zones; no stale-out (T1 reports infrequently)

### v0.3.0 (2026-05-18)
- OBS WebSocket client service (`src/obs.rs`) — server-side OBS owner/broker
- OBS connection config pushed from browser OBS module on `/obs` connect (`obs_config` message); server waits for non-empty URL before connecting
- OBS smart bus: typed message routing — `cmd_*` intercepted, `obs_config` applied, `log` buffered+relayed, rest relayed
- Log ring buffer (5 lines) for late-joining mobile clients
- `/api/info` endpoint (LAN IP + port for QR code)
- `/mobile` route serving `mobile.html`
- TLS cert SAN with auto-detected LAN IP; regenerate on IP change
- LAN IP detection: prefers 192.168.x.x over VPN/tunnel ranges (`if-addrs` crate)
- Mobile page (`mobile.html`): scene picker, heart rate widget, song name, music controls (prev/play-pause/skip), recording single-row, Screen Wake Lock
- QR code in main page right panel linking to mobile URL

### v0.2.0 (2026-03-26)
- BLE: resilient init — retries adapter init forever instead of exiting
- BLE: Manager kept alive for CoreBluetooth event loop lifetime
- BLE: watchdog timer (10s) detects silent device loss
- BLE: `scan_until_found` absorbs transient errors internally, never propagates
- BLE: `peripheral.disconnect()` capped at 2s timeout
- BLE: HR logging suppressed to zero↔non-zero transitions only
- EchoWire proxy: generation watch subscribed before URL read, eliminating race condition
- EchoWire proxy: early rejection if generation changed during WS upgrade

### v0.1.0 (2026-01-29)
- Initial implementation: HTTPS server, static files, WebSocket proxy, mDNS discovery, BLE heart rate, OBS broadcast bus
