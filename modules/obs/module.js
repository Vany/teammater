/**
 * OBS Module — thin client for the server-side OBS broker.
 *
 * Connects to wss://<host>/obs (server smart bus).
 * Server owns the OBS WebSocket; this module subscribes to state updates
 * and sends commands through the bus.
 *
 * Commands from actions/UI → JSON → /obs bus → server → OBS Studio
 * OBS state                → server → /obs bus → this module → UI
 *
 * Note: refreshSource() requires direct OBS access (multi-step request loop).
 * It is not yet implemented via the bus — logs an error if called.
 */

import { BaseModule } from "../base-module.js";
import { obs_scene } from "../../actions.js";
import { request } from "../../utils.js";

export class OBSModule extends BaseModule {
  constructor() {
    super();

    // OBS state (kept in sync via /obs bus messages)
    this.streaming = false;
    this.recording = false;
    this.recordingPaused = false;
    this.scene = "";
    this.scenes = [];
    this.streamingInfo = null; // {timecode, dropped_frames, total_frames, bitrate_kbps}
    this.recordingInfo = null; // {timecode}

    this.streamIndicator = null;
    this.recordIndicator = null;

    // Frame drop alert state
    this.lastAlertTime = 0;
    this.ALERT_COOLDOWN_MS = 10_000;
    this._prevDropped = 0;
    this._prevTotal = 0;
  }

  getDisplayName() {
    return "OBS Studio";
  }

  getConfig() {
    return {
      connection: {
        url: {
          type: "text",
          label: "OBS WebSocket URL",
          default: "ws://localhost:4455",
          stored_as: "obs_url",
        },
        password: {
          type: "password",
          label: "OBS WebSocket Password",
          default: "",
          required: false,
          stored_as: "obs_password",
        },
      },
      scenes: {
        glasses_scene: {
          type: "text",
          label: "Glasses Scene Name",
          default: "Glasses",
          stored_as: "obs_glasses_scene",
        },
        glasses_source: {
          type: "text",
          label: "Refresh Source Name",
          default: "G",
          stored_as: "obs_glasses_source",
        },
      },
    };
  }

  async initialize(container) {
    await super.initialize(container);

    const header = this.ui.container.querySelector(".module-header");
    const statusIndicator = header.querySelector(".status-indicator");

    this.streamIndicator = document.createElement("span");
    this.streamIndicator.className = "obs-stream-indicator";
    this.streamIndicator.title = "Streaming status";
    this.streamIndicator.textContent = "📡";
    statusIndicator.after(this.streamIndicator);

    this.recordIndicator = document.createElement("span");
    this.recordIndicator.className = "obs-record-indicator";
    this.recordIndicator.title = "Recording status";
    this.recordIndicator.textContent = "⏺️";
    this.streamIndicator.after(this.recordIndicator);

    this.updateCustomIndicators();

    const configPanel = this.ui.container.querySelector(".config-panel");
    const btn = document.createElement("button");
    btn.textContent = "👓 Glasses + Refresh";
    btn.style.marginTop = "8px";
    btn.onclick = () => {
      const scene = this.getConfigValue("glasses_scene", "Glasses");
      const source = this.getConfigValue("glasses_source", "G");
      obs_scene(scene, source)({ obs: this, log: this.log.bind(this) });
    };
    configPanel.appendChild(btn);
  }

  async doConnect() {
    this.shouldReconnect = true;
    const url = `wss://${location.host}/obs`;
    this.log(`📺 Connecting to OBS bus at ${url}...`);

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.updateStatus(true);
        this.log("✅ Connected to OBS bus");
        // Push OBS connection config so server can connect to OBS Studio
        const obsUrl = this.getConfigValue("url", "ws://localhost:4455");
        const obsPassword = this.getConfigValue("password", "");
        this.ws.send(JSON.stringify({ type: "obs_config", url: obsUrl, password: obsPassword }));
        this._startViewerPoll();
      };

      this.ws.onmessage = (event) => {
        this._handleBusMessage(event.data);
      };

      this.ws.onclose = (event) => {
        this.updateStatus(false);
        this.streaming = false;
        this.recording = false;
        this.recordingPaused = false;
        this.updateCustomIndicators();
        if (event.code !== 1000) {
          this.log(`❌ OBS bus disconnected (code: ${event.code})`);
        }
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.log("💥 OBS bus error");
      };

      await this._waitForWebSocket(this.ws);
    } catch (error) {
      this.log(`💥 OBS bus connection failed: ${error.message}`);
      throw error;
    }
  }

  async doDisconnect() {
    this._cleanupReconnect();
    this._stopViewerPoll();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.streaming = false;
    this.recording = false;
    this.recordingPaused = false;
    this.updateCustomIndicators();
    this.log("🔌 Disconnected from OBS bus");
  }

  _startViewerPoll() {
    this._stopViewerPoll();
    this._pollViewerCount();
    this._viewerPollTimer = setInterval(() => this._pollViewerCount(), 60_000);
  }

  _stopViewerPoll() {
    clearInterval(this._viewerPollTimer);
    this._viewerPollTimer = null;
  }

  async _pollViewerCount() {
    const userId = this.moduleManager?.get('twitch-eventsub')?.currentUserId;
    if (!userId) return;
    try {
      const res  = await request(`https://api.twitch.tv/helix/streams?user_id=${userId}`);
      const data = await res.json();
      const count = data?.data?.[0]?.viewer_count ?? null;
      if (count !== null) this.pushViewerCount(count);
    } catch {}
  }

  _handleBusMessage(data) {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "obs_state":
          this._applyState(msg);
          break;
        case "obs_scene":
          this.scene = msg.scene ?? "";
          this.scenes = msg.scenes ?? [];
          break;
        case "obs_streaming":
          this._applyStreaming(msg.streaming);
          break;
        case "obs_recording":
          this._applyRecording(msg.recording);
          break;
        case "twitch_shoutout":
          if (msg.user) this._twitchShoutout(msg.user).catch(e => this.log(`💥 Shoutout: ${e.message}`));
          break;
        case "twitch_timeout":
          if (msg.user) this._twitchTimeout(msg.user, msg.duration ?? 600).catch(e => this.log(`💥 Timeout: ${e.message}`));
          break;
        // heartrate and other bus messages are ignored here
      }
    } catch (e) {
      // ignore malformed messages
    }
  }

  _broadcasterId() {
    return this.moduleManager?.get("twitch-eventsub")?.currentUserId ?? null;
  }

  async _lookupUserId(username) {
    const r = await request(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`);
    const data = await r.json();
    const id = data?.data?.[0]?.id;
    if (!id) throw new Error(`user '${username}' not found`);
    return id;
  }

  async _twitchShoutout(username) {
    const bid = this._broadcasterId();
    if (!bid) throw new Error("broadcaster ID not available");
    const targetId = await this._lookupUserId(username);
    await request(
      `https://api.twitch.tv/helix/chat/shoutouts?from_broadcaster_id=${bid}&to_broadcaster_id=${targetId}&moderator_id=${bid}`,
      { method: "POST" },
    );
    this.log(`📣 Shouted out @${username}`);
  }

  async _twitchTimeout(username, duration) {
    const bid = this._broadcasterId();
    if (!bid) throw new Error("broadcaster ID not available");
    const targetId = await this._lookupUserId(username);
    await request(
      `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${bid}&moderator_id=${bid}`,
      { method: "POST", body: JSON.stringify({ data: { user_id: targetId, duration } }) },
    );
    this.log(`🔇 Timed out @${username} for ${duration}s`);
  }

  _applyState(msg) {
    this.scene = msg.scene ?? "";
    this.scenes = msg.scenes ?? [];
    this._applyStreaming(msg.streaming);
    this._applyRecording(msg.recording);
  }

  _applyStreaming(info) {
    if (!info || !info.active) {
      this.streaming = false;
      this.streamingInfo = null;
      this._prevDropped = 0;
      this._prevTotal = 0;
    } else {
      this.streaming = true;
      this.streamingInfo = info;
      // Alert only on NEW drops in this poll interval — dropped_frames is cumulative.
      const deltaDropped   = info.dropped_frames - this._prevDropped;
      this._prevDropped    = info.dropped_frames;
      this._prevTotal      = info.total_frames;
      // Alert only when new drops are happening AND the cumulative rate is bad (>1%).
      // Cumulative rate smooths out accidental single drops; deltaDropped ensures
      // the stream is actively degrading right now, not just has a history of drops.
      const cumulativeRate = info.total_frames > 0
        ? (info.dropped_frames / info.total_frames) * 100 : 0;
      if (deltaDropped > 0 && cumulativeRate > 1) {
        this._alertFrameDrops(deltaDropped, info.dropped_frames, info.total_frames);
      }
    }
    this.updateCustomIndicators();
  }

  _applyRecording(info) {
    if (!info || !info.active) {
      this.recording = false;
      this.recordingPaused = false;
      this.recordingInfo = null;
    } else {
      this.recording = true;
      this.recordingPaused = info.paused;
      this.recordingInfo = info;
    }
    this.updateCustomIndicators();
  }

  // ──────────────────── command API ────────────────────

  _sendCmd(type, extra = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...extra }));
    }
  }

  /** Forward a log line to mobile clients via the bus. */
  forwardLog(text) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "log", text, ts: Date.now() }));
    }
  }

  /** Push current viewer count to mobile clients. */
  pushViewerCount(count) {
    this._sendCmd("viewer_count", { count });
  }

  switchScene(scene) {
    this._sendCmd("cmd_switch_scene", { scene });
    this.log(`📺 Switching scene → ${scene}`);
  }

  startRecord() {
    this._sendCmd("cmd_start_record");
    this.log("⏺️ Starting recording...");
  }

  stopRecord() {
    this._sendCmd("cmd_stop_record");
    this.log("⏺️ Stopping recording...");
  }

  pauseRecord() {
    this._sendCmd("cmd_pause_record");
    this.log("⏸️ Pausing recording...");
  }

  resumeRecord() {
    this._sendCmd("cmd_resume_record");
    this.log("⏺️ Resuming recording...");
  }

  toggleRecordPause() {
    if (this.recordingPaused) this.resumeRecord();
    else this.pauseRecord();
  }

  /** Not supported via bus — requires direct OBS multi-step request. */
  async refreshSource(sourceName) {
    this.log(`❌ refreshSource("${sourceName}") requires direct OBS access — not available via bus`);
  }

  // These are kept for action compatibility but stream control is desktop-only
  startStream() { this.log("⚠️ startStream: stream control not exposed via mobile bus"); }
  stopStream() { this.log("⚠️ stopStream: stream control not exposed via mobile bus"); }
  toggleStream() { this.log("⚠️ toggleStream: stream control not exposed via mobile bus"); }
  toggleRecord() {
    if (this.recording) this.stopRecord();
    else this.startRecord();
  }

  // ──────────────────── read-only state ────────────────────

  isStreaming() { return this.streaming; }
  isRecording() { return this.recording; }
  isRecordingPaused() { return this.recordingPaused; }

  getDroppedFrames() {
    const info = this.streamingInfo;
    if (!info) return { dropped: 0, total: 0, rate: 0 };
    const rate = info.total_frames > 0 ? (info.dropped_frames / info.total_frames) * 100 : 0;
    return { dropped: info.dropped_frames, total: info.total_frames, rate };
  }

  getContextContribution() {
    return { obs: this };
  }

  // ──────────────────── indicators ────────────────────

  updateCustomIndicators() {
    if (this.streamIndicator) {
      if (!this.connected) {
        this.streamIndicator.className = "obs-stream-indicator obs-disconnected";
        this.streamIndicator.title = "Not connected";
      } else if (this.streaming) {
        const { rate, dropped } = this.getDroppedFrames();
        if (rate > 1) {
          this.streamIndicator.className = "obs-stream-indicator obs-warning";
          this.streamIndicator.title = `Streaming (${dropped} dropped, ${rate.toFixed(1)}%)`;
        } else {
          this.streamIndicator.className = "obs-stream-indicator obs-active";
          this.streamIndicator.title = `Streaming (${dropped} dropped)`;
        }
      } else {
        this.streamIndicator.className = "obs-stream-indicator obs-inactive";
        this.streamIndicator.title = "Not streaming";
      }
      this.streamIndicator.textContent = "📡";
    }

    if (this.recordIndicator) {
      if (!this.connected) {
        this.recordIndicator.className = "obs-record-indicator obs-disconnected";
        this.recordIndicator.textContent = "⏺️";
        this.recordIndicator.title = "Not connected";
      } else if (this.recording) {
        if (this.recordingPaused) {
          this.recordIndicator.className = "obs-record-indicator obs-paused";
          this.recordIndicator.textContent = "⏸️";
          this.recordIndicator.title = "Recording paused";
        } else {
          this.recordIndicator.className = "obs-record-indicator obs-active";
          this.recordIndicator.textContent = "⏺️";
          this.recordIndicator.title = "Recording";
        }
      } else {
        this.recordIndicator.className = "obs-record-indicator obs-inactive";
        this.recordIndicator.textContent = "⏹️";
        this.recordIndicator.title = "Not recording";
      }
    }
  }

  _alertFrameDrops(deltaDropped, totalDropped, totalFrames) {
    const now = Date.now();
    if (now - this.lastAlertTime < this.ALERT_COOLDOWN_MS) return;
    this.lastAlertTime = now;
    const cumulativeRate = totalFrames > 0 ? (totalDropped / totalFrames * 100).toFixed(1) : "?";
    this.log(`⚠️ Stream: ${deltaDropped} new dropped frames (cumulative: ${totalDropped}, ${cumulativeRate}%)`);
    if (window.mp3) window.mp3("startup", 0.2);
  }
}
