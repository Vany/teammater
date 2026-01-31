use anyhow::{Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use rustls::ServerConfig;
use std::{fs, net::IpAddr, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch, RwLock};
use tokio_tungstenite::{
    connect_async, tungstenite::Message as TungsteniteMessage, MaybeTlsStream, WebSocketStream,
};
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{error, info, warn};

mod tls;

const SERVICE_TYPE: &str = "_echowire._tcp.local.";

#[derive(Debug, Clone, PartialEq)]
struct EchoWireService {
    name: String,
    host: String,
    port: u16,
    addresses: Vec<IpAddr>,
}

impl EchoWireService {
    fn ws_url(&self) -> Option<String> {
        let addr = self
            .addresses
            .iter()
            .find(|a| matches!(a, IpAddr::V4(_)))
            .or_else(|| self.addresses.first())?;

        let addr_str = match addr {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => format!("[{}]", v6),
        };

        Some(format!("ws://{}:{}/", addr_str, self.port))
    }
}

/// Message with sender ID for broadcast filtering
#[derive(Clone)]
struct ObsMessage {
    sender_id: u64,
    text: String,
}

struct AppState {
    echowire_service: RwLock<Option<EchoWireService>>,
    /// Notifies connections when backend changes (they should disconnect)
    echowire_generation: watch::Sender<u64>,
    obs_broadcast: broadcast::Sender<ObsMessage>,
    obs_client_counter: std::sync::atomic::AtomicU64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,teammater_server=debug")
        .init();

    // Broadcast channel for /obs WebSocket
    let (obs_tx, _) = broadcast::channel(256);

    // Watch channel to notify connections of backend changes
    let (generation_tx, _) = watch::channel(0u64);

    let state = Arc::new(AppState {
        echowire_service: RwLock::new(None),
        echowire_generation: generation_tx,
        obs_broadcast: obs_tx,
        obs_client_counter: std::sync::atomic::AtomicU64::new(0),
    });

    // Start mDNS discovery background task
    let mdns_state = state.clone();
    tokio::spawn(async move {
        mdns_discovery_task(mdns_state).await;
    });

    let cert_path = PathBuf::from("server/certs/cert.pem");
    let key_path = PathBuf::from("server/certs/key.pem");

    tls::ensure_cert_exists(&cert_path, &key_path)?;

    let cert_pem = fs::read(&cert_path)?;
    let key_pem = fs::read(&key_path)?;

    let certs = rustls_pemfile::certs(&mut &cert_pem[..]).collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut &key_pem[..])?
        .ok_or_else(|| anyhow::anyhow!("No private key found"))?;

    let mut tls_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    tls_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    let app = Router::new()
        .route("/echowire", get(websocket_proxy_handler))
        .route("/obs", get(obs_websocket_handler))
        .nest_service(
            "/",
            ServeDir::new(".").append_index_html_on_directories(true),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8443));
    info!("🚀 Server listening on https://{}", addr);
    info!("📁 Serving static files from current directory");

    axum_server::bind_rustls(
        addr,
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
        info!("🔍 Starting mDNS discovery for EchoWire...");

        let mdns = match ServiceDaemon::new().context("Failed to create mDNS daemon") {
            Ok(m) => m,
            Err(e) => {
                error!("❌ mDNS daemon error: {}", e);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        let receiver = match mdns.browse(SERVICE_TYPE) {
            Ok(r) => r,
            Err(e) => {
                error!("❌ mDNS browse error: {}", e);
                let _ = mdns.shutdown();
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        // Process mDNS events
        loop {
            match receiver.recv_async().await {
                Ok(ServiceEvent::ServiceResolved(info)) => {
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
                    let changed = current.as_ref() != Some(&new_service);

                    if changed {
                        info!(
                            "✅ EchoWire service: {} at {}:{}",
                            new_service.name, new_service.host, new_service.port
                        );
                        if let Some(url) = new_service.ws_url() {
                            info!("🔌 WebSocket URL: {}", url);
                        }

                        *current = Some(new_service);
                        drop(current);

                        // Increment generation to signal existing connections to drop
                        generation += 1;
                        let _ = state.echowire_generation.send(generation);
                        info!("🔄 Backend changed, generation={}", generation);
                    }
                }
                Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                    let mut current = state.echowire_service.write().await;
                    if current.as_ref().map(|s| &s.name) == Some(&fullname) {
                        warn!("⚠️ EchoWire service removed: {}", fullname);
                        *current = None;
                        drop(current);

                        generation += 1;
                        let _ = state.echowire_generation.send(generation);
                        info!("🔄 Backend removed, generation={}", generation);
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    error!("❌ mDNS receive error: {}", e);
                    break;
                }
            }
        }

        // Cleanup and retry
        let _ = mdns.stop_browse(SERVICE_TYPE);
        let _ = mdns.shutdown();

        warn!("🔄 mDNS connection lost, retrying in 5s...");
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn websocket_proxy_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    let service = state.echowire_service.read().await;

    let backend_url = match service.as_ref().and_then(|s| s.ws_url()) {
        Some(url) => url,
        None => {
            error!("❌ No EchoWire service available");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "No EchoWire service discovered",
            )
                .into_response();
        }
    };
    drop(service);

    match tokio::time::timeout(Duration::from_secs(2), connect_to_backend(&backend_url)).await {
        Ok(Ok(backend_ws)) => {
            drop(backend_ws);
            let generation = *state.echowire_generation.borrow();
            ws.on_upgrade(move |socket| {
                handle_websocket_proxy(socket, state, backend_url, generation)
            })
        }
        Ok(Err(e)) => {
            error!("❌ Backend unreachable: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                format!("Backend unavailable: {}", e),
            )
                .into_response()
        }
        Err(_) => {
            error!("❌ Backend connection timeout");
            (StatusCode::GATEWAY_TIMEOUT, "Backend connection timeout").into_response()
        }
    }
}

async fn handle_websocket_proxy(
    client_ws: WebSocket,
    state: Arc<AppState>,
    backend_url: String,
    initial_generation: u64,
) {
    info!("📥 Client connected to /echowire");

    let backend_ws = match connect_to_backend(&backend_url).await {
        Ok(ws) => ws,
        Err(e) => {
            error!("❌ Failed to connect to backend {}: {}", backend_url, e);
            return;
        }
    };

    info!("✅ Connected to backend: {}", backend_url);

    let (mut client_tx, mut client_rx) = client_ws.split();
    let (mut backend_tx, mut backend_rx) = backend_ws.split();

    // Watch for backend changes
    let mut generation_rx = state.echowire_generation.subscribe();

    let client_to_backend = async {
        while let Some(msg) = client_rx.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if backend_tx
                        .send(TungsteniteMessage::Text(text))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Binary(data)) => {
                    if backend_tx
                        .send(TungsteniteMessage::Binary(data))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(data)) => {
                    if backend_tx
                        .send(TungsteniteMessage::Ping(data))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Pong(data)) => {
                    if backend_tx
                        .send(TungsteniteMessage::Pong(data))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    warn!("⚠️ Client read error: {}", e);
                    break;
                }
            }
        }
    };

    let backend_to_client = async {
        while let Some(msg) = backend_rx.next().await {
            match msg {
                Ok(TungsteniteMessage::Text(text)) => {
                    if client_tx.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                Ok(TungsteniteMessage::Binary(data)) => {
                    if client_tx.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Ok(TungsteniteMessage::Close(_)) => break,
                Ok(TungsteniteMessage::Ping(data)) => {
                    if client_tx.send(Message::Ping(data)).await.is_err() {
                        break;
                    }
                }
                Ok(TungsteniteMessage::Pong(data)) => {
                    if client_tx.send(Message::Pong(data)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    warn!("⚠️ Backend read error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    };

    // Wait for generation change (backend address changed)
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
    ws.on_upgrade(move |socket| handle_obs_websocket(socket, state))
}

async fn handle_obs_websocket(socket: WebSocket, state: Arc<AppState>) {
    let client_id = state
        .obs_client_counter
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let (mut tx, mut rx) = socket.split();
    let mut broadcast_rx = state.obs_broadcast.subscribe();

    info!("📺 OBS client {} connected", client_id);

    let send_task = async move {
        while let Ok(msg) = broadcast_rx.recv().await {
            if msg.sender_id != client_id {
                if tx.send(Message::Text(msg.text)).await.is_err() {
                    break;
                }
            }
        }
    };

    let broadcast_tx = state.obs_broadcast.clone();
    let recv_task = async move {
        while let Some(Ok(msg)) = rx.next().await {
            match msg {
                Message::Text(text) => {
                    let _ = broadcast_tx.send(ObsMessage {
                        sender_id: client_id,
                        text,
                    });
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        _ = send_task => {}
        _ = recv_task => {}
    }

    info!("📺 OBS client {} disconnected", client_id);
}
