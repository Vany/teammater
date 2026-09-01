//! The client-facing `/obs` WebSocket protocol: token check, the welcome
//! burst a newly-connected client gets, and the router that decides what an
//! incoming message does. Split out of `main.rs` — this is the biggest and
//! most protocol-specific piece that used to live there, and the one most
//! likely to be touched again.

use crate::{
    obs,
    obs::ObsConfig,
    state::{AppState, ObsMessage, LOG_RING_SIZE},
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{broadcast, mpsc};
use tracing::{info, info_span, warn, Instrument};

pub async fn obs_websocket_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
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
                    route_incoming(text, client_id, &obs_cmd_tx, &obs_bcast, &state_recv).await;
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
    let Ok(v): Result<Value, _> = serde_json::from_str(&text) else {
        let _ = obs_broadcast.send(ObsMessage {
            sender_id: client_id,
            text,
        });
        return;
    };

    match v["type"].as_str().unwrap_or("") {
        "obs_config" => {
            let url = v["url"].as_str().unwrap_or_default().to_string();
            let password = v["password"].as_str().unwrap_or_default().to_string();
            if !url.is_empty() {
                // Only publish a CHANGE. The browser sends obs_config on every
                // /obs open, and watch::send marks the value changed even when
                // it is identical — so a plain send() made every page reload
                // (and every bus reconnect after a network blip) break the OBS
                // session and re-authenticate, for config that did not change.
                // That is manufactured reconnect churn, and churn is the one
                // correlate the OBS-crash investigation in TODO.md actually
                // found: the single session that ever died had 4 client
                // connects against 1 in every clean one, and died a second
                // after a reconnect.
                let next = ObsConfig { url, password };
                let changed = state.obs_config_tx.send_if_modified(|cur| {
                    if *cur == next {
                        false
                    } else {
                        *cur = next;
                        true
                    }
                });
                if changed {
                    info!("🎬 OBS config changed: {}", state.obs_config_tx.borrow().url);
                }
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
