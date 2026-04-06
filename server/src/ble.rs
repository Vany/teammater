use btleplug::api::{bleuuid::uuid_from_u16, Central, CentralEvent, Manager as _, Peripheral as _};
use btleplug::platform::Manager;
use futures_util::StreamExt;
use std::time::Duration;
use tokio::sync::broadcast;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::ObsMessage;

const DEVICE_NAME: &str = "HeartCast";
const RECONNECT_DELAY: Duration = Duration::from_secs(5);
const SCAN_WINDOW: Duration = Duration::from_secs(5);
/// If no HR packet arrives for this long, assume device is gone and reconnect.
const HR_WATCHDOG: Duration = Duration::from_secs(10);

// BLE Heart Rate Service (0x180D) / Heart Rate Measurement characteristic (0x2A37)
fn hr_char_uuid() -> Uuid {
    uuid_from_u16(0x2A37)
}

pub async fn ble_task(tx: broadcast::Sender<ObsMessage>) {
    // Manager must stay alive for the duration — it owns the CoreBluetooth event loop.
    // Init once, retry until success; never reinitialize after that.
    let (_manager, adapter) = loop {
        match init_adapter().await {
            Ok(pair) => break pair,
            Err(e) => {
                error!("💓 BLE init failed: {e}, retrying in {RECONNECT_DELAY:?}");
                tokio::time::sleep(RECONNECT_DELAY).await;
            }
        }
    };
    info!("💓 BLE adapter ready");

    loop {
        match run_ble(&tx, &adapter).await {
            Ok(()) => warn!("💓 BLE session ended, reconnecting..."),
            Err(e) => error!("💓 BLE error: {e}, retrying in {RECONNECT_DELAY:?}"),
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

/// Returns (Manager, Adapter). Manager must be kept alive — dropping it kills
/// the CoreBluetooth background event loop and silently breaks all BLE operations.
async fn init_adapter() -> anyhow::Result<(Manager, btleplug::platform::Adapter)> {
    let manager = Manager::new().await?;
    let adapter = manager
        .adapters()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No BLE adapter found"))?;
    Ok((manager, adapter))
}

async fn run_ble(
    tx: &broadcast::Sender<ObsMessage>,
    adapter: &btleplug::platform::Adapter,
) -> anyhow::Result<()> {
    let peripheral = scan_until_found(adapter).await;
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
    info!(
        "💓 Subscribed to Heart Rate Measurement (char uuid={})",
        hr_uuid
    );

    let peripheral_id = peripheral.id();
    // Subscribe to adapter events BEFORE subscribing to notifications to avoid
    // missing a DeviceDisconnected event in the window between connect and subscribe.
    let mut adapter_events = adapter.events().await?;
    let mut notifs = peripheral.notifications().await?;
    let mut last_zero: Option<bool> = None;

    // Watchdog: reset on every HR packet. Fires if the device silently disappears
    // without sending DeviceDisconnected or closing the notification stream.
    let watchdog = tokio::time::sleep(HR_WATCHDOG);
    tokio::pin!(watchdog);

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
                            // Reset watchdog — we're alive.
                            watchdog.as_mut().reset(tokio::time::Instant::now() + HR_WATCHDOG);
                            let is_zero = bpm == 0;
                            if last_zero != Some(is_zero) {
                                info!("💓 Heart Rate: {} bpm", bpm);
                                last_zero = Some(is_zero);
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
            _ = &mut watchdog => {
                warn!("💓 No HR data for {HR_WATCHDOG:?}, assuming device gone");
                break;
            }
        }
    }

    // Best-effort disconnect — CoreBluetooth may have already killed the event loop,
    // so this can hang indefinitely. Cap at 2s to avoid blocking the retry loop.
    let _ = tokio::time::timeout(Duration::from_secs(2), peripheral.disconnect()).await;
    Ok(())
}

/// Scan in SCAN_WINDOW bursts until DEVICE_NAME is found. Never returns an error —
/// all transient failures (adapter not ready after disconnect, stream errors) are
/// retried internally with RECONNECT_DELAY.
async fn scan_until_found(adapter: &btleplug::platform::Adapter) -> btleplug::platform::Peripheral {
    info!("💓 Scanning for '{DEVICE_NAME}'...");
    loop {
        // Subscribe BEFORE start_scan to avoid missing early advertisements.
        let mut events = match adapter.events().await {
            Ok(e) => e,
            Err(e) => {
                warn!("💓 Adapter events error: {e}, retrying...");
                tokio::time::sleep(RECONNECT_DELAY).await;
                continue;
            }
        };

        if let Err(e) = adapter.start_scan(Default::default()).await {
            warn!("💓 start_scan failed: {e}, retrying...");
            tokio::time::sleep(RECONNECT_DELAY).await;
            continue;
        }

        let found = tokio::time::timeout(SCAN_WINDOW, async {
            loop {
                match events.next().await {
                    None => return None,
                    Some(CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id)) => {
                        let Ok(p) = adapter.peripheral(&id).await else { continue };
                        let name = p.properties().await.ok()
                            .flatten()
                            .and_then(|pr| pr.local_name);
                        if name.as_deref().is_some_and(|n| n.contains(DEVICE_NAME)) {
                            info!("💓 Found: {}", name.unwrap());
                            return Some(p);
                        }
                    }
                    _ => {}
                }
            }
        })
        .await;

        let _ = adapter.stop_scan().await;

        match found {
            Ok(Some(p)) => return p,
            Ok(None) => warn!("💓 Event stream ended, retrying..."),
            Err(_) => {} // timeout — device not seen yet, keep scanning silently
        }
    }
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
