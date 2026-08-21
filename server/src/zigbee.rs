//! `Zigbee2MQTT` climate source.
//!
//! Connects to the `Zigbee2MQTT` frontend WebSocket bridge (`ws://c:8081/api`),
//! watches a single temperature/humidity sensor (device `T1`, a Xiaomi
//! WSDCGQ01LM), and broadcasts its readings to the `/obs` bus as
//! `{"type":"climate","temperature":T,"humidity":H}` for the OBS overlay.
//!
//! Mirrors `ble.rs`: an independent task with a fixed reconnect delay that never
//! affects other services. Z2M is MQTT-first with no REST API; the frontend WS
//! bridge is the dependency-free path (reuses `tokio-tungstenite`) and replays
//! retained device state on connect, so `T1` appears immediately.

use crate::ObsMessage;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMsg};
use tracing::{error, info, warn};

const Z2M_ADDR: &str = "ws://c:8081/api";
/// Friendly name of the sensor to watch. Hardcoded per design.
const Z2M_DEVICE: &str = "T1";
const Z2M_RECONNECT_DELAY: Duration = Duration::from_secs(5);

pub async fn zigbee_task(tx: broadcast::Sender<ObsMessage>, last_climate: &Mutex<Option<String>>) {
    loop {
        match run_session(&tx, last_climate).await {
            Ok(()) => warn!("🌡  Zigbee session ended, reconnecting in {Z2M_RECONNECT_DELAY:?}"),
            Err(e) => error!("🌡  Zigbee error: {e}, retrying in {Z2M_RECONNECT_DELAY:?}"),
        }
        tokio::time::sleep(Z2M_RECONNECT_DELAY).await;
    }
}

async fn run_session(
    tx: &broadcast::Sender<ObsMessage>,
    last_climate: &Mutex<Option<String>>,
) -> Result<()> {
    let (mut ws, _) = connect_async(Z2M_ADDR).await?;
    info!("🌡  Zigbee connected to {Z2M_ADDR}, watching '{Z2M_DEVICE}'");

    // Last-known reading of each metric — sensor may report either attribute
    // alone, so we carry the other over to always broadcast a complete pair.
    let mut last_temp: Option<f64> = None;
    let mut last_humidity: Option<f64> = None;

    while let Some(msg) = ws.next().await {
        match msg? {
            WsMsg::Text(text) => {
                // Z2M frontend frames: {"topic":"<friendly_name>","payload":{...}}
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let topic = v["topic"].as_str().unwrap_or_default();
                if let Some(out) =
                    build_climate(topic, &v["payload"], &mut last_temp, &mut last_humidity)
                {
                    info!(
                        "🌡  {Z2M_DEVICE}: {}°C {}%",
                        fmt_opt(last_temp),
                        fmt_opt(last_humidity)
                    );
                    *last_climate.lock().unwrap() = Some(out.clone());
                    let _ = tx.send(ObsMessage {
                        sender_id: u64::MAX,
                        text: out,
                    });
                }
            }
            // Z2M's WS server pings; answer so it doesn't drop us mid-stream.
            WsMsg::Ping(p) => ws.send(WsMsg::Pong(p)).await?,
            WsMsg::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

/// Build the `/obs` climate broadcast for a Z2M device message, or `None` if the
/// message is for another device or carries no temperature/humidity.
///
/// Updates `last_temp`/`last_humidity` in place and always emits both known
/// metrics, so a report containing only one attribute still yields a complete pair.
fn build_climate(
    topic: &str,
    payload: &Value,
    last_temp: &mut Option<f64>,
    last_humidity: &mut Option<f64>,
) -> Option<String> {
    if topic != Z2M_DEVICE {
        return None;
    }
    let temp = payload.get("temperature").and_then(Value::as_f64);
    let humidity = payload.get("humidity").and_then(Value::as_f64);
    if temp.is_none() && humidity.is_none() {
        return None; // e.g. battery-only report or availability string
    }
    if let Some(t) = temp {
        *last_temp = Some(round1(t));
    }
    if let Some(h) = humidity {
        *last_humidity = Some(round1(h));
    }

    let mut obj = serde_json::json!({ "type": "climate" });
    if let Some(t) = *last_temp {
        obj["temperature"] = Value::from(t);
    }
    if let Some(h) = *last_humidity {
        obj["humidity"] = Value::from(h);
    }
    Some(obj.to_string())
}

/// Round to one decimal — sensor precision is ~0.01, the overlay shows one digit.
fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn fmt_opt(v: Option<f64>) -> String {
    v.map_or_else(|| "—".into(), |x| format!("{x:.1}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ignores_other_devices() {
        let (mut t, mut h) = (None, None);
        assert_eq!(
            build_climate("S1", &json!({"temperature":25.0,"humidity":50.0}), &mut t, &mut h),
            None
        );
        assert_eq!(t, None);
        assert_eq!(h, None);
    }

    #[test]
    fn emits_temperature_and_humidity() {
        let (mut t, mut h) = (None, None);
        let out = build_climate(
            Z2M_DEVICE,
            &json!({"temperature":23.4,"humidity":61.77,"battery":100}),
            &mut t,
            &mut h,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["type"], "climate");
        assert_eq!(v["temperature"], 23.4);
        assert_eq!(v["humidity"], 61.8); // rounded to one decimal
    }

    #[test]
    fn merges_partial_reports() {
        let (mut t, mut h) = (None, None);
        // temperature-only report
        let out1 = build_climate(Z2M_DEVICE, &json!({"temperature":22.0}), &mut t, &mut h).unwrap();
        let v1: Value = serde_json::from_str(&out1).unwrap();
        assert_eq!(v1["temperature"], 22.0);
        assert!(v1.get("humidity").is_none());
        // humidity-only report → temperature carried over
        let out2 = build_climate(Z2M_DEVICE, &json!({"humidity":55.0}), &mut t, &mut h).unwrap();
        let v2: Value = serde_json::from_str(&out2).unwrap();
        assert_eq!(v2["temperature"], 22.0);
        assert_eq!(v2["humidity"], 55.0);
    }

    #[test]
    fn skips_reports_without_climate_fields() {
        let (mut t, mut h) = (Some(20.0), Some(40.0));
        assert_eq!(build_climate(Z2M_DEVICE, &json!({"battery":88}), &mut t, &mut h), None);
        // availability payloads arrive as bare strings
        assert_eq!(build_climate(Z2M_DEVICE, &json!("online"), &mut t, &mut h), None);
        // untouched
        assert_eq!(t, Some(20.0));
        assert_eq!(h, Some(40.0));
    }

    #[test]
    fn rounds_to_one_decimal() {
        let (mut t, mut h) = (None, None);
        let out = build_climate(
            Z2M_DEVICE,
            &json!({"temperature":23.456,"humidity":61.77}),
            &mut t,
            &mut h,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["temperature"], 23.5);
        assert_eq!(v["humidity"], 61.8);
    }
}
