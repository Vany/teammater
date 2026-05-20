use anyhow::{anyhow, Context, Result};
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
use mdns_sd::{ServiceDaemon, ServiceEvent};
use obs::SharedObsState;
use rustls::ServerConfig;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, watch, RwLock};
use obs::ObsConfig;
use tokio_tungstenite::{
    connect_async, tungstenite::Message as TungsteniteMessage, MaybeTlsStream, WebSocketStream,
};
use tower_http::{services::{ServeDir, ServeFile}, trace::TraceLayer};
use tracing::Span;
use tracing::{error, info, info_span, warn, Instrument};

mod ble;
mod obs;
mod sysinfo_task;
mod tls;

// ──────────────────────────────────────────────────────── configuration ──

const LISTEN_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8443);
const HTTP_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8442);
const CERT_PATH: &str = "server/certs/cert.pem";
const KEY_PATH: &str = "server/certs/key.pem";
const MDNS_RETRY_DELAY: Duration = Duration::from_secs(5);
const OBS_BROADCAST_CAPACITY: usize = 16;
const LOG_RING_SIZE: usize = 5;
const SERVICE_TYPE: &str = "_echowire._tcp.local.";

// ──────────────────────────────────────────────────────── shared types ──

#[derive(Debug, Clone, PartialEq, Eq)]
struct EchoWireService {
    name: String,
    host: String,
    port: u16,
    addresses: Vec<IpAddr>,
}

impl EchoWireService {
    fn ws_url(&self) -> Option<String> {
        let addr = self.addresses.iter().find(|a| a.is_ipv4()).or(self.addresses.first())?;
        Some(match addr {
            IpAddr::V4(v4) => format!("ws://{}:{}/", v4, self.port),
            IpAddr::V6(v6) => format!("ws://[{}]:{}/", v6, self.port),
        })
    }
}

/// Broadcast envelope. sender_id == u64::MAX = system message → all clients.
#[derive(Clone, Debug)]
pub struct ObsMessage {
    pub sender_id: u64,
    pub text: String,
}

struct AppState {
    echowire_service: RwLock<Option<EchoWireService>>,
    echowire_generation: watch::Sender<u64>,
    obs_broadcast: broadcast::Sender<ObsMessage>,
    obs_client_counter: AtomicU64,
    obs_state: Arc<RwLock<SharedObsState>>,
    obs_cmd_tx: mpsc::Sender<obs::ObsCommand>,
    /// Sends new OBS connection config to the obs task (url + password from browser)
    obs_config_tx: watch::Sender<ObsConfig>,
    /// Ring buffer of the last LOG_RING_SIZE log JSON strings for late joiners
    log_ring: Mutex<VecDeque<String>>,
    /// Last sysinfo JSON — sent immediately to new clients
    last_sysinfo: Mutex<Option<String>>,
    lan_ip: String,
}

impl AppState {
    fn new(lan_ip: String) -> (Self, mpsc::Receiver<obs::ObsCommand>, watch::Receiver<ObsConfig>) {
        let (obs_tx, _) = broadcast::channel(OBS_BROADCAST_CAPACITY);
        let (gen_tx, _) = watch::channel(0u64);
        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (cfg_tx, cfg_rx) = watch::channel(ObsConfig::default());

        let state = Self {
            echowire_service: RwLock::new(None),
            echowire_generation: gen_tx,
            obs_broadcast: obs_tx,
            obs_client_counter: AtomicU64::new(0),
            obs_state: Arc::new(RwLock::new(SharedObsState::default())),
            obs_cmd_tx: cmd_tx,
            obs_config_tx: cfg_tx,
            log_ring: Mutex::new(VecDeque::with_capacity(LOG_RING_SIZE + 1)),
            last_sysinfo: Mutex::new(None),
            lan_ip,
        };
        (state, cmd_rx, cfg_rx)
    }

    fn next_client_id(&self) -> u64 {
        self.obs_client_counter.fetch_add(1, Ordering::Relaxed)
    }
}

// ─────────────────────────────────────────────────────────────── main ──

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,teammater_server=debug")
        .init();

    let lan_ip = tls::detect_lan_ip();
    let lan_ip_str = lan_ip.map(|ip| ip.to_string()).unwrap_or_default();

    let tls_config = load_tls_config(Path::new(CERT_PATH), Path::new(KEY_PATH), lan_ip)?;

    let (state_inner, obs_cmd_rx, obs_cfg_rx) = AppState::new(lan_ip_str.clone());
    let obs_broadcast = state_inner.obs_broadcast.clone();
    let obs_state = state_inner.obs_state.clone();
    let state = Arc::new(state_inner);

    tokio::spawn(mdns_discovery_task(state.clone()).instrument(info_span!("mdns")));
    tokio::spawn(ble::ble_task(obs_broadcast.clone()).instrument(info_span!("ble")));
    tokio::spawn(obs::obs_task(obs_broadcast, obs_cmd_rx, obs_state, obs_cfg_rx).instrument(info_span!("obs")));
    {
        let broadcast = state.obs_broadcast.clone();
        let last = state.last_sysinfo.lock().unwrap(); // ensure field exists, then drop
        drop(last);
        let state2 = state.clone();
        tokio::spawn(async move {
            sysinfo_task::sysinfo_task(broadcast, &state2.last_sysinfo).await;
        }.instrument(info_span!("sysinfo")));
    }

    let app = Router::new()
        .route("/echowire", get(websocket_proxy_handler))
        .route("/obs", get(obs_websocket_handler))
        .route("/api/health", any(|| async { StatusCode::OK }))
        .route("/api/info", get(api_info_handler))
        .route("/api/import/health-app", any(health_app_handler))
        .route_service("/mobile", ServeFile::new("mobile.html"))
        .nest_service("/", ServeDir::new(".").append_index_html_on_directories(true))
        .layer(TraceLayer::new_for_http().on_request(
            |req: &axum::http::Request<_>, _: &Span| {
                info!("→ {} {}", req.method(), req.uri());
            },
        ))
        .with_state(state);

    info!("🚀 HTTPS listening on https://{}", LISTEN_ADDR);
    info!("🌐 HTTP  listening on http://{}", HTTP_ADDR);
    if !lan_ip_str.is_empty() {
        info!("📱 Mobile URL: https://{}:8443/mobile", lan_ip_str);
    }

    let http_app = app.clone();
    let http_listener = tokio::net::TcpListener::bind(HTTP_ADDR).await?;
    tokio::spawn(async move {
        if let Err(e) = axum::serve(http_listener, http_app).await {
            error!("🌐 HTTP server fatal error: {e}");
        }
    });

    axum_server::bind_rustls(
        LISTEN_ADDR,
        axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls_config)),
    )
    .serve(app.into_make_service())
    .await?;

    Ok(())
}

fn load_tls_config(cert_path: &Path, key_path: &Path, lan_ip: Option<IpAddr>) -> Result<ServerConfig> {
    tls::ensure_cert_exists(cert_path, key_path, lan_ip)?;

    let cert_pem = fs::read(cert_path).context("Failed to read certificate")?;
    let key_pem = fs::read(key_path).context("Failed to read private key")?;

    let certs = rustls_pemfile::certs(&mut &cert_pem[..])
        .collect::<Result<Vec<_>, _>>()
        .context("Failed to parse certificates")?;

    let key = rustls_pemfile::private_key(&mut &key_pem[..])?
        .ok_or_else(|| anyhow!("No private key found in {}", key_path.display()))?;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("Failed to configure TLS")?;

    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

// ───────────────────────────────────────────────────────── API handlers ──

async fn api_info_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "lan_ip": state.lan_ip,
        "port": 8443,
    }))
}

async fn health_app_handler(req: Request) -> StatusCode {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers: Vec<String> = req
        .headers()
        .iter()
        .map(|(k, v)| format!("{}: {}", k, v.to_str().unwrap_or("<binary>")))
        .collect();
    let body = to_bytes(req.into_body(), usize::MAX).await.unwrap_or_default();
    let body_str = String::from_utf8_lossy(&body);
    info!(
        "🏥 health-app {} {} | headers=[{}] | body={}",
        method,
        uri,
        headers.join(", "),
        if body_str.is_empty() { "<empty>" } else { &body_str }
    );
    StatusCode::OK
}

// ─────────────────────────────────────────────────────────── /obs bus ──

async fn obs_websocket_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    let client_id = state.next_client_id();
    ws.on_upgrade(move |socket| {
        handle_obs_websocket(socket, state, client_id).instrument(info_span!("obs_client", id = client_id))
    })
}

async fn handle_obs_websocket(socket: WebSocket, state: Arc<AppState>, client_id: u64) {
    let (mut tx, mut rx) = socket.split();
    info!("📺 Client {} connected", client_id);

    // Send log ring buffer, OBS state snapshot, and last sysinfo to new client
    let backlog: Vec<String> = state.log_ring.lock().unwrap().iter().cloned().collect();
    for line in backlog {
        if tx.send(Message::Text(line)).await.is_err() {
            return;
        }
    }
    let snapshot = state.obs_state.read().await.to_state_json();
    if tx.send(Message::Text(snapshot)).await.is_err() {
        return;
    }
    let last_sysinfo = state.last_sysinfo.lock().unwrap().clone();
    if let Some(sysinfo) = last_sysinfo {
        if tx.send(Message::Text(sysinfo)).await.is_err() {
            return;
        }
    }

    let mut broadcast_rx = state.obs_broadcast.subscribe();
    let obs_cmd_tx = state.obs_cmd_tx.clone();
    let obs_broadcast = state.obs_broadcast.clone();
    let state_recv = state.clone();

    let send_task = async move {
        while let Ok(msg) = broadcast_rx.recv().await {
            if msg.sender_id != client_id && tx.send(Message::Text(msg.text)).await.is_err() {
                break;
            }
        }
    };

    let recv_task = async move {
        while let Some(Ok(msg)) = rx.next().await {
            match msg {
                Message::Text(text) => {
                    route_incoming(text, client_id, &obs_cmd_tx, &obs_broadcast, &state_recv).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        () = send_task => {}
        () = recv_task => {}
    }

    info!("📺 Client {} disconnected", client_id);
}

async fn route_incoming(
    text: String,
    client_id: u64,
    obs_cmd_tx: &mpsc::Sender<obs::ObsCommand>,
    obs_broadcast: &broadcast::Sender<ObsMessage>,
    state: &Arc<AppState>,
) {
    let msg_type = if let Ok(v) = serde_json::from_str::<Value>(&text) {
        v["type"].as_str().unwrap_or_default().to_string()
    } else {
        // Non-JSON: relay as-is
        let _ = obs_broadcast.send(ObsMessage { sender_id: client_id, text });
        return;
    };

    if msg_type == "obs_config" {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            let url = v["url"].as_str().unwrap_or_default().to_string();
            let password = v["password"].as_str().unwrap_or_default().to_string();
            if !url.is_empty() {
                info!("🎬 OBS config from browser: {url}");
                let _ = state.obs_config_tx.send(ObsConfig { url, password });
            }
        }
        // not relayed to other clients
    } else if msg_type.starts_with("cmd_") {
        if let Some(cmd) = parse_obs_cmd(&msg_type, &text) {
            let _ = obs_cmd_tx.send(cmd).await;
        }
        // commands are NOT relayed to other clients
    } else if msg_type == "log" {
        // Add to ring buffer and relay
        {
            let mut ring = state.log_ring.lock().unwrap();
            if ring.len() >= LOG_RING_SIZE {
                ring.pop_front();
            }
            ring.push_back(text.clone());
        }
        let _ = obs_broadcast.send(ObsMessage { sender_id: client_id, text });
    } else {
        // viewer_count, heartrate, etc. — relay to all other clients
        let _ = obs_broadcast.send(ObsMessage { sender_id: client_id, text });
    }
}

fn parse_obs_cmd(msg_type: &str, text: &str) -> Option<obs::ObsCommand> {
    match msg_type {
        "cmd_switch_scene" => {
            let v: Value = serde_json::from_str(text).ok()?;
            Some(obs::ObsCommand::SwitchScene(v["scene"].as_str()?.to_string()))
        }
        "cmd_start_record" => Some(obs::ObsCommand::StartRecord),
        "cmd_stop_record" => Some(obs::ObsCommand::StopRecord),
        "cmd_pause_record" => Some(obs::ObsCommand::PauseRecord),
        "cmd_resume_record" => Some(obs::ObsCommand::ResumeRecord),
        _ => None,
    }
}

// ──────────────────────────────────────────────────── /echowire proxy ──

async fn websocket_proxy_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    let mut generation_rx = state.echowire_generation.subscribe();

    let backend_url = {
        let service = state.echowire_service.read().await;
        match service.as_ref().and_then(EchoWireService::ws_url) {
            Some(url) => url,
            None => {
                error!("❌ No EchoWire service available");
                return (StatusCode::SERVICE_UNAVAILABLE, "No EchoWire service discovered")
                    .into_response();
            }
        }
    };

    let generation = *generation_rx.borrow_and_update();

    ws.on_upgrade(move |socket| {
        handle_websocket_proxy(socket, backend_url, generation, generation_rx)
            .instrument(info_span!("echowire_proxy"))
    })
}

async fn handle_websocket_proxy(
    client_ws: WebSocket,
    backend_url: String,
    initial_generation: u64,
    mut generation_rx: watch::Receiver<u64>,
) {
    info!("📥 EchoWire client connected");

    if *generation_rx.borrow() != initial_generation {
        warn!("🔄 Backend changed before connection established, rejecting");
        return;
    }

    let Ok(backend_ws) = connect_to_backend(&backend_url).await else {
        error!("❌ Failed to connect to backend: {}", backend_url);
        return;
    };
    info!("✅ Connected to backend: {}", backend_url);

    let (mut client_tx, mut client_rx) = client_ws.split();
    let (mut backend_tx, mut backend_rx) = backend_ws.split();

    let client_to_backend = async {
        while let Some(result) = client_rx.next().await {
            let Ok(msg) = result else { break };
            let Some(m) = to_backend(msg) else { break };
            if backend_tx.send(m).await.is_err() { break }
        }
    };

    let backend_to_client = async {
        while let Some(result) = backend_rx.next().await {
            let Ok(msg) = result else { break };
            let Some(m) = to_client(msg) else { break };
            if client_tx.send(m).await.is_err() { break }
        }
    };

    let generation_watch = async {
        loop {
            if generation_rx.changed().await.is_err() { break }
            if *generation_rx.borrow() != initial_generation {
                warn!("🔄 Backend changed, dropping EchoWire connection");
                break;
            }
        }
    };

    tokio::select! {
        _ = client_to_backend => {}
        _ = backend_to_client => {}
        _ = generation_watch => {}
    }
}

async fn connect_to_backend(url: &str) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let (ws, _) = connect_async(url).await?;
    Ok(ws)
}

fn to_backend(msg: Message) -> Option<TungsteniteMessage> {
    match msg {
        Message::Text(t) => Some(TungsteniteMessage::Text(t)),
        Message::Binary(b) => Some(TungsteniteMessage::Binary(b)),
        Message::Ping(d) => Some(TungsteniteMessage::Ping(d)),
        Message::Pong(d) => Some(TungsteniteMessage::Pong(d)),
        Message::Close(_) => None,
    }
}

fn to_client(msg: TungsteniteMessage) -> Option<Message> {
    match msg {
        TungsteniteMessage::Text(t) => Some(Message::Text(t)),
        TungsteniteMessage::Binary(b) => Some(Message::Binary(b)),
        TungsteniteMessage::Ping(d) => Some(Message::Ping(d)),
        TungsteniteMessage::Pong(d) => Some(Message::Pong(d)),
        TungsteniteMessage::Close(_) | TungsteniteMessage::Frame(_) => None,
    }
}

// ─────────────────────────────────────────────────── mDNS discovery ──

async fn mdns_discovery_task(state: Arc<AppState>) {
    let mut generation: u64 = 0;
    loop {
        info!("🔍 Starting mDNS discovery...");

        let Ok(mdns) = ServiceDaemon::new() else {
            error!("❌ Failed to create mDNS daemon");
            tokio::time::sleep(MDNS_RETRY_DELAY).await;
            continue;
        };

        let Ok(receiver) = mdns.browse(SERVICE_TYPE) else {
            error!("❌ Failed to browse mDNS");
            let _ = mdns.shutdown();
            tokio::time::sleep(MDNS_RETRY_DELAY).await;
            continue;
        };

        loop {
            let event = match receiver.recv_async().await {
                Ok(e) => e,
                Err(e) => { error!("❌ mDNS receive error: {e}"); break; }
            };

            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let addresses: Vec<IpAddr> = info.get_addresses().iter().copied().collect();
                    if addresses.is_empty() { continue; }

                    let new_service = EchoWireService {
                        name: info.get_fullname().to_string(),
                        host: info.get_hostname().to_string(),
                        port: info.get_port(),
                        addresses,
                    };

                    let mut current = state.echowire_service.write().await;
                    if current.as_ref() == Some(&new_service) { continue; }

                    info!("✅ EchoWire: {} at {}:{}", new_service.name, new_service.host, new_service.port);
                    if let Some(url) = new_service.ws_url() { info!("🔌 WS: {url}"); }

                    *current = Some(new_service);
                    drop(current);

                    generation += 1;
                    let _ = state.echowire_generation.send(generation);
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    let mut current = state.echowire_service.write().await;
                    if current.as_ref().map(|s| &s.name) != Some(&fullname) { continue; }

                    warn!("⚠️ EchoWire removed: {fullname}");
                    *current = None;
                    drop(current);

                    generation += 1;
                    let _ = state.echowire_generation.send(generation);
                }
                _ => {}
            }
        }

        let _ = mdns.stop_browse(SERVICE_TYPE);
        let _ = mdns.shutdown();
        warn!("🔄 mDNS lost, retrying in {MDNS_RETRY_DELAY:?}...");
        tokio::time::sleep(MDNS_RETRY_DELAY).await;
    }
}
