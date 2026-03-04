use btleplug::api::{bleuuid::uuid_from_u16, Central, CentralEvent, Manager as _, Peripheral as _};
use btleplug::platform::Manager;
use uuid::Uuid;
use futures_util::StreamExt;
use std::time::Duration;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::ObsMessage;

const DEVICE_NAME: &str = "HeartCast";
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

// BLE Heart Rate Service (0x180D) / Heart Rate Measurement characteristic (0x2A37)
fn hr_char_uuid() -> Uuid {
    uuid_from_u16(0x2A37)
}

pub async fn ble_task(tx: broadcast::Sender<ObsMessage>) {
    loop {
        match run_ble(&tx).await {
            Ok(()) => warn!("💓 BLE session ended, reconnecting..."),
            Err(e) => error!("💓 BLE error: {e}, retrying in {RECONNECT_DELAY:?}"),
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

async fn run_ble(tx: &broadcast::Sender<ObsMessage>) -> anyhow::Result<()> {
    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No BLE adapter found"))?;

    info!("💓 Scanning for '{DEVICE_NAME}'...");
    adapter.start_scan(Default::default()).await?;

    let peripheral = {
        let mut events = adapter.events().await?;
        loop {
            match events.next().await {
                None => anyhow::bail!("BLE event stream ended"),
                Some(CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id)) => {
                    let p = adapter.peripheral(&id).await?;
                    let name = p
                        .properties()
                        .await?
                        .and_then(|props| props.local_name);
                    if name.as_deref().map(|n| n.contains(DEVICE_NAME)).unwrap_or(false) {
                        info!("💓 Found: {}", name.unwrap());
                        break p;
                    }
                }
                _ => {}
            }
        }
    };

    adapter.stop_scan().await?;
    peripheral.connect().await?;
    info!("💓 Connected to {DEVICE_NAME}");

    peripheral.discover_services().await?;

    let hr_uuid = hr_char_uuid();
    let chars = peripheral.characteristics();
    let hr_char = chars
        .iter()
        .find(|c| c.uuid == hr_uuid)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("HR characteristic 0x2A37 not found"))?;

    peripheral.subscribe(&hr_char).await?;
    info!("💓 Subscribed to Heart Rate Measurement");

    let mut last_leading: Option<u16> = None;
    let mut notifs = peripheral.notifications().await?;
    while let Some(data) = notifs.next().await {
        if data.uuid == hr_uuid {
            match parse_hr(&data.value) {
                Some(bpm) => {
                    let leading = leading_digit(bpm);
                    if last_leading != Some(leading) {
                        info!("💓 Heart Rate: {} bpm", bpm);
                        last_leading = Some(leading);
                    }
                    let _ = tx.send(ObsMessage {
                        sender_id: u64::MAX, // system sender — all clients receive
                        text: format!("{{\"heartrate\":{}}}", bpm),
                    });
                }
                None => warn!("💓 Malformed HR packet: {:?}", data.value),
            }
        }
    }

    warn!("💓 Notification stream ended (device disconnected?)");
    Ok(())
}

fn leading_digit(mut n: u16) -> u16 {
    while n >= 10 { n /= 10; }
    n
}

/// Parse BLE Heart Rate Measurement packet (Bluetooth SIG spec).
/// flags byte bit0: 0 = HR as u8, 1 = HR as u16 LE
fn parse_hr(data: &[u8]) -> Option<u16> {
    let flags = *data.first()?;
    if flags & 0x01 == 0 {
        data.get(1).map(|&v| v as u16)
    } else {
        let lo = *data.get(1)? as u16;
        let hi = *data.get(2)? as u16;
        Some(lo | (hi << 8))
    }
}
