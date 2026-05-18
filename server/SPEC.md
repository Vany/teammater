# Server Specification

## Overview

Production HTTPS/WSS server for Teammater project. Replaces Caddy with optimized Rust implementation.

**Purpose:** Serve static web application files, proxy WebSocket connections to the EchoWire STT backend, own the OBS Studio WebSocket connection and broker all OBS state/commands to browser and mobile clients, broadcast OBS overlay data, and relay BLE heart rate monitor data.

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

**On client connect**, server immediately sends:
1. Last 5 log lines from ring buffer as individual `log` messages
2. Current `obs_state` snapshot (if OBS is connected)

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
{"heartrate": 72}
```

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

All configuration is compile-time in `src/main.rs`, `src/ble.rs`, and `src/obs.rs`.

| Constant | Value | Description |
|----------|-------|-------------|
| `LISTEN_ADDR` | `0.0.0.0:8443` | HTTPS bind address |
| `HTTP_ADDR` | `0.0.0.0:8442` | HTTP bind address |
| `CERT_PATH` | `server/certs/cert.pem` | TLS certificate |
| `KEY_PATH` | `server/certs/key.pem` | TLS private key |
| `MDNS_RETRY_DELAY` | 5s | mDNS daemon restart delay |
| `OBS_BROADCAST_CAPACITY` | 16 | Broadcast channel buffer |
| `OBS_LOG_RING_SIZE` | 5 | Log lines buffered for late joiners |
| `OBS_ADDR` | `ws://localhost:4455` | OBS WebSocket address |
| `OBS_POLL_INTERVAL` | 2s | Streaming/recording stats poll rate |
| `OBS_RECONNECT_DELAY` | 5s | OBS reconnect delay on failure |
| `SERVICE_TYPE` | `_echowire._tcp.local.` | mDNS service type |
| `DEVICE_NAME` | `HeartCast` | BLE device name substring |
| `RECONNECT_DELAY` | 5s | BLE scan/reconnect delay |
| `SCAN_WINDOW` | 5s | BLE scan burst duration |
| `HR_WATCHDOG` | 10s | Silence timeout before reconnect |

Runtime: `RUST_LOG=info` (default), `RUST_LOG=debug` for verbose output.

## File Structure

```
server/
├── Cargo.toml
├── Cargo.lock
├── SPEC.md             # This file
├── src/
│   ├── main.rs        # Server, routing, mDNS, obs bus handler, echowire proxy
│   ├── obs.rs         # OBS WebSocket client, state machine, command dispatch
│   ├── ble.rs         # BLE heart rate monitor
│   └── tls.rs         # Certificate generation with LAN IP SAN
└── certs/             # Auto-generated (not in git)
    ├── cert.pem
    └── key.pem
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
