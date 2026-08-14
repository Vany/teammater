use anyhow::Result;
use axum::{
    body::to_bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use obs::ObsConfig;
use serde_json::Value;
use std::{
    collections::VecDeque,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{broadcast, mpsc, watch, RwLock};
use tower_http::services::{ServeDir, ServeFile};
use tracing::{error, info, info_span, warn, Instrument};

/// Reject requests for anything under the project root that is not a web asset.
///
/// Static serving is rooted at "." for convenience, which also exposes secrets
/// that live there. Deny by SHAPE rather than by listing filenames, so a new
/// secret does not silently become public the day it is added:
///   - any path segment starting with '.'  → dotfiles (.mcp.json, .env, .git)
///     and, as a free side effect, ".." traversal segments
///   - anything under /server              → TLS keys in certs/, sources, target/
///
/// Runs as a layer over the whole router, but every real route is matched
/// before the ServeDir fallback and none of them live under those prefixes.
fn is_sensitive_path(path: &str) -> bool {
    // Compare the DECODED path. The first version of this guard checked the raw
    // URI, but ServeDir percent-decodes each segment before hitting the disk —
    // so `/%2Emcp.json` and `/%73erver/certs/key.pem` sailed past it and served
    // the MCP token and the TLS private key anyway. Verified against the
    // running server: 200 with real content, while the undecoded spellings
    // correctly 404'd.
    //
    // Decode repeatedly until stable so a double-encoded `/%252Emcp.json`
    // cannot slip through either. Bounded, because a decode loop on attacker
    // input must terminate.
    let mut decoded = path.to_owned();
    for _ in 0..4 {
        let next = percent_encoding::percent_decode_str(&decoded)
            .decode_utf8_lossy()
            .into_owned();
        if next == decoded {
            break;
        }
        decoded = next;
    }

    let hidden = decoded.split('/').any(|seg| seg.starts_with('.'));
    let server_dir = decoded == "/server" || decoded.starts_with("/server/");
    hidden || server_dir
}

async fn deny_sensitive_paths(req: Request, next: axum::middleware::Next) -> Response {
    let path = req.uri().path();
    if is_sensitive_path(path) {
        warn!("🔒 Blocked request for sensitive path: {path}");
        // 404, not 403: a 403 confirms the file is there.
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod path_guard_tests {
    use super::is_sensitive_path;

    #[test]
    fn blocks_the_secrets_that_were_actually_reachable() {
        // Both of these returned 200 with real content before the guard.
        assert!(is_sensitive_path("/.mcp.json"));
        assert!(is_sensitive_path("/server/certs/key.pem"));
    }

    #[test]
    fn blocks_dotfiles_and_traversal_anywhere_in_the_path() {
        assert!(is_sensitive_path("/.env"));
        assert!(is_sensitive_path("/.git/config"));
        assert!(is_sensitive_path("/modules/../.mcp.json"));
        assert!(is_sensitive_path("/mp3/.hidden/x.mp3"));
    }

    #[test]
    fn blocks_the_whole_server_subtree() {
        assert!(is_sensitive_path("/server"));
        assert!(is_sensitive_path("/server/src/main.rs"));
        assert!(is_sensitive_path("/server/target/release/teammater-server"));
    }

    #[test]
    fn still_serves_the_actual_web_assets() {
        for ok in [
            "/",
            "/index.html",
            "/obs.html",
            "/mobile.html",
            "/index.js",
            "/modules/llm/module.js",
            "/mp3/startup.mp3",
            "/api/health",
        ] {
            assert!(!is_sensitive_path(ok), "{ok} must stay reachable");
        }
    }

    #[test]
    fn blocks_percent_encoded_spellings_of_the_same_paths() {
        // These returned 200 with the real MCP token and TLS key against the
        // running server while the guard compared the RAW path.
        assert!(is_sensitive_path("/%2Emcp.json"));
        assert!(is_sensitive_path("/%73erver/certs/key.pem"));
        assert!(is_sensitive_path("/%73erver/certs/bus_token.txt"));
        assert!(is_sensitive_path("/%2E%67it/config"));
    }

    #[test]
    fn blocks_double_encoded_spellings() {
        assert!(is_sensitive_path("/%252Emcp.json"));
        assert!(is_sensitive_path("/%2573erver/certs/key.pem"));
    }

    #[test]
    fn does_not_block_names_merely_containing_a_dot() {
        // Only a segment STARTING with '.' is hidden; extensions are fine.
        assert!(!is_sensitive_path("/teammater.js"));
        assert!(!is_sensitive_path("/server-status.html"));
    }
}

mod ble;
mod echowire;
mod obs;
mod sysinfo_task;
mod tls;
mod zigbee;

// ─────────────────────────────────────────────── configuration ──

const HTTPS_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8443);
const HTTP_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8442);
const CERT_PATH: &str = "server/certs/cert.pem";
const KEY_PATH: &str = "server/certs/key.pem";
/// Lives beside the TLS material: server/certs/ is gitignored AND blocked by
/// deny_sensitive_paths, so the token is neither committed nor servable.
const BUS_TOKEN_PATH: &str = "server/certs/bus_token.txt";

/// Load the /obs bus token, generating one on first run.
///
/// Stable across restarts so a phone that scanned the QR code once keeps
/// working. Derived from the OS RNG via rand, hex-encoded.
fn load_or_create_bus_token() -> String {
    if let Ok(existing) = std::fs::read_to_string(BUS_TOKEN_PATH) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

    if let Some(dir) = Path::new(BUS_TOKEN_PATH).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(BUS_TOKEN_PATH, &token) {
        Ok(()) => info!("🔑 Generated new /obs bus token at {BUS_TOKEN_PATH}"),
        // Non-fatal on purpose: an in-memory token still secures this run, it
        // just means phones must re-scan after a restart. Failing to start the
        // whole server over this would be worse.
        Err(e) => error!("⚠️ Could not persist bus token ({e}) — using in-memory token"),
    }
    token
}

const OBS_BROADCAST_CAPACITY: usize = 16;
const LOG_RING_SIZE: usize = 5;

// ─────────────────────────────────────────────────── bus types ──

/// Broadcast envelope — sender_id == u64::MAX means server-originated (all clients receive).
#[derive(Clone, Debug)]
pub struct ObsMessage {
    pub sender_id: u64,
    pub text: String,
}

// ─────────────────────────────────────────────── shared state ──

struct AppState {
    echowire: Arc<echowire::EchoWireState>,
    obs_broadcast: broadcast::Sender<ObsMessage>,
    obs_client_counter: AtomicU64,
    obs_state: Arc<RwLock<obs::SharedObsState>>,
    obs_cmd_tx: mpsc::Sender<obs::ObsCommand>,
    obs_config_tx: watch::Sender<ObsConfig>,
    log_ring: Mutex<VecDeque<String>>,
    last_sysinfo: Mutex<Option<String>>,
    last_now_playing: Mutex<Option<String>>,
    last_climate: Mutex<Option<String>>,
    lan_ip: String,
    /// Shared secret required to open /obs. The bus is not a read-only feed:
    /// it carries twitch_timeout, twitch_shoutout and cmd_* record/scene
    /// commands that the main page executes with the streamer's moderator
    /// token. Both listeners bind 0.0.0.0 and the QR workflow deliberately
    /// invites household devices onto the network, so an unauthenticated bus
    /// let any of them ban viewers as the streamer.
    bus_token: String,
}

impl AppState {
    fn new(
        lan_ip: String,
    ) -> (
        Self,
        mpsc::Receiver<obs::ObsCommand>,
        watch::Receiver<ObsConfig>,
    ) {
        let (obs_tx, _) = broadcast::channel(OBS_BROADCAST_CAPACITY);
        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (cfg_tx, cfg_rx) = watch::channel(ObsConfig::default());
        let state = Self {
            echowire: echowire::EchoWireState::new(),
            obs_broadcast: obs_tx,
            obs_client_counter: AtomicU64::new(0),
            obs_state: Arc::new(RwLock::new(obs::SharedObsState::default())),
            obs_cmd_tx: cmd_tx,
            obs_config_tx: cfg_tx,
            log_ring: Mutex::new(VecDeque::with_capacity(LOG_RING_SIZE + 1)),
            last_sysinfo: Mutex::new(None),
            last_now_playing: Mutex::new(None),
            last_climate: Mutex::new(None),
            lan_ip,
            bus_token: load_or_create_bus_token(),
        };
        (state, cmd_rx, cfg_rx)
    }

    fn next_client_id(&self) -> u64 {
        self.obs_client_counter.fetch_add(1, Ordering::Relaxed)
    }
}

// ──────────────────────────────────────────────────────── main ──

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,teammater_server=debug")
        .init();

    let lan_ip = tls::detect_lan_ip();
    let lan_ip_str = lan_ip.map(|ip| ip.to_string()).unwrap_or_default();
    let tls_config = tls::load_tls_config(Path::new(CERT_PATH), Path::new(KEY_PATH), lan_ip)?;

    let (state_inner, obs_cmd_rx, obs_cfg_rx) = AppState::new(lan_ip_str.clone());
    let state = Arc::new(state_inner);

    tokio::spawn(echowire::mdns_task(state.echowire.clone()).instrument(info_span!("mdns")));
    // REAL BLE heart rate. fake_hr_task exists in ble.rs for testing without
    // the strap and is NOT spawned — the comments here used to claim the
    // opposite, which would have talked a maintainer into putting synthetic
    // bpm on the live stream.
    tokio::spawn(ble::ble_task(state.obs_broadcast.clone()).instrument(info_span!("ble")));
    tokio::spawn(
        obs::obs_task(
            state.obs_broadcast.clone(),
            obs_cmd_rx,
            state.obs_state.clone(),
            obs_cfg_rx,
        )
        .instrument(info_span!("obs")),
    );
    tokio::spawn({
        let broadcast = state.obs_broadcast.clone();
        let state2 = state.clone();
        async move { sysinfo_task::sysinfo_task(broadcast, &state2.last_sysinfo).await }
            .instrument(info_span!("sysinfo"))
    });
    tokio::spawn({
        let broadcast = state.obs_broadcast.clone();
        let state2 = state.clone();
        async move { zigbee::zigbee_task(broadcast, &state2.last_climate).await }
            .instrument(info_span!("zigbee"))
    });

    let app = Router::new()
        .route("/echowire", get(echowire_handler))
        .route("/obs", get(obs_websocket_handler))
        .route("/api/health", any(|| async { StatusCode::OK }))
        .route("/api/info", get(api_info_handler))
        .route("/api/import/health-app", any(health_app_handler))
        .route_service("/mobile", ServeFile::new("mobile.html"))
        .nest_service(
            "/",
            ServeDir::new(".").append_index_html_on_directories(true),
        )
        // ServeDir::new(".") is the whole project root, and both listeners bind
        // 0.0.0.0 — so without this, `curl http://<lan-ip>:8442/.mcp.json` and
        // `.../server/certs/key.pem` returned the MCP bearer token and the TLS
        // PRIVATE KEY in cleartext to anyone on the network the QR code invites.
        // Verified by request against the running server, not by inspection.
        .layer(axum::middleware::from_fn(deny_sensitive_paths))
        .with_state(state);

    info!("🚀 HTTPS listening on https://{HTTPS_ADDR}");
    info!("🌐 HTTP  listening on http://{HTTP_ADDR}");
    if !lan_ip_str.is_empty() {
        info!("📱 Mobile URL: https://{}:8443/mobile", lan_ip_str);
    }

    // with_connect_info on BOTH listeners: api_info_handler hands out the bus
    // token only to loopback callers, which it cannot decide without the peer
    // address.
    let http_app = app.clone();
    let http_listener = tokio::net::TcpListener::bind(HTTP_ADDR).await?;
    tokio::spawn(async move {
        if let Err(e) = axum::serve(
            http_listener,
            http_app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            error!("🌐 HTTP server error: {e}");
        }
    });

    axum_server::bind_rustls(
        HTTPS_ADDR,
        axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls_config)),
    )
    .serve(app.into_make_service_with_connect_info::<SocketAddr>())
    .await?;

    Ok(())
}

// ──────────────────────────────────────────────── API handlers ──

/// Public info for any caller; the bus token ONLY for loopback.
///
/// Pages served to localhost (index.html, obs.html, and the UserScript talking
/// to localhost:8443) can therefore fetch the token directly. Remote devices
/// cannot — the phone gets it from the QR URL fragment instead, which is why
/// index.html builds that URL with `#token=` appended.
async fn api_info_handler(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut body = serde_json::json!({ "lan_ip": state.lan_ip, "port": 8443 });
    if peer.ip().is_loopback() {
        body["bus_token"] = serde_json::Value::String(state.bus_token.clone());
    }
    Json(body)
}

async fn health_app_handler(req: Request) -> StatusCode {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req
        .headers()
        .iter()
        .map(|(k, v)| format!("{k}: {}", v.to_str().unwrap_or("<binary>")))
        .collect::<Vec<_>>()
        .join(", ");
    let body = to_bytes(req.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
    let body = String::from_utf8_lossy(&body);
    info!(
        "🏥 health-app {method} {uri} | headers=[{headers}] | body={}",
        if body.is_empty() { "<empty>" } else { &body }
    );
    StatusCode::OK
}

// ──────────────────────────────────────────── /echowire proxy ──

async fn echowire_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    echowire::upgrade(ws, &state.echowire).await
}

// ──────────────────────────────────────────────── /obs bus WS ──

async fn obs_websocket_handler(
    ws: WebSocketUpgrade,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
    State(state): State<Arc<AppState>>,
) -> Response {
    // Reject before the upgrade: an authenticated-looking socket that is then
    // ignored is worse than a refused one.
    if q.get("token").map(String::as_str) != Some(state.bus_token.as_str()) {
        warn!("🔒 Rejected /obs connection with missing or wrong token");
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let client_id = state.next_client_id();
    ws.on_upgrade(move |socket| {
        handle_obs_client(socket, state, client_id)
            .instrument(info_span!("obs_client", id = client_id))
    })
}

type WsSink = futures_util::stream::SplitSink<WebSocket, Message>;

/// Send initial burst of state to a newly-connected client.
/// Returns false if the client disconnected mid-send.
async fn send_welcome(tx: &mut WsSink, state: &AppState) -> bool {
    let backlog: Vec<String> = state.log_ring.lock().unwrap().iter().cloned().collect();
    for line in backlog {
        if tx.send(Message::Text(line)).await.is_err() {
            return false;
        }
    }
    let snapshot = state.obs_state.read().await.to_state_json();
    if tx.send(Message::Text(snapshot)).await.is_err() {
        return false;
    }
    // Collect before any await — std::MutexGuard must not cross await points
    let cached: Vec<String> = [
        state.last_sysinfo.lock().unwrap().clone(),
        state.last_now_playing.lock().unwrap().clone(),
        state.last_climate.lock().unwrap().clone(),
    ]
    .into_iter()
    .flatten()
    .collect();
    for msg in cached {
        if tx.send(Message::Text(msg)).await.is_err() {
            return false;
        }
    }
    true
}

async fn handle_obs_client(socket: WebSocket, state: Arc<AppState>, client_id: u64) {
    let (mut tx, mut rx) = socket.split();
    info!("📺 Client {client_id} connected");

    if !send_welcome(&mut tx, &state).await {
        info!("📺 Client {client_id} disconnected during welcome");
        return;
    }

    let mut broadcast_rx = state.obs_broadcast.subscribe();
    let obs_cmd_tx = state.obs_cmd_tx.clone();
    let obs_bcast = state.obs_broadcast.clone();
    let state_recv = state.clone();

    let send_task = async move {
        loop {
            // Lagged is NOT terminal. `while let Ok(..)` treated it as such, so
            // a client that stalled past the 16-slot buffer went permanently
            // deaf with its socket still open — while server/SPEC.md promises
            // "lagged receivers drop silently". Skip the dropped messages and
            // keep serving; only Closed ends the task.
            let msg = match broadcast_rx.recv().await {
                Ok(msg) => msg,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("📡 Client {} lagged, dropped {} message(s)", client_id, n);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if msg.sender_id != client_id && tx.send(Message::Text(msg.text)).await.is_err() {
                break;
            }
        }
    };
    let recv_task = async move {
        while let Some(Ok(msg)) = rx.next().await {
            match msg {
                Message::Text(text) => {
                    route_incoming(text, client_id, &obs_cmd_tx, &obs_bcast, &state_recv).await
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! { () = send_task => {}, () = recv_task => {} }
    info!("📺 Client {client_id} disconnected");
}

// ──────────────────────────────────────── incoming message router ──

async fn route_incoming(
    text: String,
    client_id: u64,
    obs_cmd_tx: &mpsc::Sender<obs::ObsCommand>,
    obs_broadcast: &broadcast::Sender<ObsMessage>,
    state: &Arc<AppState>,
) {
    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            let _ = obs_broadcast.send(ObsMessage {
                sender_id: client_id,
                text,
            });
            return;
        }
    };

    match v["type"].as_str().unwrap_or("") {
        "obs_config" => {
            let url = v["url"].as_str().unwrap_or_default().to_string();
            let password = v["password"].as_str().unwrap_or_default().to_string();
            if !url.is_empty() {
                info!("🎬 OBS config: {url}");
                let _ = state.obs_config_tx.send(ObsConfig { url, password });
            }
        }
        t if t.starts_with("cmd_") => {
            if let Some(cmd) = parse_obs_cmd(t, &v) {
                let _ = obs_cmd_tx.send(cmd).await;
            }
        }
        "log" => {
            {
                let mut ring = state.log_ring.lock().unwrap();
                if ring.len() >= LOG_RING_SIZE {
                    ring.pop_front();
                }
                ring.push_back(text.clone());
            }
            let _ = obs_broadcast.send(ObsMessage {
                sender_id: client_id,
                text,
            });
        }
        "now_playing" => {
            // Cache EVERY now_playing, cover or not. Caching only cover-bearing
            // messages meant a coverless track left the previous track cached,
            // and a reconnecting client was confidently shown the wrong song —
            // stale data is worse than a missing cover, and the live reply path
            // gated on cover too, so nothing ever corrected it.
            *state.last_now_playing.lock().unwrap() = Some(text.clone());
            let _ = obs_broadcast.send(ObsMessage {
                sender_id: client_id,
                text,
            });
        }
        _ => {
            let _ = obs_broadcast.send(ObsMessage {
                sender_id: client_id,
                text,
            });
        }
    }
}

fn parse_obs_cmd(msg_type: &str, v: &Value) -> Option<obs::ObsCommand> {
    match msg_type {
        "cmd_switch_scene" => Some(obs::ObsCommand::SwitchScene(
            v["scene"].as_str()?.to_string(),
        )),
        "cmd_start_record" => Some(obs::ObsCommand::StartRecord),
        "cmd_stop_record" => Some(obs::ObsCommand::StopRecord),
        "cmd_pause_record" => Some(obs::ObsCommand::PauseRecord),
        "cmd_resume_record" => Some(obs::ObsCommand::ResumeRecord),
        _ => None,
    }
}
