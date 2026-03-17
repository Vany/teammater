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
const SCAN_WINDOW: Duration = Duration::from_secs(5);

// BLE Heart Rate Service (0x180D) / Heart Rate Measurement characteristic (0x2A37)
fn hr_char_uuid() -> Uuid {
    uuid_from_u16(0x2A37)
}

pub async fn ble_task(tx: broadcast::Sender<ObsMessage>) {
    // Manager and adapter created once — CoreBluetooth doesn't like reinitialization
    let manager = match Manager::new().await {
        Ok(m) => m,
        Err(e) => { error!("💓 BLE manager init failed: {e}"); return; }
    };
    let adapter = match manager.adapters().await {
        Ok(a) => match a.into_iter().next() {
            Some(a) => a,
            None => { error!("💓 No BLE adapter found"); return; }
        },
        Err(e) => { error!("💓 BLE adapters error: {e}"); return; }
    };

    loop {
        match run_ble(&tx, &adapter).await {
            Ok(()) => warn!("💓 BLE session ended, reconnecting..."),
            Err(e) => error!("💓 BLE error: {e}, retrying in {RECONNECT_DELAY:?}"),
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

async fn run_ble(tx: &broadcast::Sender<ObsMessage>, adapter: &btleplug::platform::Adapter) -> anyhow::Result<()> {
    let peripheral = scan_until_found(adapter).await?;
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
    info!("💓 Subscribed to Heart Rate Measurement (char uuid={})", hr_uuid);

    let peripheral_id = peripheral.id();
    // Subscribe to adapter events BEFORE subscribing to notifications to avoid
    // missing a DeviceDisconnected event in the window between connect and subscribe.
    let mut adapter_events = adapter.events().await?;
    let mut notifs = peripheral.notifications().await?;
    let mut last_leading: Option<u16> = None;

    loop {
        tokio::select! {
            maybe = notifs.next() => {
                let Some(data) = maybe else {
                    warn!("💓 Notification stream ended");
                    break;
                };
                if data.uuid == hr_uuid {
                    match parse_hr(&data.value) {
                        Some(bpm) => {
                            let leading = leading_digit(bpm);
                            if last_leading != Some(leading) {
                                info!("💓 Heart Rate: {} bpm", bpm);
                                last_leading = Some(leading);
                            }
                            let _ = tx.send(ObsMessage {
                                sender_id: u64::MAX,
                                text: format!("{{\"heartrate\":{}}}", bpm),
                            });
                        }
                        None => warn!("💓 Malformed HR packet: {:?}", data.value),
                    }
                } else {
                    info!("💓 Notification uuid={} value={:?}", data.uuid, data.value);
                }
            }
            maybe = adapter_events.next() => {
                match maybe {
                    None => {
                        warn!("💓 Adapter event stream ended");
                        break;
                    }
                    Some(CentralEvent::DeviceDisconnected(id)) if id == peripheral_id => {
                        warn!("💓 Device disconnected");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    // Explicit disconnect ensures clean state for next reconnect attempt.
    let _ = peripheral.disconnect().await;
    Ok(())
}

/// Scan in SCAN_WINDOW bursts until DEVICE_NAME is found.
async fn scan_until_found(adapter: &btleplug::platform::Adapter) -> anyhow::Result<btleplug::platform::Peripheral> {
    loop {
        // Subscribe BEFORE start_scan to avoid missing early advertisements
        let mut events = adapter.events().await?;

        info!("💓 Scanning for '{DEVICE_NAME}' ({SCAN_WINDOW:?} window)...");
        adapter.start_scan(Default::default()).await?;

        let found: Result<anyhow::Result<_>, _> = tokio::time::timeout(SCAN_WINDOW, async {
            loop {
                match events.next().await {
                    None => anyhow::bail!("BLE event stream ended"),
                    Some(CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id)) => {
                        let p = adapter.peripheral(&id).await?;
                        let name = p.properties().await?.and_then(|pr| pr.local_name);
                        if name.as_deref().map(|n| n.contains(DEVICE_NAME)).unwrap_or(false) {
                            info!("💓 Found: {}", name.unwrap());
                            return Ok(p);
                        }
                    }
                    _ => {}
                }
            }
        })
        .await;

        let _ = adapter.stop_scan().await;

        match found {
            Ok(Ok(p)) => return Ok(p),
            Ok(Err(e)) => return Err(e),
            Err(_) => warn!("💓 Not found in {SCAN_WINDOW:?}, retrying..."),
        }
    }
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
