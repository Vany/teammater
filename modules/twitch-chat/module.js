/**
 * Twitch Chat Module
 *
 * IRC WebSocket connection to Twitch chat.
 *
 * Features:
 * - IRC connection with CAP REQ for tags/commands
 * - Message parsing (PRIVMSG with tags)
 * - Chat message sending (normal, action, whisper)
 * - Auto-reconnection
 * - Chat history for LLM monitoring
 *
 * Based on startChat() from index.js
 */

import { BaseModule } from "../base-module.js";
import { parseIrcTags, parseIrcMessage } from "../../utils.js";

export class TwitchChatModule extends BaseModule {
  constructor() {
    super();
    this.ws = null;
    this.channel = null;
    this.username = null;
    this.token = null;
    this.userIdCache = {};
    this.chatHistory = [];
    this.chatMarkerPosition = 0;
    this.messageHandlers = []; // Array of {priority, handler} objects
    this.reconnectTimer = null;
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "💬 Twitch Chat";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      authentication: {
        client_id: {
          type: "text",
          label: "Twitch Client ID",
          default: "",
          stored_as: "twitch_client_id",
        },
      },
      connection: {
        irc_url: {
          type: "text",
          label: "IRC WebSocket URL",
          default: "wss://irc-ws.chat.twitch.tv:443",
          stored_as: "twitch_irc_url",
        },
        reconnect_delay: {
          type: "number",
          label: "Reconnect Delay (ms)",
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
          stored_as: "twitch_reconnect_delay",
        },
      },
      identity: {
        nickname: {
          type: "text",
          label: "Nickname",
          default: "Vany",
          stored_as: "nick_name",
        },
        twitch_username: {
          type: "text",
          label: "Twitch Username",
          default: "vanyserezhkin",
          stored_as: "twitch_username",
        },
      },
      chat_history: {
        history_size: {
          type: "number",
          label: "Chat History Size (for LLM)",
          default: 50,
          min: 10,
          max: 200,
          step: 10,
        },
      },
    };
  }

  /**
   * Set authentication token and user info
   * Must be called before connect()
   */
  setAuth(token, username, channel) {
    this.token = token;
    this.username = username;
    this.channel = channel;
  }

  /**
   * Connect to Twitch IRC
   */
  async doConnect() {
    if (!this.token || !this.username) {
      throw new Error("Authentication required. Call setAuth() first.");
    }

    const ircUrl = this.getConfigValue(
      "irc_url",
      "wss://irc-ws.chat.twitch.tv:443",
    );

    this.log(`💬 Connecting to Twitch IRC at ${ircUrl}...`);
    this.log(`📺 Joining channel: #${this.channel} (as ${this.username})`);

    this.ws = new WebSocket(ircUrl);

    this.ws.onerror = (error) => {
      this.log(`❌ WebSocket error: ${error}`);
    };

    this.ws.onclose = () => {
      this.log("❌ WebSocket closed. Reconnecting...");
      this.updateStatus(false);

      const reconnectDelay = parseInt(
        this.getConfigValue("reconnect_delay", "5000"),
      );
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((err) => {
          this.log(`💥 Reconnect failed: ${err.message}`);
        });
      }, reconnectDelay);
    };

    this.ws.onopen = () => {
      // Enable IRC tags to get message IDs, user IDs, etc.
      this.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.ws.send(`PASS oauth:${this.token}`);
      this.ws.send(`NICK ${this.username}`);
      this.ws.send(`JOIN #${this.channel}`);

      this.log(`✅ Connected to #${this.channel} as ${this.username}`);
      this.updateStatus(true);
    };

    this.ws.onmessage = (event) => {
      this._handleIrcMessage(event.data);
    };

    // Wait for connection
    await this._waitForConnection();
  }

  /**
   * Disconnect from Twitch IRC
   */
  async doDisconnect() {
    this.log("🔌 Disconnecting from Twitch IRC...");

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.log("✅ Disconnected from Twitch IRC");
  }

  /**
   * Wait for WebSocket connection
   */
  _waitForConnection() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 10000);

      const checkConnection = () => {
        if (this.ws.readyState === WebSocket.OPEN) {
          clearTimeout(timeout);
          resolve();
        } else if (
          this.ws.readyState === WebSocket.CLOSED ||
          this.ws.readyState === WebSocket.CLOSING
        ) {
          clearTimeout(timeout);
          reject(new Error("Connection failed"));
        } else {
          setTimeout(checkConnection, 100);
        }
      };

      checkConnection();
    });
  }

  /**
   * Handle incoming IRC message
   */
  _handleIrcMessage(data) {
    // Handle PING
    if (data.startsWith("PING")) {
      this.ws.send("PONG :tmi.twitch.tv");
      return;
    }

    // Parse IRC message
    const parsed = parseIrcMessage(data);
    if (!parsed) {
      return; // Not a PRIVMSG or failed to parse
    }

    const { username, message } = parsed;

    // Extract tags (user-id, message-id, etc.)
    const tags = parseIrcTags(data);

    // Add to chat history
    this._addToChatHistory(username, message);

    // Notify message handlers (for chat actions, LLM monitoring, etc.)
    this._notifyMessageHandlers({
      username,
      message,
      tags,
      userId: tags?.["user-id"],
      messageId: tags?.id,
      rawData: data,
    });
  }

  /**
   * Add message to chat history buffer
   */
  _addToChatHistory(username, message) {
    const historySize = parseInt(this.getConfigValue("history_size", "50"));

    this.chatHistory.push({
      timestamp: new Date(),
      username: username,
      message: message,
    });

    // Keep buffer at historySize, remove oldest if exceeded
    if (this.chatHistory.length > historySize) {
      this.chatHistory.shift();

      // Adjust marker position
      if (this.chatMarkerPosition > 0) {
        this.chatMarkerPosition--;
      }
    }
  }

  /**
   * Register a message handler
   * @param {Function} handler - Function(messageData) to handle messages
   * @param {number} priority - Higher priority handlers run first (default: 0)
   */
  registerMessageHandler(handler, priority = 0) {
    this.messageHandlers.push({ priority, handler });
    // Sort by priority (highest first)
    this.messageHandlers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Unregister a message handler
   */
  unregisterMessageHandler(handler) {
    this.messageHandlers = this.messageHandlers.filter(
      (h) => h.handler !== handler,
    );
  }

  /**
   * Notify all message handlers
   */
  _notifyMessageHandlers(messageData) {
    for (const { handler } of this.messageHandlers) {
      try {
        handler(messageData);
      } catch (error) {
        this.log(`💥 Message handler error: ${error.message}`);
      }
    }
  }

  /**
   * Send message to chat
   */
  send(message) {
    if (!this.isConnected() || !this.ws || !message) {
      this.log("💥 Not connected to Twitch!");
      return false;
    }

    try {
      const sanitized = message.toString().trim();
      if (sanitized.length === 0) {
        this.log("💥 Empty message!");
        return false;
      }

      this.ws.send(`PRIVMSG #${this.channel} :${sanitized}`);
      this.log(`📤 Sent: ${sanitized}`);
      return true;
    } catch (error) {
      this.log(`💥 Send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send action message (/me)
   */
  sendAction(message) {
    if (!this.isConnected() || !this.ws || !message) {
      this.log("💥 Not connected to Twitch!");
      return false;
    }

    try {
      const sanitized = message.toString().trim();
      if (sanitized.length === 0) {
        this.log("💥 Empty message!");
        return false;
      }

      // IRC ACTION format: PRIVMSG #channel :\x01ACTION message\x01
      this.ws.send(`PRIVMSG #${this.channel} :\x01ACTION ${sanitized}\x01`);
      this.log(`📤 Action: * ${sanitized}`);
      return true;
    } catch (error) {
      this.log(`💥 Action send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get chat history
   */
  getChatHistory() {
    return this.chatHistory;
  }

  /**
   * Get chat marker position
   */
  getChatMarkerPosition() {
    return this.chatMarkerPosition;
  }

  /**
   * Set chat marker position
   */
  setChatMarkerPosition(position) {
    this.chatMarkerPosition = position;
  }

  /**
   * Format chat history for LLM with marker
   */
  formatChatHistoryForLLM() {
    if (this.chatHistory.length === 0) {
      return "No messages yet.";
    }

    const lines = this.chatHistory.map((entry, index) => {
      const timestamp = entry.timestamp.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const line = `[${timestamp}] ${entry.username}: ${entry.message}`;

      // Add marker after messages that were already processed
      if (
        index === this.chatMarkerPosition - 1 &&
        this.chatMarkerPosition < this.chatHistory.length
      ) {
        return line + "\n -> new messages";
      }

      return line;
    });

    return lines.join("\n");
  }

  /**
   * Get channel name
   */
  getChannel() {
    return this.channel;
  }

  /**
   * Get username
   */
  getUsername() {
    return this.username;
  }

  /**
   * Get WebSocket instance
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
        ws: null,
        CHANNEL: null,
        send_twitch: null,
        sendAction: null,
      };
    }

    return {
      ws: this.ws,
      CHANNEL: this.channel,
      send_twitch: this.send.bind(this),
      sendAction: this.sendAction.bind(this),
      chatHistory: this.chatHistory,
      chatMarkerPosition: this.chatMarkerPosition,
      setChatMarkerPosition: this.setChatMarkerPosition.bind(this),
      formatChatHistoryForLLM: this.formatChatHistoryForLLM.bind(this),
    };
  }
}
