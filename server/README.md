# Teammater Server

Production-ready Rust HTTPS/WSS server replacing Caddy.

## Features

- **HTTPS**: Secure TLS 1.3 connections on port 8443
- **Static File Serving**: Serves files from project root directory
- **WebSocket Proxy**: Proxies `/echowire` to Android STT backend
- **Auto-Generated Certificates**: Creates self-signed cert if none exists
- **Efficient**: Built with Tokio + Axum + Tungstenite

## Quick Start

```bash
# Build (release mode recommended)
cd server
cargo build --release

# Run from project root
./server/target/release/teammater-server
```

Server starts at: `https://localhost:8443`

## Endpoints

- `GET /` - Static file server (serves `index.html`, `index.js`, etc.)
- `GET /echowire` - WebSocket proxy to `ws://192.168.15.225:8080`

## TLS Certificates

Certificates stored in `server/certs/`:
- `cert.pem` - Self-signed certificate (valid for localhost)
- `key.pem` - Private key

Auto-generated on first run if missing. Replace with real certs for production.

## Configuration

Edit `src/main.rs` to change:
- Port: `8443` (line 41)
- Backend URL: `ws://192.168.15.225:8080` (line 29)
- Cert paths: `server/certs/` (lines 36-37)

## Architecture

```
Client (Browser)
    ↓ wss://localhost:8443/echowire
Rust Server (Axum + Tungstenite)
    ↓ ws://192.168.15.225:8080
Android STT Backend (Echowire)
```

Bidirectional proxy maintains full WebSocket protocol (text, binary, ping/pong, close).

## Dependencies

- **tokio**: Async runtime
- **axum**: Web framework with WebSocket support
- **axum-server**: TLS server implementation
- **tokio-tungstenite**: WebSocket client
- **tower-http**: Static file serving
- **rcgen**: Self-signed certificate generation
- **tracing**: Structured logging

## Logging

Set `RUST_LOG` for detailed logs:
```bash
RUST_LOG=debug ./server/target/release/teammater-server
```

## Comparison to Caddy

| Feature | Caddy | Rust Server |
|---------|-------|-------------|
| Binary size | ~50MB | ~8MB |
| Memory usage | ~50MB | ~5MB |
| Startup time | ~200ms | ~10ms |
| Configuration | Caddyfile | Code |
| Auto-reload | Yes | No (rebuild required) |
| HTTPS | Auto (Let's Encrypt) | Self-signed |

Rust server is **smaller, faster, more efficient** but requires rebuild for config changes.
