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

import { BaseModule } from '../base-module.js';

export class MinecraftModule extends BaseModule {
  constructor() {
    super();
    this.ws = null;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return '🎮 Minecraft (Minaret)';
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      connection: {
        url: {
          type: 'text',
          label: 'WebSocket URL',
          default: 'ws://localhost:8765',
          stored_as: 'minaret_url',
        },
        reconnect_delay: {
          type: 'number',
          label: 'Reconnect Delay (ms)',
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
          stored_as: 'minaret_reconnect_delay',
        },
      },
      minecraft: {
        username: {
          type: 'text',
          label: 'Minecraft Username',
          default: 'vany_serezhkin',
          stored_as: 'minecraft_username',
        },
      },
    };
  }

  /**
   * Connect to Minecraft server
   */
  async doConnect() {
    const url = this.getConfigValue('url', 'ws://localhost:8765');
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
          this.log('❌ Connection failed - check server status');
        } else {
          this.log(`❌ Connection closed (code: ${event.code})`);
        }

        // Auto-reconnect if not explicitly disconnected
        if (this.shouldReconnect) {
          const reconnectDelay = parseInt(this.getConfigValue('reconnect_delay', '5000'));
          this.log(`🔄 Reconnecting in ${reconnectDelay}ms...`);
          this.reconnectTimer = setTimeout(() => this.connect(), reconnectDelay);
        }
      };

      this.ws.onerror = (error) => {
        this.log('💥 WebSocket error - connection may have failed');
      };

      // Wait for connection to establish
      await this._waitForConnection();

    } catch (error) {
      this.log(`💥 Connection failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from Minecraft server
   */
  async doDisconnect() {
    this.shouldReconnect = false;

    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close WebSocket connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.log('🔌 Disconnected from Minecraft');
    }
  }

  /**
   * Wait for WebSocket connection to establish
   */
  _waitForConnection() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      const checkConnection = () => {
        if (this.ws.readyState === WebSocket.OPEN) {
          clearTimeout(timeout);
          resolve();
        } else if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
          clearTimeout(timeout);
          reject(new Error('Connection failed'));
        } else {
          setTimeout(checkConnection, 100);
        }
      };

      checkConnection();
    });
  }

  /**
   * Send chat message to Minecraft server
   */
  sendMessage(user, message) {
    if (!this.isConnected() || !this.ws) {
      this.log('💥 Not connected to Minecraft!');
      return false;
    }

    try {
      this.ws.send(JSON.stringify({
        message: message,
        user: user,
        chat: 'T',
      }));
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
      this.log('💥 Not connected to Minecraft!');
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
   */
  getContextContribution() {
    if (!this.isConnected()) {
      return {
        minecraft: null,
        minarert: null,
      };
    }

    return {
      minecraft: {
        sendMessage: this.sendMessage.bind(this),
        sendCommand: this.sendCommand.bind(this),
        getWebSocket: this.getWebSocket.bind(this),
        isConnected: () => this.isConnected(),
      },
      minarert: this.ws, // Legacy compatibility
      sendMessageMinaret: (user, msg) => this.sendMessage(user, msg),
      sendCommandMinaret: (cmd) => this.sendCommand(cmd),
    };
  }
}
