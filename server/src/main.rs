use anyhow::Result;
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
use rustls::ServerConfig;
use std::{fs, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async, tungstenite::Message as TungsteniteMessage, MaybeTlsStream, WebSocketStream,
};
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

    // Load TLS config and disable HTTP/2 (required for WebSocket)
    let cert_pem = fs::read(&cert_path)?;
    let key_pem = fs::read(&key_path)?;

    let certs = rustls_pemfile::certs(&mut &cert_pem[..]).collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut &key_pem[..])?
        .ok_or_else(|| anyhow::anyhow!("No private key found"))?;

    let mut tls_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    // Disable HTTP/2 - only use HTTP/1.1 for WebSocket support
    tls_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    let app = Router::new()
        .route("/echowire", get(websocket_proxy_handler))
        .nest_service("/", ServeDir::new("."))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8443));
    info!("🚀 Server listening on https://{}", addr);
    info!("📁 Serving static files from current directory");
    info!(
        "🔌 WebSocket proxy: wss://{}/echowire -> ws://192.168.15.225:8080",
        addr
    );

    axum_server::bind_rustls(
        addr,
        axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls_config)),
    )
    .serve(app.into_make_service())
    .await?;

    Ok(())
}

async fn websocket_proxy_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    // Test backend connection before upgrading WebSocket
    let backend_url = state.echowire_url.clone();

    match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        connect_to_backend(&backend_url),
    )
    .await
    {
        Ok(Ok(backend_ws)) => {
            // Backend reachable, upgrade WebSocket and start proxy
            drop(backend_ws); // Close test connection
            ws.on_upgrade(move |socket| handle_websocket_proxy(socket, state))
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
