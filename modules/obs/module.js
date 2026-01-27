/**
 * OBS WebSocket Module
 *
 * WebSocket connector for OBS Studio via obs-websocket plugin.
 *
 * Features:
 * - Connection status indicator (red/green dot)
 * - Streaming status with dropped frames indicator
 * - Recording status with pause indicator
 * - Auto-reconnection
 * - OBS WebSocket 5.x protocol support
 *
 * Widget indicators:
 * - Connection: red/green dot
 * - Streaming: wifi icon (green=streaming, red=not, yellow=frame drops)
 * - Recording: record icon (red=recording, gray=stopped, pause icon if paused)
 */

import { BaseModule } from "../base-module.js";

export class OBSModule extends BaseModule {
  constructor() {
    super();
    this.statusPollTimer = null;

    // OBS state
    this.streaming = false;
    this.recording = false;
    this.recordingPaused = false;
    this.droppedFrames = 0;
    this.totalFrames = 0;
    this.lastDroppedFrames = 0;

    // UI elements for custom indicators
    this.streamIndicator = null;
    this.recordIndicator = null;

    // Frame drop alert state
    this.lastAlertTime = 0;
    this.ALERT_COOLDOWN_MS = 10000; // 10 seconds between alerts
  }

  getDisplayName() {
    return "OBS Studio";
  }

  getConfig() {
    return {
      connection: {
        url: {
          type: "text",
          label: "WebSocket URL",
          default: "ws://localhost:4455",
          stored_as: "obs_url",
        },
        password: {
          type: "text",
          label: "Password",
          default: "gRJNA8RKuZMJUOjm",
          stored_as: "obs_password",
        },
        reconnect_delay: {
          type: "number",
          label: "Reconnect Delay (ms)",
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
          stored_as: "obs_reconnect_delay",
        },
        poll_interval: {
          type: "number",
          label: "Status Poll Interval (ms)",
          default: 2000,
          min: 500,
          max: 10000,
          step: 500,
          stored_as: "obs_poll_interval",
        },
      },
    };
  }

  /**
   * Override initialize to add custom status indicators
   */
  async initialize(container) {
    await super.initialize(container);

    // Add custom indicators to header (after status dot)
    const header = this.ui.container.querySelector(".module-header");
    const statusIndicator = header.querySelector(".status-indicator");

    // Create streaming indicator
    this.streamIndicator = document.createElement("span");
    this.streamIndicator.className = "obs-stream-indicator";
    this.streamIndicator.title = "Streaming status";
    this.streamIndicator.textContent = "📡";
    statusIndicator.after(this.streamIndicator);

    // Create recording indicator
    this.recordIndicator = document.createElement("span");
    this.recordIndicator.className = "obs-record-indicator";
    this.recordIndicator.title = "Recording status";
    this.recordIndicator.textContent = "⏺️";
    this.streamIndicator.after(this.recordIndicator);

    // Initial indicator state
    this.updateCustomIndicators();
  }

  /**
   * Update streaming and recording indicators
   */
  updateCustomIndicators() {
    // Streaming indicator
    if (this.streamIndicator) {
      if (!this.connected) {
        this.streamIndicator.className =
          "obs-stream-indicator obs-disconnected";
        this.streamIndicator.textContent = "📡";
        this.streamIndicator.title = "Not connected";
      } else if (this.streaming) {
        // Check for frame drops (>1% drop rate is concerning)
        const dropRate =
          this.totalFrames > 0
            ? (this.droppedFrames / this.totalFrames) * 100
            : 0;
        const recentDrops = this.droppedFrames - this.lastDroppedFrames;

        if (recentDrops > 10 || dropRate > 1) {
          this.streamIndicator.className = "obs-stream-indicator obs-warning";
          this.streamIndicator.title = `Streaming (${this.droppedFrames} dropped frames, ${dropRate.toFixed(1)}%)`;
        } else {
          this.streamIndicator.className = "obs-stream-indicator obs-active";
          this.streamIndicator.title = `Streaming (${this.droppedFrames} dropped)`;
        }
        this.streamIndicator.textContent = "📡";
      } else {
        this.streamIndicator.className = "obs-stream-indicator obs-inactive";
        this.streamIndicator.textContent = "📡";
        this.streamIndicator.title = "Not streaming";
      }
    }

    // Recording indicator
    if (this.recordIndicator) {
      if (!this.connected) {
        this.recordIndicator.className =
          "obs-record-indicator obs-disconnected";
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

  async doConnect() {
    const urlConfig = this.getConfigValue("url", "ws://localhost:4455");
    const password = this.getConfigValue("password", "gRJNA8RKuZMJUOjm");
    this.shouldReconnect = true;

    // Parse URL - support ws://login:password@ip:port format
    let url = urlConfig;
    this.authPassword = password;

    try {
      const parsed = new URL(urlConfig);
      if (parsed.password) {
        this.authPassword = parsed.password;
        parsed.password = "";
        parsed.username = "";
        url = parsed.toString();
      }
    } catch (e) {
      // Keep original URL if parsing fails
    }

    this.log(`📺 Connecting to OBS at ${url}...`);

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.log("📺 WebSocket connected, waiting for Hello...");
        // OBS WebSocket 5.x sends Hello first, then we respond with Identify
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };

      this.ws.onclose = (event) => {
        this.updateStatus(false);
        this.streaming = false;
        this.recording = false;
        this.recordingPaused = false;
        this.updateCustomIndicators();
        this._stopStatusPolling();

        if (event.code === 1006) {
          this.log("❌ OBS connection failed - check OBS is running");
        } else {
          this.log(`❌ OBS connection closed (code: ${event.code})`);
        }

        // Auto-reconnect using shared helper
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.log("💥 OBS WebSocket error");
      };

      await this._waitForWebSocket(this.ws);
    } catch (error) {
      this.log(`💥 OBS connection failed: ${error.message}`);
      throw error;
    }
  }

  async doDisconnect() {
    this._stopStatusPolling();

    // Cleanup using shared helper
    this._cleanupReconnect();
    this.log("🔌 Disconnected from OBS");

    this.streaming = false;
    this.recording = false;
    this.recordingPaused = false;
    this.updateCustomIndicators();
  }

  /**
   * Handle incoming OBS WebSocket messages
   */
  _handleMessage(data) {
    try {
      const msg = JSON.parse(data);

      switch (msg.op) {
        case 0: // Hello
          this._handleHello(msg.d);
          break;
        case 2: // Identified
          this._handleIdentified(msg.d);
          break;
        case 5: // Event
          this._handleEvent(msg.d);
          break;
        case 7: // RequestResponse
          this._handleRequestResponse(msg.d);
          break;
      }
    } catch (e) {
      this.log(`💥 Failed to parse OBS message: ${e.message}`);
    }
  }

  /**
   * Handle Hello message (authentication)
   */
  async _handleHello(data) {
    this.log("📺 Received Hello, sending Identify...");

    if (data.authentication) {
      // Need to authenticate
      const { challenge, salt } = data.authentication;
      const auth = await this._generateAuth(this.authPassword, salt, challenge);

      const identifyMsg = {
        op: 1,
        d: {
          rpcVersion: 1,
          authentication: auth,
        },
      };
      this.ws.send(JSON.stringify(identifyMsg));
    } else {
      // No auth required
      const identifyMsg = {
        op: 1,
        d: {
          rpcVersion: 1,
        },
      };
      this.ws.send(JSON.stringify(identifyMsg));
    }
  }

  /**
   * Generate authentication string for OBS WebSocket 5.x
   */
  async _generateAuth(password, salt, challenge) {
    const encoder = new TextEncoder();

    // base64(sha256(password + salt))
    const secretHash = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(password + salt),
    );
    const secretBase64 = btoa(
      String.fromCharCode(...new Uint8Array(secretHash)),
    );

    // base64(sha256(secret + challenge))
    const authHash = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(secretBase64 + challenge),
    );
    const authBase64 = btoa(String.fromCharCode(...new Uint8Array(authHash)));

    return authBase64;
  }

  /**
   * Handle Identified message (connected successfully)
   */
  _handleIdentified(data) {
    this.updateStatus(true);
    this.log("✅ Connected to OBS Studio");

    // Get initial status
    this._requestStatus();

    // Start polling for status updates
    this._startStatusPolling();
  }

  /**
   * Handle OBS events
   */
  _handleEvent(data) {
    const { eventType, eventData } = data;

    switch (eventType) {
      case "StreamStateChanged":
        this.streaming = eventData.outputActive;
        this.log(`📺 Stream ${this.streaming ? "started" : "stopped"}`);
        if (!this.streaming) {
          this.droppedFrames = 0;
          this.totalFrames = 0;
        }
        this.updateCustomIndicators();
        break;

      case "RecordStateChanged":
        this.recording = eventData.outputActive;
        this.recordingPaused =
          eventData.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED";
        this.log(
          `⏺️ Recording ${this.recording ? (this.recordingPaused ? "paused" : "started") : "stopped"}`,
        );
        this.updateCustomIndicators();
        break;
    }
  }

  /**
   * Handle request responses
   */
  _handleRequestResponse(data) {
    const { requestId, requestStatus, responseData } = data;

    if (!requestStatus.result) {
      return;
    }

    if (requestId === "GetStreamStatus") {
      this.streaming = responseData.outputActive;
      if (this.streaming) {
        const prevDropped = this.droppedFrames;
        this.lastDroppedFrames = this.droppedFrames;
        this.droppedFrames = responseData.outputSkippedFrames || 0;
        this.totalFrames = responseData.outputTotalFrames || 0;

        // Check for frame drop increase and alert
        const newDrops = this.droppedFrames - prevDropped;
        if (newDrops > 0) {
          this._alertFrameDrops(newDrops);
        }
      }
      this.updateCustomIndicators();
    } else if (requestId === "GetRecordStatus") {
      this.recording = responseData.outputActive;
      this.recordingPaused = responseData.outputPaused || false;
      this.updateCustomIndicators();
    }
  }

  /**
   * Request current OBS status
   */
  _requestStatus() {
    this._sendRequest("GetStreamStatus");
    this._sendRequest("GetRecordStatus");
  }

  /**
   * Send a request to OBS
   */
  _sendRequest(requestType, requestData = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      op: 6,
      d: {
        requestType,
        requestId: requestType,
        requestData,
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Start polling for status updates
   */
  _startStatusPolling() {
    this._stopStatusPolling();
    const interval = parseInt(this.getConfigValue("poll_interval", "2000"));
    this.statusPollTimer = setInterval(() => this._requestStatus(), interval);
  }

  /**
   * Stop status polling
   */
  _stopStatusPolling() {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  /**
   * Alert when frame drops are detected (with cooldown)
   */
  _alertFrameDrops(newDrops) {
    const now = Date.now();
    if (now - this.lastAlertTime < this.ALERT_COOLDOWN_MS) {
      return; // Still in cooldown
    }

    this.lastAlertTime = now;
    this.log(
      `⚠️ Stream unhealthy: ${newDrops} new dropped frames (total: ${this.droppedFrames})`,
    );

    // Play alert sound using global mp3 function
    if (window.mp3) {
      window.mp3("startup", 0.2);
    }
  }

  // Public API methods

  /**
   * Start streaming
   */
  startStream() {
    this._sendRequest("StartStream");
    this.log("📺 Starting stream...");
  }

  /**
   * Stop streaming
   */
  stopStream() {
    this._sendRequest("StopStream");
    this.log("📺 Stopping stream...");
  }

  /**
   * Toggle streaming
   */
  toggleStream() {
    this._sendRequest("ToggleStream");
  }

  /**
   * Start recording
   */
  startRecord() {
    this._sendRequest("StartRecord");
    this.log("⏺️ Starting recording...");
  }

  /**
   * Stop recording
   */
  stopRecord() {
    this._sendRequest("StopRecord");
    this.log("⏺️ Stopping recording...");
  }

  /**
   * Toggle recording
   */
  toggleRecord() {
    this._sendRequest("ToggleRecord");
  }

  /**
   * Pause recording
   */
  pauseRecord() {
    this._sendRequest("PauseRecord");
    this.log("⏸️ Pausing recording...");
  }

  /**
   * Resume recording
   */
  resumeRecord() {
    this._sendRequest("ResumeRecord");
    this.log("⏺️ Resuming recording...");
  }

  /**
   * Toggle recording pause
   */
  toggleRecordPause() {
    this._sendRequest("ToggleRecordPause");
  }

  /**
   * Get streaming status
   */
  isStreaming() {
    return this.streaming;
  }

  /**
   * Get recording status
   */
  isRecording() {
    return this.recording;
  }

  /**
   * Get recording paused status
   */
  isRecordingPaused() {
    return this.recordingPaused;
  }

  /**
   * Get dropped frames info
   */
  getDroppedFrames() {
    return {
      dropped: this.droppedFrames,
      total: this.totalFrames,
      rate:
        this.totalFrames > 0
          ? (this.droppedFrames / this.totalFrames) * 100
          : 0,
    };
  }

  getContextContribution() {
    if (!this.isConnected()) {
      return { obs: null };
    }

    return {
      obs: {
        isConnected: () => this.isConnected(),
        isStreaming: () => this.isStreaming(),
        isRecording: () => this.isRecording(),
        isRecordingPaused: () => this.isRecordingPaused(),
        getDroppedFrames: () => this.getDroppedFrames(),
        startStream: () => this.startStream(),
        stopStream: () => this.stopStream(),
        toggleStream: () => this.toggleStream(),
        startRecord: () => this.startRecord(),
        stopRecord: () => this.stopRecord(),
        toggleRecord: () => this.toggleRecord(),
        pauseRecord: () => this.pauseRecord(),
        resumeRecord: () => this.resumeRecord(),
        toggleRecordPause: () => this.toggleRecordPause(),
      },
    };
  }
}
