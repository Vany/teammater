use anyhow::Result;
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::{net::IpAddr, sync::Arc, time::Duration};
use tokio::net::TcpStream;
use tokio::sync::{watch, RwLock};
use tokio_tungstenite::{
    connect_async, tungstenite::Message as WsMsg, MaybeTlsStream, WebSocketStream,
};
use tracing::{error, info, info_span, warn, Instrument};

const MDNS_RETRY_DELAY: Duration = Duration::from_secs(5);
const SERVICE_TYPE: &str = "_echowire._tcp.local.";

// ─────────────────────────────────────── service discovery state ──

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

/// Shared state for `EchoWire` discovery + proxy.
pub struct EchoWireState {
    service:    RwLock<Option<EchoWireService>>,
    generation: watch::Sender<u64>,
}

impl EchoWireState {
    pub fn new() -> Arc<Self> {
        let (gen_tx, _) = watch::channel(0u64);
        Arc::new(Self { service: RwLock::new(None), generation: gen_tx })
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.generation.subscribe()
    }

    async fn current_url(&self) -> Option<String> {
        self.service.read().await.as_ref().and_then(EchoWireService::ws_url)
    }
}

// ────────────────────────────────────────────── mDNS discovery ──

pub async fn mdns_task(state: Arc<EchoWireState>) {
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
                    let svc = EchoWireService {
                        name: info.get_fullname().to_string(),
                        host: info.get_hostname().to_string(),
                        port: info.get_port(),
                        addresses,
                    };
                    let mut cur = state.service.write().await;
                    if cur.as_ref() == Some(&svc) { continue; }
                    info!("✅ EchoWire: {} at {}:{}", svc.name, svc.host, svc.port);
                    if let Some(url) = svc.ws_url() { info!("🔌 WS: {url}"); }
                    *cur = Some(svc);
                    drop(cur);
                    generation += 1;
                    let _ = state.generation.send(generation);
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    let mut cur = state.service.write().await;
                    if cur.as_ref().map(|s| &s.name) != Some(&fullname) { continue; }
                    warn!("⚠️ EchoWire removed: {fullname}");
                    *cur = None;
                    drop(cur);
                    generation += 1;
                    let _ = state.generation.send(generation);
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

// ─────────────────────────────────────────────── WebSocket proxy ──

pub async fn upgrade(ws: WebSocketUpgrade, state: &Arc<EchoWireState>) -> Response {
    let mut gen_rx = state.subscribe();
    let Some(backend_url) = state.current_url().await else {
        error!("❌ No EchoWire service available");
        return (StatusCode::SERVICE_UNAVAILABLE, "No EchoWire service discovered").into_response();
    };
    let generation = *gen_rx.borrow_and_update();
    ws.on_upgrade(move |socket| {
        proxy(socket, backend_url, generation, gen_rx).instrument(info_span!("echowire_proxy"))
    })
}

async fn proxy(
    client_ws: WebSocket,
    backend_url: String,
    initial_generation: u64,
    mut gen_rx: watch::Receiver<u64>,
) {
    info!("📥 EchoWire client connected");
    if *gen_rx.borrow() != initial_generation {
        warn!("🔄 Backend changed before connection established, rejecting");
        return;
    }
    let Ok(backend_ws) = connect_backend(&backend_url).await else {
        error!("❌ Failed to connect to backend: {backend_url}");
        return;
    };
    info!("✅ Connected to backend: {backend_url}");

    let (mut client_tx, mut client_rx) = client_ws.split();
    let (mut backend_tx, mut backend_rx) = backend_ws.split();

    let c2b = async {
        while let Some(Ok(msg)) = client_rx.next().await {
            let Some(m) = axum_to_ws(msg) else { break };
            if backend_tx.send(m).await.is_err() { break }
        }
    };
    let b2c = async {
        while let Some(Ok(msg)) = backend_rx.next().await {
            let Some(m) = ws_to_axum(msg) else { break };
            if client_tx.send(m).await.is_err() { break }
        }
    };
    let gen_watch = async {
        loop {
            if gen_rx.changed().await.is_err() { break }
            if *gen_rx.borrow() != initial_generation {
                warn!("🔄 Backend changed, dropping EchoWire connection");
                break;
            }
        }
    };

    tokio::select! { () = c2b => {}, () = b2c => {}, () = gen_watch => {} }
}

async fn connect_backend(url: &str) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    Ok(connect_async(url).await?.0)
}

fn axum_to_ws(msg: Message) -> Option<WsMsg> {
    match msg {
        Message::Text(t)   => Some(WsMsg::Text(t)),
        Message::Binary(b) => Some(WsMsg::Binary(b)),
        Message::Ping(d)   => Some(WsMsg::Ping(d)),
        Message::Pong(d)   => Some(WsMsg::Pong(d)),
        Message::Close(_)  => None,
    }
}

fn ws_to_axum(msg: WsMsg) -> Option<Message> {
    match msg {
        WsMsg::Text(t)              => Some(Message::Text(t)),
        WsMsg::Binary(b)            => Some(Message::Binary(b)),
        WsMsg::Ping(d)              => Some(Message::Ping(d)),
        WsMsg::Pong(d)              => Some(Message::Pong(d)),
        WsMsg::Close(_) | WsMsg::Frame(_) => None,
    }
}
