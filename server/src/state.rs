//! Shared state handed to every request/task: the `/obs` broadcast channel,
//! the live OBS session state, and the small per-run caches that let a
//! reconnecting client be caught up immediately instead of waiting for the
//! next slow sensor tick. Split out of `main.rs`.

use crate::{echowire, obs, obs::ObsConfig, security::load_or_create_bus_token};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{broadcast, mpsc, watch, RwLock};

const OBS_BROADCAST_CAPACITY: usize = 16;
pub const LOG_RING_SIZE: usize = 5;

// ─────────────────────────────────────────────────── bus types ──

/// Broadcast envelope — `sender_id` == `u64::MAX` means server-originated (all clients receive).
#[derive(Clone, Debug)]
pub struct ObsMessage {
    pub sender_id: u64,
    pub text: String,
}

// ─────────────────────────────────────────────── shared state ──

pub struct AppState {
    pub echowire: Arc<echowire::EchoWireState>,
    pub obs_broadcast: broadcast::Sender<ObsMessage>,
    obs_client_counter: AtomicU64,
    pub obs_state: Arc<RwLock<obs::SharedObsState>>,
    pub obs_cmd_tx: mpsc::Sender<obs::ObsCommand>,
    pub obs_config_tx: watch::Sender<ObsConfig>,
    pub log_ring: Mutex<VecDeque<String>>,
    pub last_sysinfo: Mutex<Option<String>>,
    pub last_now_playing: Mutex<Option<String>>,
    pub last_climate: Mutex<Option<String>>,
    /// Latest `friends_present`, replayed to new clients like the sensors above.
    /// Presence changes only on JOIN/PART/first message, which on a quiet
    /// channel can be an hour apart — a phone opened mid-stream would otherwise
    /// show an empty friends widget while three friends were watching.
    pub last_friends: Mutex<Option<String>>,
    pub lan_ip: String,
    /// Shared secret required to open /obs. The bus is not a read-only feed:
    /// it carries `twitch_timeout`, `twitch_shoutout` and cmd_* record/scene
    /// commands that the main page executes with the streamer's moderator
    /// token. Both listeners bind 0.0.0.0 and the QR workflow deliberately
    /// invites household devices onto the network, so an unauthenticated bus
    /// let any of them ban viewers as the streamer.
    pub bus_token: String,
}

impl AppState {
    pub fn new(
        lan_ip: String,
    ) -> (
        Self,
        mpsc::Receiver<obs::ObsCommand>,
        watch::Receiver<ObsConfig>,
    ) {
        let (obs_tx, _) = broadcast::channel(OBS_BROADCAST_CAPACITY);
        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (cfg_tx, cfg_rx) = watch::channel(ObsConfig::default());
        let state = Self {
            echowire: echowire::EchoWireState::new(),
            obs_broadcast: obs_tx,
            obs_client_counter: AtomicU64::new(0),
            obs_state: Arc::new(RwLock::new(obs::SharedObsState::default())),
            obs_cmd_tx: cmd_tx,
            obs_config_tx: cfg_tx,
            log_ring: Mutex::new(VecDeque::with_capacity(LOG_RING_SIZE + 1)),
            last_sysinfo: Mutex::new(None),
            last_now_playing: Mutex::new(None),
            last_climate: Mutex::new(None),
            last_friends: Mutex::new(None),
            lan_ip,
            bus_token: load_or_create_bus_token(),
        };
        (state, cmd_rx, cfg_rx)
    }

    pub fn next_client_id(&self) -> u64 {
        self.obs_client_counter.fetch_add(1, Ordering::Relaxed)
    }
}
