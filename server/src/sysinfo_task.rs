use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Components, System};
use tokio::sync::broadcast;
use tracing::info;
use crate::ObsMessage;

const POLL_INTERVAL: Duration = Duration::from_secs(5);

pub async fn sysinfo_task(
    obs_broadcast: broadcast::Sender<ObsMessage>,
    last_sysinfo: &Mutex<Option<String>>,
) {
    let mut sys = System::new_all();
    sys.refresh_cpu_usage();
    tokio::time::sleep(Duration::from_secs(1)).await;

    let mut components = Components::new_with_refreshed_list();

    // Log available sensors once so we can see what the platform exposes
    let labels: Vec<_> = components.iter().map(|c| c.label()).collect();
    info!("🌡  Available sensors: {:?}", labels);

    loop {
        sys.refresh_cpu_usage();
        let cpu_usage = sys.global_cpu_usage();

        components.refresh();

        // Prefer a component whose label names a CPU/core explicitly.
        // Fallback: hottest valid reading (Apple Silicon uses opaque sensor IDs).
        let cpu_temp = components
            .iter()
            .filter(|c| {
                let t = c.temperature();
                t.is_finite() && t > 0.0
            })
            .max_by(|a, b| {
                let prefer_a = { let l = a.label().to_lowercase(); l.contains("cpu") || l.contains("core") };
                let prefer_b = { let l = b.label().to_lowercase(); l.contains("cpu") || l.contains("core") };
                match (prefer_a, prefer_b) {
                    (true, false) => std::cmp::Ordering::Greater,
                    (false, true) => std::cmp::Ordering::Less,
                    _ => a.temperature().partial_cmp(&b.temperature()).unwrap_or(std::cmp::Ordering::Equal),
                }
            })
            .map(|c| c.temperature());

        let mut obj = serde_json::json!({
            "type": "sysinfo",
            "cpu_usage": ((cpu_usage as f64) * 10.0).round() / 10.0,
        });
        if let Some(temp) = cpu_temp {
            obj["cpu_temp"] = serde_json::Value::from(((temp as f64) * 10.0).round() / 10.0);
        }

        let text = obj.to_string();
        *last_sysinfo.lock().unwrap() = Some(text.clone());
        let _ = obs_broadcast.send(ObsMessage { sender_id: u64::MAX, text });

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
