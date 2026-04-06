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
    Router,
};
use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use rustls::ServerConfig;
use std::{
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch, RwLock};
use tokio_tungstenite::{
    connect_async, tungstenite::Message as TungsteniteMessage, MaybeTlsStream, WebSocketStream,
};
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::Span;
use tracing::{error, info, info_span, warn, Instrument};

mod ble;
mod tls;

// Configuration constants
const LISTEN_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8443);
const HTTP_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8442);
const CERT_PATH: &str = "server/certs/cert.pem";
const KEY_PATH: &str = "server/certs/key.pem";
const MDNS_RETRY_DELAY: Duration = Duration::from_secs(5);
const OBS_BROADCAST_CAPACITY: usize = 8;
const SERVICE_TYPE: &str = "_echowire._tcp.local.";

#[derive(Debug, Clone, PartialEq, Eq)]
struct EchoWireService {
    name: String,
    host: String,
    port: u16,
    addresses: Vec<IpAddr>,
}

impl EchoWireService {
    #[must_use]
    fn ws_url(&self) -> Option<String> {
        let addr = self
            .addresses
            .iter()
            .find(|a| a.is_ipv4())
            .or(self.addresses.first())?;

        Some(match addr {
            IpAddr::V4(v4) => format!("ws://{}:{}/", v4, self.port),
            IpAddr::V6(v6) => format!("ws://[{}]:{}/", v6, self.port),
        })
    }
}

/// Convert axum Message to tungstenite, returns None for Close
fn to_backend(msg: Message) -> Option<TungsteniteMessage> {
    match msg {
        Message::Text(t) => Some(TungsteniteMessage::Text(t)),
        Message::Binary(b) => Some(TungsteniteMessage::Binary(b)),
        Message::Ping(d) => Some(TungsteniteMessage::Ping(d)),
        Message::Pong(d) => Some(TungsteniteMessage::Pong(d)),
        Message::Close(_) => None,
    }
}

/// Convert tungstenite Message to axum, returns None for Close/Frame
fn to_client(msg: TungsteniteMessage) -> Option<Message> {
    match msg {
        TungsteniteMessage::Text(t) => Some(Message::Text(t)),
        TungsteniteMessage::Binary(b) => Some(Message::Binary(b)),
        TungsteniteMessage::Ping(d) => Some(Message::Ping(d)),
        TungsteniteMessage::Pong(d) => Some(Message::Pong(d)),
        TungsteniteMessage::Close(_) | TungsteniteMessage::Frame(_) => None,
    }
}

/// Message with sender ID for broadcast filtering.
/// sender_id == u64::MAX means system/BLE — all clients receive it.
#[derive(Clone, Debug)]
pub struct ObsMessage {
    pub sender_id: u64,
    pub text: String,
}

struct AppState {
    echowire_service: RwLock<Option<EchoWireService>>,
    /// Notifies connections when backend changes (they should disconnect)
    echowire_generation: watch::Sender<u64>,
    obs_broadcast: broadcast::Sender<ObsMessage>,
    obs_client_counter: AtomicU64,
}

impl AppState {
    fn new() -> Self {
        let (obs_tx, _) = broadcast::channel(OBS_BROADCAST_CAPACITY);
        let (generation_tx, _) = watch::channel(0u64);

        Self {
            echowire_service: RwLock::new(None),
            echowire_generation: generation_tx,
            obs_broadcast: obs_tx,
            obs_client_counter: AtomicU64::new(0),
        }
    }

    fn next_client_id(&self) -> u64 {
        self.obs_client_counter.fetch_add(1, Ordering::Relaxed)
    }
}

fn load_tls_config(cert_path: &Path, key_path: &Path) -> Result<ServerConfig> {
    tls::ensure_cert_exists(cert_path, key_path)?;

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

    // Force HTTP/1.1 for WebSocket compatibility
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(config)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,teammater_server=debug")
        .init();

    let state = Arc::new(AppState::new());

    // Start mDNS discovery background task
    tokio::spawn(mdns_discovery_task(state.clone()).instrument(info_span!("mdns")));

    // Start BLE heart rate monitor
    tokio::spawn(ble::ble_task(state.obs_broadcast.clone()).instrument(info_span!("ble")));

    let tls_config = load_tls_config(Path::new(CERT_PATH), Path::new(KEY_PATH))?;

    let app = Router::new()
        .route("/echowire", get(websocket_proxy_handler))
        .route("/obs", get(obs_websocket_handler))
        .route("/api/health", any(|| async { StatusCode::OK }))
        .route("/api/import/health-app", any(health_app_handler))
        .nest_service(
            "/",
            ServeDir::new(".").append_index_html_on_directories(true),
        )
        .layer(
            TraceLayer::new_for_http().on_request(
                |req: &axum::http::Request<_>, _: &Span| {
                    info!("→ {} {}", req.method(), req.uri());
                },
            ),
        )
        .with_state(state);

    info!("🚀 HTTPS listening on https://{}", LISTEN_ADDR);
    info!("🌐 HTTP  listening on http://{}", HTTP_ADDR);
    info!("📁 Serving static files from current directory");

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

/// Background task: continuously monitor mDNS for EchoWire service
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

        // Process mDNS events
        loop {
            let event = match receiver.recv_async().await {
                Ok(e) => e,
                Err(e) => {
                    error!("❌ mDNS receive error: {e}");
                    break;
                }
            };

            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let addresses: Vec<IpAddr> = info.get_addresses().iter().copied().collect();
                    if addresses.is_empty() {
                        continue;
                    }

                    let new_service = EchoWireService {
                        name: info.get_fullname().to_string(),
                        host: info.get_hostname().to_string(),
                        port: info.get_port(),
                        addresses,
                    };

                    let mut current = state.echowire_service.write().await;
                    if current.as_ref() == Some(&new_service) {
                        continue;
                    }

                    info!(
                        "✅ EchoWire: {} at {}:{}",
                        new_service.name, new_service.host, new_service.port
                    );
                    if let Some(url) = new_service.ws_url() {
                        info!("🔌 WebSocket: {url}");
                    }

                    *current = Some(new_service);
                    drop(current);

                    generation += 1;
                    let _ = state.echowire_generation.send(generation);
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    let mut current = state.echowire_service.write().await;
                    if current.as_ref().map(|s| &s.name) != Some(&fullname) {
                        continue;
                    }

                    warn!("⚠️ EchoWire removed: {fullname}");
                    *current = None;
                    drop(current);

                    generation += 1;
                    let _ = state.echowire_generation.send(generation);
                }
                _ => {}
            }
        }

        // Cleanup and retry
        let _ = mdns.stop_browse(SERVICE_TYPE);
        let _ = mdns.shutdown();

        warn!("🔄 mDNS lost, retrying in {MDNS_RETRY_DELAY:?}...");
        tokio::time::sleep(MDNS_RETRY_DELAY).await;
    }
}

async fn websocket_proxy_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    // Subscribe to generation watch BEFORE reading the service, so we cannot
    // miss a backend change that occurs between url extraction and connection.
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

    // Snapshot generation while receiver is already live — consistent with backend_url.
    let generation = *generation_rx.borrow_and_update();

    ws.on_upgrade(move |socket| {
        handle_websocket_proxy(socket, state, backend_url, generation, generation_rx)
            .instrument(info_span!("echowire_proxy"))
    })
}

async fn handle_websocket_proxy(
    client_ws: WebSocket,
    _state: Arc<AppState>,
    backend_url: String,
    initial_generation: u64,
    mut generation_rx: watch::Receiver<u64>,
) {
    info!("📥 Client connected");

    // Sanity check: reject if backend changed while the upgrade was in flight.
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
            let Ok(msg) = result else {
                warn!("⚠️ Client read error");
                break;
            };
            let Some(tung_msg) = to_backend(msg) else {
                break;
            };
            if backend_tx.send(tung_msg).await.is_err() {
                break;
            }
        }
    };

    let backend_to_client = async {
        while let Some(result) = backend_rx.next().await {
            let Ok(msg) = result else {
                warn!("⚠️ Backend read error");
                break;
            };
            let Some(axum_msg) = to_client(msg) else {
                break;
            };
            if client_tx.send(axum_msg).await.is_err() {
                break;
            }
        }
    };

    // Drop connection when backend address changes.
    let generation_watch = async {
        loop {
            if generation_rx.changed().await.is_err() {
                break;
            }
            if *generation_rx.borrow() != initial_generation {
                warn!("🔄 Backend changed, dropping connection");
                break;
            }
        }
    };

    tokio::select! {
        _ = client_to_backend => {
            info!("📤 Client->Backend stream closed");
        }
        _ = backend_to_client => {
            info!("📥 Backend->Client stream closed");
        }
        _ = generation_watch => {
            info!("🔄 Connection dropped due to backend change");
        }
    }

    info!("🔌 WebSocket proxy session ended");
}

async fn connect_to_backend(url: &str) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let (ws_stream, _) = connect_async(url).await?;
    Ok(ws_stream)
}

// --- /obs broadcast WebSocket ---

async fn obs_websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    let client_id = state.next_client_id();
    ws.on_upgrade(move |socket| {
        handle_obs_websocket(socket, state, client_id).instrument(info_span!("obs", id = client_id))
    })
}

async fn handle_obs_websocket(socket: WebSocket, state: Arc<AppState>, client_id: u64) {
    let (mut tx, mut rx) = socket.split();
    let mut broadcast_rx = state.obs_broadcast.subscribe();

    info!("📺 Connected");

    let send_task = async {
        while let Ok(msg) = broadcast_rx.recv().await {
            if msg.sender_id != client_id && tx.send(Message::Text(msg.text)).await.is_err() {
                break;
            }
        }
    };

    let broadcast_tx = state.obs_broadcast.clone();
    let recv_task = async {
        while let Some(Ok(msg)) = rx.next().await {
            match msg {
                Message::Text(text) => {
                    let _ = broadcast_tx.send(ObsMessage {
                        sender_id: client_id,
                        text,
                    });
                }
                Message::Binary(_) => warn!("⚠️ Binary message ignored"),
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        () = send_task => {}
        () = recv_task => {}
    }

    info!("📺 OBS client {} disconnected", client_id);
}

async fn health_app_handler(req: Request) -> StatusCode {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers: Vec<String> = req
        .headers()
        .iter()
        .map(|(k, v)| format!("{}: {}", k, v.to_str().unwrap_or("<binary>")))
        .collect();
    let body = to_bytes(req.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
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
