/**
 * Minecraft Module (Minaret)
 *
 * WebSocket connector for local Minecraft server via Minaret plugin.
 *
 * Features:
 * - Send chat messages to Minecraft
 * - Execute game commands
 * - Auto-reconnection
 * - WebSocket lifecycle management
 *
 * Based on MinecraftConnector from connectors.js
 */

import { BaseModule } from "../base-module.js";

export class MinecraftModule extends BaseModule {
  constructor() {
    super();
    this._commandLog = []; // accumulates before control panel opens
    this._controlLog = null; // live DOM element when panel is open
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "🎮 Minaret";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      connection: {
        url: {
          type: "text",
          label: "WebSocket URL",
          default: "ws://localhost:8765",
          stored_as: "minaret_url",
        },
        reconnect_delay: {
          type: "number",
          label: "Reconnect Delay (ms)",
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
          stored_as: "minaret_reconnect_delay",
        },
      },
      minecraft: {
        username: {
          type: "text",
          label: "Minecraft Username",
          default: "vany_serezhkin",
          stored_as: "minecraft_username",
        },
      },
    };
  }

  /**
   * Connect to Minecraft server
   */
  async doConnect() {
    const url = this.getConfigValue("url", "ws://localhost:8765");
    this.shouldReconnect = true;

    this.log(`🎮 Connecting to Minecraft at ${url}...`);

    try {
      this.ws = new WebSocket(url);

      // Setup event handlers
      this.ws.onopen = () => {
        this.updateStatus(true);
        this.log(`✅ Connected to Minecraft at ${url}`);
      };

      this.ws.onmessage = (event) => {
        this.log(`📨 Minecraft: ${event.data}`);
        // Show non-chat server responses in control panel
        try {
          const msg = JSON.parse(event.data);
          // filter chat responses (type: "message") and outgoing chat echoes
          if (msg.type !== "message" && !msg.chat) this._logCommand("in", event.data);
        } catch {
          this._logCommand("in", event.data);
        }
      };

      this.ws.onclose = (event) => {
        this.updateStatus(false);

        if (event.code === 1006) {
          this.log("❌ Connection failed - check server status");
        } else {
          this.log(`❌ Connection closed (code: ${event.code})`);
        }

        // Auto-reconnect using shared helper
        this._scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        this.log("💥 WebSocket error - connection may have failed");
      };

      // Wait for connection to establish
      await this._waitForWebSocket(this.ws);
    } catch (error) {
      this.log(`💥 Connection failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from Minecraft server
   */
  async doDisconnect() {
    // Cleanup using shared helper
    this._cleanupReconnect();
    this.log("🔌 Disconnected from Minecraft");
  }

  /**
   * Send chat message to Minecraft server
   */
  sendMessage(user, message) {
    if (!this.isConnected() || !this.ws) {
      this.log("💥 Not connected to Minecraft!");
      return false;
    }

    try {
      this.ws.send(
        JSON.stringify({
          message: message,
          user: user,
          chat: "T",
        }),
      );
      return true;
    } catch (error) {
      this.log(`💥 Send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send game command to Minecraft server
   */
  sendCommand(command) {
    if (!this.isConnected() || !this.ws || !command) {
      this.log("💥 Not connected to Minecraft!");
      return false;
    }

    try {
      this.ws.send(JSON.stringify({ command }));
      this.log(`📤 Sent command: ${command}`);
      this._logCommand("out", command);
      return true;
    } catch (error) {
      this.log(`💥 Send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get WebSocket instance (for direct access if needed)
   */
  getWebSocket() {
    return this.ws;
  }

  /**
   * This module has a control panel (command console)
   */
  hasControlPanel() {
    return true;
  }

  /**
   * Render control panel: command log + send input
   */
  renderControlPanel() {
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "8px";

    // Log list
    const log = document.createElement("div");
    log.style.cssText =
      "height:260px;overflow-y:auto;background:#111;border:1px solid #333;border-radius:4px;padding:6px;font-family:monospace;font-size:12px;display:flex;flex-direction:column;gap:2px;";
    this._controlLog = log;

    // Replay existing log entries
    for (const entry of this._commandLog) {
      log.appendChild(this._makeLogEntry(entry.dir, entry.text));
    }
    log.scrollTop = log.scrollHeight;

    // Input row
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "command…";
    input.style.cssText = "flex:1;font-family:monospace;font-size:13px;";

    const send = () => {
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = "";
      this.sendCommand(cmd);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });

    const btn = document.createElement("button");
    btn.textContent = "Send";
    btn.addEventListener("click", send);

    row.appendChild(input);
    row.appendChild(btn);

    container.appendChild(log);
    container.appendChild(row);

    return container;
  }

  /** Build a single log line element */
  _makeLogEntry(dir, text) {
    const el = document.createElement("div");
    el.style.color = dir === "out" ? "#7cf" : "#cf7";
    el.textContent = `${dir === "out" ? "▶" : "◀"} ${text}`;
    return el;
  }

  /** Append entry to in-memory log and live panel (if open) */
  _logCommand(dir, text) {
    if (!this._commandLog) this._commandLog = [];
    this._commandLog.push({ dir, text });
    if (this._controlLog) {
      this._controlLog.appendChild(this._makeLogEntry(dir, text));
      this._controlLog.scrollTop = this._controlLog.scrollHeight;
    }
  }

  /**
   * Provide context for actions
   * Returns module reference - actions access methods directly
   */
  getContextContribution() {
    return {
      minecraft: this,
      // Legacy flat helpers for actions
      sendMessageMinaret: (msg) => this.sendMessage("", msg),
      sendCommandMinaret: (cmd) => this.sendCommand(cmd),
    };
  }
}
