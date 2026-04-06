# Server Specification

## Overview

Production HTTPS/WSS server for Teammater project. Replaces Caddy with optimized Rust implementation.

**Purpose:** Serve static web application files, proxy WebSocket connections to the EchoWire STT backend, broadcast OBS overlay data, and relay BLE heart rate monitor data.

## Architecture

All internal services launch independently at startup. Each service manages its own lifecycle — retrying on failure without affecting other services. HTTP endpoints return `503 Service Unavailable` when a dependent service is not ready.

```
┌─────────────────────────────────────────────────┐
│  Axum Server (HTTPS :8443, HTTP :8442)          │
│  ├─ GET /*              → ServeDir              │
│  ├─ GET /echowire       → WS proxy (mDNS)       │
│  ├─ GET /obs            → WS broadcast bus      │
│  ├─ GET /api/health     → 200 OK                │
│  └─ ANY /api/import/health-app → log + 200      │
└──────────────┬──────────────────────────────────┘
               │ internal channels
   ┌───────────┴────────────┐
   │                        │
┌──▼──────────────┐  ┌──────▼────────────────┐
│  mDNS discovery │  │  BLE heart rate        │
│  _echowire._tcp │  │  device: HeartCast     │
│  → watch channel│  │  → obs broadcast chan  │
└─────────────────┘  └───────────────────────┘
```

## Services

### HTTPS / HTTP Server
- HTTPS on `0.0.0.0:8443` (TLS 1.3, HTTP/1.1 forced for WebSocket compat)
- HTTP on `0.0.0.0:8442` (plain, for local tooling)
- Static files served from project root (`.`)
- Auto-generates self-signed cert in `server/certs/` on first run

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

### OBS Broadcast Bus (`/obs`)
- Broadcast WebSocket: every message is forwarded to all connected clients except sender
- `sender_id == u64::MAX` = system/BLE message, delivered to all clients
- Channel capacity: 8 messages (lagged receivers drop silently)

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
| GET | `/obs` | WebSocket broadcast bus (OBS overlay, BLE data) |
| ANY | `/api/health` | `200 OK` health check |
| ANY | `/api/import/health-app` | Logs method, URI, headers, body → `200 OK` |

## Configuration

All configuration is compile-time in `src/main.rs` and `src/ble.rs`.

| Constant | Value | Description |
|----------|-------|-------------|
| `LISTEN_ADDR` | `0.0.0.0:8443` | HTTPS bind address |
| `HTTP_ADDR` | `0.0.0.0:8442` | HTTP bind address |
| `CERT_PATH` | `server/certs/cert.pem` | TLS certificate |
| `KEY_PATH` | `server/certs/key.pem` | TLS private key |
| `MDNS_RETRY_DELAY` | 5s | mDNS daemon restart delay |
| `OBS_BROADCAST_CAPACITY` | 8 | Broadcast channel buffer |
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
│   ├── main.rs        # Server, routing, mDNS, OBS broadcast, echowire proxy
│   ├── ble.rs         # BLE heart rate monitor
│   └── tls.rs         # Certificate generation and loading
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
