/**
 * Echowire Module
 *
 * WebSocket connector for Android STT service.
 * Receives real-time speech recognition from mobile device.
 *
 * Protocol: Incremental transcription with diff-based partials
 * - partial_result: New words only (diff from last partial)
 * - final_result: Complete transcription with confidence scores
 * - recognition_error: Filtered errors (NO_MATCH suppressed)
 *
 * Reference: wsformat.md
 */

import { BaseModule } from "../base-module.js";

export class EchowireModule extends BaseModule {
  constructor() {
    super();

    // Transcription state
    this.currentText = ""; // Accumulated text from partials
    this.sessionStart = null; // Session timestamp
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "🎤 Echowire (STT)";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      connection: {
        websocket: {
          type: "text",
          label: "WebSocket URL",
          default: "wss://localhost:8443/echowire",
          stored_as: "echowire_websocket",
        },
        reconnect_delay: {
          type: "number",
          label: "Reconnect Delay (ms)",
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
          stored_as: "echowire_reconnect_delay",
        },
      },
      identity: {
        owner: {
          type: "text",
          label: "Owner name (injected as chat sender)",
          // Empty = fall back to LLM bot name at runtime
          default: "",
          required: false,
          stored_as: "echowire_owner",
        },
      },
    };
  }

  /**
   * Connect to Echowire WebSocket
   */
  async doConnect() {
    const url = this.getConfigValue(
      "websocket",
      "wss://localhost:8443/echowire",
    );
    this.shouldReconnect = true;

    this.log(`🎤 Connecting to Echowire at ${url}...`);

    try {
      this.ws = new WebSocket(url);

      // Setup event handlers
      this.ws.onopen = () => {
        this.updateStatus(true);
        this.log(`✅ Connected to Echowire at ${url}`);
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };

      this.ws.onclose = (event) => {
        this.updateStatus(false);

        if (event.code === 1006) {
          this.log("❌ Connection failed - check device and network");
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
   * Disconnect from Echowire
   */
  async doDisconnect() {
    // Cleanup using shared helper
    this._cleanupReconnect();
    this.log("🔌 Disconnected from Echowire");

    // Reset transcription state
    this._resetSession();
  }

  /**
   * Handle incoming WebSocket message
   * @private
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "hello":
          this._handleHello(message);
          break;
        case "partial_result":
          this._handlePartial(message);
          break;
        case "final_result":
          this._handleFinal(message);
          break;
        case "recognition_error":
          this._handleError(message);
          break;
        default:
          // Ignore deprecated messages (audio_level, recognition_event, audio_status)
          break;
      }
    } catch (error) {
      this.log(`💥 Failed to parse message: ${error.message}`);
    }
  }

  /**
   * Handle hello message (handshake)
   * @private
   */
  _handleHello(message) {
    this.log(
      `🤝 Handshake: ${message.device_name} (protocol v${message.protocol_version})`,
    );
  }

  /**
   * Handle partial_result (incremental transcription)
   * @private
   */
  _handlePartial(message) {
    // Update session tracking
    if (this.sessionStart !== message.session_start) {
      this.sessionStart = message.session_start;
      this.currentText = "";
    }

    // Append new words (diff-based)
    if (this.currentText) {
      this.currentText += " " + message.text;
    } else {
      this.currentText = message.text;
    }

    // Log accumulated text
    console.log(`🎤 [partial] ${this.currentText}`);
  }

  /**
   * Handle final_result (complete transcription)
   * @private
   */
  _handleFinal(message) {
    const phrase = message.best_text;
    const confidence = message.best_confidence;
    const language = message.language;

    // Log complete phrase
    console.log(
      `🎤 [FINAL] "${phrase}" (${language}, confidence: ${confidence.toFixed(2)})`,
    );

    // Check for LLM command prefixes — aliases come from LLM module config
    const llmModule = this.moduleManager?.get("llm");
    const aliases = llmModule?.getBotAliases() ?? ["Михалыч", "Михайлович"];
    const escaped = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const llmTrigger = new RegExp(`^(${escaped.join("|")})\\s+(.+)`, "i");
    const match = phrase.match(llmTrigger);

    if (match) {
      const commandText = match[2]; // Text after the bot name
      this._forwardToLLM(commandText);
    }

    // Reset for next utterance
    this._resetSession();
  }

  /**
   * Handle recognition_error
   * @private
   */
  _handleError(message) {
    // NO_MATCH (code 7) is already filtered by server, but handle gracefully
    if (message.error_code === 7) {
      return;
    }

    this.log(
      `⚠️ Recognition error [${message.error_code}]: ${message.error_message}`,
    );

    // Reset session on error
    this._resetSession();
  }

  /**
   * Reset transcription session
   * @private
   */
  _resetSession() {
    this.currentText = "";
    this.sessionStart = null;
  }

  /**
   * Forward message to chat as if it came from trusted superuser
   * Injects into chat history and triggers normal message processing
   * @private
   */
  _forwardToLLM(text) {
    const llmModule = this.moduleManager.get("llm");

    // Check if echowire is enabled in LLM config
    if (llmModule?.isConnected()) {
      const echowireEnabled = llmModule.getConfigValue(
        "echowire_enabled",
        true,
      );
      if (!echowireEnabled) {
        this.log("⚠️ Echowire forwarding disabled in LLM config");
        return;
      }
    }

    // Get Twitch Chat module
    const chatModule = this.moduleManager.get("twitch-chat");
    if (!chatModule?.isConnected()) {
      this.log("⚠️ Cannot forward to chat: Twitch Chat not connected");
      return;
    }

    // Owner name: echowire config → LLM bot name → "owner"
    const ownerName =
      this.getConfigValue("owner", "").trim() ||
      llmModule?.getBotName() ||
      "owner";

    this.log(`🎤 Injecting echowire message as ${ownerName}: "${text}"`);

    // Add to chat history (this makes it visible to LLM monitoring)
    chatModule._addToChatHistory(ownerName, text);

    // Notify message handlers (triggers actions, LLM monitoring, etc.)
    chatModule._notifyMessageHandlers({
      username: ownerName,
      message: text,
      tags: {
        "user-id": "echowire-superuser", // Special marker for trusted source
      },
      userId: "echowire-superuser",
      messageId: null,
      rawData: `echowire://${ownerName}/${text}`,
      source: "echowire", // Mark as echowire source
    });
  }

  /**
   * Get WebSocket instance (for direct access if needed)
   */
  getWebSocket() {
    return this.ws;
  }

  /**
   * Provide context for actions
   * Returns module reference - actions access methods directly
   */
  getContextContribution() {
    return { echowire: this };
  }

  /**
   * Get current transcription text
   */
  getCurrentText() {
    return this.currentText;
  }
}
