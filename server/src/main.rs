use anyhow::Result;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use futures_util::{SinkExt, StreamExt};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message as TungsteniteMessage, MaybeTlsStream, WebSocketStream};
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{error, info, warn};

mod tls;

#[derive(Clone)]
struct AppState {
    echowire_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,teammater_server=debug")
        .init();

    let state = Arc::new(AppState {
        echowire_url: "ws://192.168.15.225:8080".to_string(),
    });

    let cert_path = PathBuf::from("server/certs/cert.pem");
    let key_path = PathBuf::from("server/certs/key.pem");

    tls::ensure_cert_exists(&cert_path, &key_path)?;

    let tls_config = RustlsConfig::from_pem_file(&cert_path, &key_path)
        .await?;

    let app = Router::new()
        .route("/echowire", get(websocket_proxy_handler))
        .nest_service("/", ServeDir::new("."))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8443));
    info!("🚀 Server listening on https://{}", addr);
    info!("📁 Serving static files from current directory");
    info!("🔌 WebSocket proxy: wss://{}/echowire -> ws://192.168.15.225:8080", addr);

    axum_server::bind_rustls(addr, tls_config)
        .serve(app.into_make_service())
        .await?;

    Ok(())
}

async fn websocket_proxy_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_websocket_proxy(socket, state))
}

async fn handle_websocket_proxy(client_ws: WebSocket, state: Arc<AppState>) {
    info!("📥 Client connected to /echowire");

    let backend_url = &state.echowire_url;
    
    let backend_ws = match connect_to_backend(backend_url).await {
        Ok(ws) => ws,
        Err(e) => {
            error!("❌ Failed to connect to backend {}: {}", backend_url, e);
            return;
        }
    };

    info!("✅ Connected to backend: {}", backend_url);

    let (mut client_tx, mut client_rx) = client_ws.split();
    let (mut backend_tx, mut backend_rx) = backend_ws.split();

    let client_to_backend = async {
        while let Some(msg) = client_rx.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if backend_tx.send(TungsteniteMessage::Text(text)).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Binary(data)) => {
                    if backend_tx.send(TungsteniteMessage::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(data)) => {
                    if backend_tx.send(TungsteniteMessage::Ping(data)).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Pong(data)) => {
                    if backend_tx.send(TungsteniteMessage::Pong(data)).await.is_err() {
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

    tokio::select! {
        _ = client_to_backend => {
            info!("📤 Client->Backend stream closed");
        }
        _ = backend_to_client => {
            info!("📥 Backend->Client stream closed");
        }
    }

    info!("🔌 WebSocket proxy session ended");
}

async fn connect_to_backend(url: &str) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let (ws_stream, _) = connect_async(url).await?;
    Ok(ws_stream)
}
