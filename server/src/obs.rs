use crate::ObsMessage;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, watch, RwLock};
use tokio_tungstenite::{
    connect_async, tungstenite::Message as WsMsg, MaybeTlsStream, WebSocketStream,
};
use tracing::{error, info, warn};

/// OBS connection config pushed by the browser module on connect.
/// Empty url means "not configured yet — wait".
#[derive(Clone, Debug, Default)]
pub struct ObsConfig {
    pub url: String,
    pub password: String,
}

const OBS_RECONNECT_DELAY_MAX: u64 = 300;
const OBS_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// `EventSubscriptions`: Scenes (1<<2=4) + Outputs (1<<6=64)
const OBS_EVENT_SUBS: u32 = 68;

type ObsWsTx = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, WsMsg>;

// ──────────────────────────────────────────────────────── shared state ──

#[derive(Clone, Debug, Default, Serialize)]
pub struct SharedObsState {
    pub connected: bool,
    pub scene: String,
    pub scenes: Vec<String>,
    pub streaming: Option<StreamingInfo>,
    pub recording: Option<RecordingInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StreamingInfo {
    pub active: bool,
    pub timecode: String,
    pub dropped_frames: u32,
    pub total_frames: u32,
    pub bitrate_kbps: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct RecordingInfo {
    pub active: bool,
    pub paused: bool,
    /// "HH:MM:SS.mmm" from OBS outputTimecode — cumulative active recording time
    pub timecode: String,
}

impl SharedObsState {
    pub fn to_state_json(&self) -> String {
        json!({
            "type": "obs_state",
            "connected": self.connected,
            "scene": self.scene,
            "scenes": self.scenes,
            "streaming": self.streaming,
            "recording": self.recording,
        })
        .to_string()
    }
}

// ─────────────────────────────────────────────────────────── commands ──

#[derive(Debug)]
pub enum ObsCommand {
    SwitchScene(String),
    StartRecord,
    StopRecord,
    PauseRecord,
    ResumeRecord,
}

// ─────────────────────────────────────────────────────────── main task ──

pub async fn obs_task(
    broadcast_tx: broadcast::Sender<ObsMessage>,
    mut cmd_rx: mpsc::Receiver<ObsCommand>,
    obs_state: Arc<RwLock<SharedObsState>>,
    mut config_rx: watch::Receiver<ObsConfig>,
) {
    let mut backoff_secs: u64 = 1;

    loop {
        // Wait until the browser sends a non-empty URL
        let config = config_rx.borrow_and_update().clone();
        if config.url.is_empty() {
            backoff_secs = 1;
            info!("🎬 Waiting for OBS config from browser...");
            if config_rx.changed().await.is_err() {
                return;
            }
            continue;
        }

        info!("🎬 OBS connecting to {} (retry in {backoff_secs}s if fails)...", config.url);
        match run_obs_session(&config, &broadcast_tx, &mut cmd_rx, &obs_state, &mut config_rx).await {
            Ok(()) => {
                warn!("🎬 OBS session ended");
                backoff_secs = 1;
            }
            Err(e) => {
                error!("🎬 OBS error: {e} — retry in {backoff_secs}s");
            }
        }

        // Publish disconnected state so clients know
        {
            let mut state = obs_state.write().await;
            state.connected = false;
            state.streaming = None;
            let json = state.to_state_json();
            let _ = broadcast_tx.send(ObsMessage { sender_id: u64::MAX, text: json });
        }

        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(OBS_RECONNECT_DELAY_MAX);
    }
}

async fn run_obs_session(
    config: &ObsConfig,
    broadcast_tx: &broadcast::Sender<ObsMessage>,
    cmd_rx: &mut mpsc::Receiver<ObsCommand>,
    obs_state: &Arc<RwLock<SharedObsState>>,
    config_rx: &mut watch::Receiver<ObsConfig>,
) -> Result<()> {
    let (ws, _) = connect_async(&config.url).await?;
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Hello (op 0)
    let hello = recv_json(&mut ws_rx).await?;
    if hello["op"] != 0 {
        return Err(anyhow!("Expected op 0 (Hello), got {}", hello["op"]));
    }

    // Identify (op 1) — with auth if required
    let auth = build_auth(&hello["d"]["authentication"], &config.password);
    ws_tx
        .send(WsMsg::Text(
            json!({
                "op": 1,
                "d": {
                    "rpcVersion": 1,
                    "eventSubscriptions": OBS_EVENT_SUBS,
                    "authentication": auth,
                }
            })
            .to_string(),
        ))
        .await?;

    // Identified (op 2)
    let identified = recv_json(&mut ws_rx).await?;
    if identified["op"] != 2 {
        return Err(anyhow!("Expected op 2 (Identified), got {}", identified["op"]));
    }
    info!("🎬 OBS authenticated");

    // Initial queries
    send_req(&mut ws_tx, "GetSceneList", "GetSceneList", json!({})).await?;
    send_req(&mut ws_tx, "GetStreamStatus", "GetStreamStatus", json!({})).await?;
    send_req(&mut ws_tx, "GetRecordStatus", "GetRecordStatus", json!({})).await?;

    obs_state.write().await.connected = true;

    let mut poll = tokio::time::interval(OBS_POLL_INTERVAL);
    poll.tick().await; // skip first immediate tick
    let mut last_stream_bytes: Option<u64> = None;

    // The loop is an async block so that EVERY way out of it — break, the
    // shutdown return, and the `?` error paths — lands on the close handshake
    // below instead of dropping the socket where it stands.
    let outcome: Result<()> = async {
        loop {
            tokio::select! {
                msg = ws_rx.next() => match msg {
                    None => break,
                    Some(Err(e)) => { warn!("🎬 WS read error: {e}"); break; }
                    Some(Ok(m)) => handle_ws_msg(m, broadcast_tx, obs_state, &mut last_stream_bytes).await?,
                },
                _ = poll.tick() => {
                    send_req(&mut ws_tx, "GetStreamStatus", "GetStreamStatus", json!({})).await?;
                    send_req(&mut ws_tx, "GetRecordStatus", "GetRecordStatus", json!({})).await?;
                },
                cmd = cmd_rx.recv() => match cmd {
                    None => return Ok(()), // channel closed = shutdown signal
                    Some(cmd) => exec_cmd(&mut ws_tx, cmd).await?,
                },
                Ok(()) = config_rx.changed() => {
                    warn!("🎬 OBS config changed, reconnecting...");
                    break;
                },
            }
        }
        Ok(())
    }
    .await;

    // Close the WebSocket properly rather than letting the TCP socket die with
    // the task. Every disconnect this server has ever made shows up in the OBS
    // log as `code 1006 ... reason: End of File` — an abrupt EOF, even on a
    // clean config change or shutdown. Best-effort: if the peer is already gone
    // there is nothing to hand it, and the session outcome is what matters.
    let _ = ws_tx.send(WsMsg::Close(None)).await;

    outcome
}

// ──────────────────────────────────────────────────── message handling ──

async fn handle_ws_msg(
    msg: WsMsg,
    broadcast_tx: &broadcast::Sender<ObsMessage>,
    obs_state: &Arc<RwLock<SharedObsState>>,
    last_bytes: &mut Option<u64>,
) -> Result<()> {
    let text = match msg {
        WsMsg::Text(t) => t,
        WsMsg::Close(_) => return Err(anyhow!("OBS closed connection")),
        _ => return Ok(()),
    };
    let msg: Value = serde_json::from_str(&text)?;
    match msg["op"].as_u64().unwrap_or(99) {
        5 => on_event(&msg["d"], broadcast_tx, obs_state).await,
        7 => on_response(&msg["d"], broadcast_tx, obs_state, last_bytes).await,
        _ => Ok(()),
    }
}

async fn on_event(
    d: &Value,
    broadcast_tx: &broadcast::Sender<ObsMessage>,
    obs_state: &Arc<RwLock<SharedObsState>>,
) -> Result<()> {
    let event_type = d["eventType"].as_str().unwrap_or_default();
    let data = &d["eventData"];

    match event_type {
        "CurrentProgramSceneChanged" => {
            let scene = str_val(&data["sceneName"]);
            info!("🎬 Scene → {scene}");
            let bcast = {
                let mut s = obs_state.write().await;
                s.scene.clone_from(&scene);
                json!({"type":"obs_scene","scene": scene,"scenes": s.scenes}).to_string()
            };
            broadcast_sys(broadcast_tx, bcast);
        }
        "SceneListChanged" => {
            let scenes = parse_scene_list(&data["scenes"]);
            let bcast = {
                let mut s = obs_state.write().await;
                s.scenes.clone_from(&scenes);
                json!({"type":"obs_scene","scene": s.scene,"scenes": scenes}).to_string()
            };
            broadcast_sys(broadcast_tx, bcast);
        }
        "StreamStateChanged" => {
            let active = data["outputActive"].as_bool().unwrap_or(false);
            let bcast = {
                let mut s = obs_state.write().await;
                if !active {
                    s.streaming = None;
                } else if s.streaming.is_none() {
                    s.streaming = Some(StreamingInfo {
                        active: true,
                        timecode: "00:00:00.000".into(),
                        dropped_frames: 0,
                        total_frames: 0,
                        bitrate_kbps: 0,
                    });
                }
                json!({"type":"obs_streaming","streaming": s.streaming}).to_string()
            };
            broadcast_sys(broadcast_tx, bcast);
        }
        "RecordStateChanged" => {
            let active = data["outputActive"].as_bool().unwrap_or(false);
            let paused = data["outputState"].as_str() == Some("OBS_WEBSOCKET_OUTPUT_PAUSED");
            let bcast = {
                let mut s = obs_state.write().await;
                if active {
                    let timecode = s
                        .recording
                        .as_ref()
                        .map_or_else(|| "00:00:00.000".into(), |r| r.timecode.clone());
                    s.recording = Some(RecordingInfo { active: true, paused, timecode });
                } else {
                    s.recording = None;
                }
                json!({"type":"obs_recording","recording": s.recording}).to_string()
            };
            broadcast_sys(broadcast_tx, bcast);
        }
        _ => {}
    }
    Ok(())
}

async fn on_response(
    d: &Value,
    broadcast_tx: &broadcast::Sender<ObsMessage>,
    obs_state: &Arc<RwLock<SharedObsState>>,
    last_bytes: &mut Option<u64>,
) -> Result<()> {
    if d["requestStatus"]["result"].as_bool() != Some(true) {
        // Do not swallow it. A rejected SetCurrentProgramScene (wrong scene
        // name, e.g. the hardcoded "Glasses" in VOICE_ACTIONS after the scene
        // was renamed) used to vanish here while the browser had already
        // logged "📺 Switching scene →" optimistically — the command did
        // nothing and both logs claimed success.
        warn!(
            "🎬 OBS rejected {}: {}",
            d["requestId"].as_str().unwrap_or("<no requestId>"),
            d["requestStatus"]["comment"]
                .as_str()
                .unwrap_or("no comment")
        );
        return Ok(());
    }
    let req_id = d["requestId"].as_str().unwrap_or_default();
    let data = &d["responseData"];

    match req_id {
        "GetSceneList" => {
            let scene = str_val(&data["currentProgramSceneName"]);
            let scenes = parse_scene_list(&data["scenes"]);
            let snapshot = {
                let mut s = obs_state.write().await;
                s.scene.clone_from(&scene);
                s.scenes.clone_from(&scenes);
                s.to_state_json()
            };
            info!("🎬 OBS ready — scene: {scene} ({} scenes)", scenes.len());
            broadcast_sys(broadcast_tx, snapshot);
        }
        "GetStreamStatus" => {
            let active = data["outputActive"].as_bool().unwrap_or(false);
            let bcast = {
                let mut s = obs_state.write().await;
                if active {
                    let bytes = data["outputBytes"].as_u64().unwrap_or(0);
                    let bitrate = last_bytes.map_or(0, |prev| {
                        let diff = bytes.saturating_sub(prev);
                        let kbps = diff * 8 / OBS_POLL_INTERVAL.as_secs().max(1) / 1000;
                        // Saturate rather than wrap: no real stream gets anywhere
                        // near u32::MAX kbps, but a silent wraparound would be a
                        // worse failure mode than a capped, visibly-wrong number.
                        u32::try_from(kbps).unwrap_or(u32::MAX)
                    });
                    *last_bytes = Some(bytes);

                    s.streaming = Some(StreamingInfo {
                        active: true,
                        timecode: str_val(&data["outputTimecode"]),
                        dropped_frames: u32::try_from(
                            data["outputSkippedFrames"].as_u64().unwrap_or(0),
                        )
                        .unwrap_or(u32::MAX),
                        total_frames: u32::try_from(data["outputTotalFrames"].as_u64().unwrap_or(0))
                            .unwrap_or(u32::MAX),
                        bitrate_kbps: bitrate,
                    });
                } else {
                    s.streaming = None;
                    *last_bytes = None;
                }
                json!({"type":"obs_streaming","streaming": s.streaming}).to_string()
            };
            broadcast_sys(broadcast_tx, bcast);
        }
        "GetRecordStatus" => {
            let active = data["outputActive"].as_bool().unwrap_or(false);
            let bcast = {
                let mut s = obs_state.write().await;
                s.recording = if active {
                    Some(RecordingInfo {
                        active: true,
                        paused: data["outputPaused"].as_bool().unwrap_or(false),
                        timecode: str_val(&data["outputTimecode"]),
                    })
                } else {
                    None
                };
                json!({"type":"obs_recording","recording": s.recording}).to_string()
            };
            broadcast_sys(broadcast_tx, bcast);
        }
        _ => {}
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────── helpers ──

async fn recv_json(ws_rx: &mut futures_util::stream::SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>) -> Result<Value> {
    loop {
        match ws_rx.next().await {
            None => return Err(anyhow!("OBS connection closed unexpectedly")),
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(WsMsg::Text(t))) => return Ok(serde_json::from_str(&t)?),
            Some(Ok(WsMsg::Close(_))) => return Err(anyhow!("OBS closed before auth")),
            Some(Ok(_)) => {} // skip pings etc.
        }
    }
}

async fn send_req(ws_tx: &mut ObsWsTx, request_type: &str, request_id: &str, data: Value) -> Result<()> {
    ws_tx
        .send(WsMsg::Text(
            json!({"op":6,"d":{"requestType":request_type,"requestId":request_id,"requestData":data}})
                .to_string(),
        ))
        .await?;
    Ok(())
}

async fn exec_cmd(ws_tx: &mut ObsWsTx, cmd: ObsCommand) -> Result<()> {
    let (rtype, rid, data) = match cmd {
        ObsCommand::SwitchScene(scene) => {
            ("SetCurrentProgramScene", "cmd_switch", json!({"sceneName": scene}))
        }
        ObsCommand::StartRecord => ("StartRecord", "cmd_start_rec", json!({})),
        ObsCommand::StopRecord => ("StopRecord", "cmd_stop_rec", json!({})),
        ObsCommand::PauseRecord => ("PauseRecord", "cmd_pause_rec", json!({})),
        ObsCommand::ResumeRecord => ("ResumeRecord", "cmd_resume_rec", json!({})),
    };
    send_req(ws_tx, rtype, rid, data).await
}

fn build_auth(auth_data: &Value, password: &str) -> Option<String> {
    let challenge = auth_data["challenge"].as_str()?;
    let salt = auth_data["salt"].as_str()?;

    let mut h1 = Sha256::new();
    h1.update(password.as_bytes());
    h1.update(salt.as_bytes());
    let secret = BASE64.encode(h1.finalize());

    let mut h2 = Sha256::new();
    h2.update(secret.as_bytes());
    h2.update(challenge.as_bytes());
    Some(BASE64.encode(h2.finalize()))
}

fn broadcast_sys(tx: &broadcast::Sender<ObsMessage>, text: String) {
    let _ = tx.send(ObsMessage { sender_id: u64::MAX, text });
}

fn str_val(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn parse_scene_list(scenes: &Value) -> Vec<String> {
    scenes
        .as_array()
        .map(|arr| arr.iter().filter_map(|s| s["sceneName"].as_str().map(String::from)).collect())
        .unwrap_or_default()
}
