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
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "🎮 Minecraft (Minaret)";
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
      this.ws.send(`{"command": "${command}"}`);
      this.log(`📤 Sent command: ${command}`);
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
   * Provide context for actions
   * Always provides functions (they handle disconnected state internally)
   */
  getContextContribution() {
    return {
      minecraft: {
        sendMessage: this.sendMessage.bind(this),
        sendCommand: this.sendCommand.bind(this),
        getWebSocket: this.getWebSocket.bind(this),
        isConnected: () => this.isConnected(),
      },
      minaret: this.ws, // Legacy compatibility (may be null)
      sendMessageMinaret: (msg) => this.sendMessage("", msg),
      sendCommandMinaret: (cmd) => this.sendCommand(cmd),
    };
  }
}
