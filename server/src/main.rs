use anyhow::Result;
use axum::{
    body::to_bytes,
    extract::{ws::WebSocketUpgrade, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use security::deny_sensitive_paths;
use state::AppState;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
};
use tower_http::services::{ServeDir, ServeFile};
use tracing::{error, info, info_span, Instrument};

mod ble;
mod bus;
mod echowire;
mod obs;
mod security;
mod state;
mod sysinfo_task;
mod tls;
mod zigbee;

/// Re-exported so `ble.rs`, `zigbee.rs`, `sysinfo_task.rs` and `obs.rs` — all
/// written against `crate::ObsMessage` from when this type lived here — keep
/// working unchanged now that its definition moved into `state.rs`.
pub use state::ObsMessage;

// ─────────────────────────────────────────────── configuration ──

const HTTPS_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8443);
const HTTP_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8442);
const CERT_PATH: &str = "server/certs/cert.pem";
const KEY_PATH: &str = "server/certs/key.pem";

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
        .route("/obs", get(bus::obs_websocket_handler))
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
/// Pages served to localhost (index.html, obs.html, and the `UserScript` talking
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

/// This is a debug/logging endpoint — it exists only to observe what a
/// health-tracking app's import webhook actually sends, and every real
/// payload here is a small JSON blob. `to_bytes` previously ran with
/// `usize::MAX`, buffering the whole request body in memory with no cap
/// before it was ever inspected. Both listeners bind 0.0.0.0 and the route
/// accepts any method, so any LAN device could send a multi-gigabyte POST
/// and put the server under memory pressure for a log line. A generous but
/// bounded cap costs nothing here — nothing legitimate is anywhere close to it.
const MAX_HEALTH_APP_BODY: usize = 1024 * 1024; // 1 MiB

async fn health_app_handler(req: Request) -> StatusCode {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req
        .headers()
        .iter()
        .map(|(k, v)| format!("{k}: {}", v.to_str().unwrap_or("<binary>")))
        .collect::<Vec<_>>()
        .join(", ");
    let body_display = match to_bytes(req.into_body(), MAX_HEALTH_APP_BODY).await {
        Ok(bytes) if bytes.is_empty() => "<empty>".to_string(),
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        // Distinguish this from "<empty>" — the previous unwrap_or_default()
        // logged both identically, which would have hidden the exact
        // oversized-body condition this cap exists to catch.
        Err(e) => format!("<body rejected: {e}>"),
    };
    info!("🏥 health-app {method} {uri} | headers=[{headers}] | body={body_display}");
    StatusCode::OK
}

// ──────────────────────────────────────────── /echowire proxy ──

async fn echowire_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    echowire::upgrade(ws, &state.echowire).await
}
