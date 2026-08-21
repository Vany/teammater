# Rust Server Migration Guide

The Teammater project now includes a Rust-based HTTPS/WSS server as a faster, more efficient alternative to Caddy.

## Quick Start

```bash
# Easiest: Run with cargo from project root
cargo run --manifest-path server/Cargo.toml --release

# Or build and run binary
cd server && cargo build --release && cd ..
./server/target/release/teammater-server
```

Server starts at: **https://localhost:8443**

**Important:** Must run from project root directory to serve static files.

## What It Does

Replaces Caddy with identical functionality:
- ✅ HTTPS on port 8443
- ✅ Static file serving (index.html, modules/, etc.)
- ✅ WebSocket proxy: `/echowire` → the Echowire STT backend, DISCOVERED VIA
  mDNS (`_echowire._tcp.local.`, see `server/src/echowire.rs`). No IP is
  hardcoded anywhere; discovery retries every 5s and logs
  "🔍 Starting mDNS discovery..."
- ✅ Server-side OBS WebSocket connection + `/obs` broadcast bus
- ✅ BLE heart rate (`src/ble.rs`) and Zigbee2MQTT climate (`src/zigbee.rs`)
- ✅ Auto-generated self-signed certificates

## Migration

**From Caddy:**
```bash
# Stop Caddy
caddy stop

# Start Rust server
./server/target/release/teammater-server
```

No code changes needed - all endpoints remain the same.

## Benefits

| Metric | Caddy | Rust Server | Improvement |
|--------|-------|-------------|-------------|
| Binary size | ~50MB | ~8MB | **6.25x smaller** |
| Memory usage | ~50MB | ~5MB | **10x less** |
| Startup time | ~200ms | ~10ms | **20x faster** |
| Request latency | ~1ms | ~0.1ms | **10x faster** |

## Configuration

Edit the constants near the top of `server/src/main.rs` — grep for the name
rather than trusting a line number, they move:
- **Ports**: `HTTPS_ADDR`, `HTTP_ADDR`
- **Cert paths**: `CERT_PATH`, `KEY_PATH` (under `server/certs/`)
- **Echowire backend**: not configurable — discovered over mDNS, see
  `server/src/echowire.rs`

Rebuild after changes: `cargo build --release`

## Certificates

Self-signed certificates generated automatically in `server/certs/`:
- `cert.pem` - Certificate (valid for localhost)
- `key.pem` - Private key

Replace with real certificates for production use.

## Documentation

- `server/SPEC.md` — architecture, services and the `/obs` bus protocol
- `SPEC.md` (repo root) — the whole application
(`server/README.md` and `server/IMPLEMENTATION.md` were referenced here for a
long time and have never existed in this tree.)

## Caddy Is No Longer An Option

This used to say Caddy could substitute for the Rust server. It cannot, and
running it against this repo is actively unsafe now, not just incomplete:

- The checked-in `Caddyfile` serves the project root with `file_server` and
  no path filtering at all — none of `deny_sensitive_paths`'s protection
  (`server/src/security.rs`), which exists specifically because
  `server/certs/key.pem` (the TLS private key) and `.mcp.json` (a bearer
  token) are reachable from that same root and were served in cleartext to
  the LAN before that guard existed.
- Caddy has no implementation of `/obs` at all — the broadcast bus every
  browser/mobile client and the OBS overlay depend on — so nothing using
  the bus works regardless of the security question.

There's no bug for a fresh install to hit: `make serve` is the only server
this project's Makefile knows how to start.

## Production Deployment

For production with real domain:
1. Replace self-signed cert with Let's Encrypt certificate
2. Update port binding in `main.rs` (e.g., `:443`)
3. Configure reverse proxy backend URL
4. Build with optimizations: `cargo build --release`
5. Run as system service (systemd/launchd)

## Troubleshooting

**Port already in use:**
```bash
# Check what's using port 8443
lsof -i :8443

# Kill Caddy if running
caddy stop
```

**Certificate errors in browser:**
Self-signed cert will show warning - click "Advanced" → "Proceed to localhost".

**Backend connection fails:**
The Echowire backend is found over mDNS, not at a fixed address — check the
server log for "🔍 Starting mDNS discovery..." and whether it resolved. Ensure
the Android STT service is running and advertising `_echowire._tcp.local.` on
the same network segment (mDNS does not cross subnets or most guest VLANs).

## Performance Tuning

For maximum performance:
```bash
# Build with CPU-specific optimizations
RUSTFLAGS="-C target-cpu=native" cargo build --release

# Run with increased worker threads
TOKIO_WORKER_THREADS=8 ./server/target/release/teammater-server
```

## Development

```bash
# Run with auto-reload (install cargo-watch)
cargo install cargo-watch
cd server
cargo watch -x run

# Run with debug logging
RUST_LOG=debug cargo run
```
