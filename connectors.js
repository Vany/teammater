// ============================
// EXTERNAL CONNECTORS
// ============================
// This module handles external system integrations:
// - Music Queue: Cross-tab music control via UserScript
// - Minecraft (Minaret): WebSocket connection to local game server
// - LLM: HTTP connection to local Ollama server for chat/generation

import { PersistentDeck } from "./utils.js";

// ============================
// MUSIC QUEUE SYSTEM
// ============================

/**
 * Music queue manager for cross-tab Yandex Music control
 * Depends on UserScript-provided globals: registerReplyListener, sendCommandToOtherTabs
 */
export class MusicQueue {
  /**
   * @param {Object} config - Configuration object
   * @param {string} config.emptyUrl - URL to play when queue is empty
   * @param {number} config.voteSkipThreshold - Number of votes needed to skip
   * @param {Function|null} config.onSongStart - Callback(songName) when song starts playing
   * @param {Function} config.log - Logging function
   */
  constructor(config) {
    this.config = {
      emptyUrl: "https://music.yandex.ru/",
      voteSkipThreshold: 3,
      onSongStart: null,
      log: console.log,
      ...config,
    };

    this.queue = new PersistentDeck("toplay");
    this.currentlyPlaying = null; // Track what's actually playing
    this.needVoteSkip = this.config.voteSkipThreshold;
    this.currentSongName = "Unknown Track";

    this._setupListeners();
  }

  /**
   * Setup cross-tab communication listeners
   * Depends on UserScript globals: registerReplyListener
   */
  _setupListeners() {
    // Check if UserScript functions are available
    if (typeof registerReplyListener !== "function") {
      this.config.log(
        "⚠️ registerReplyListener not available (UserScript not loaded?)",
      );
      return;
    }

    // Listen for song completion
    registerReplyListener("music_done", (url) => {
      this.config.log(`🎵 Track finished: ${url}`);
      this._onTrackComplete();
    });

    // Listen for song start (track info broadcast)
    registerReplyListener("music_start", (name) => {
      const formatted = name.replace(/\n/, " by ");
      this.currentSongName = formatted;
      this.config.log(`🎵 Now playing: ${formatted}`);

      if (this.config.onSongStart) {
        this.config.onSongStart(formatted);
      }
    });

    // Dummy listener for song command (required by UserScript)
    registerReplyListener("song", (url) => {});
  }

  /**
   * Add song to queue (doesn't auto-play if something is already playing)
   * @param {string} url - Yandex Music track URL
   * @returns {number} - Queue position (0-indexed)
   */
  add(url) {
    this.queue.push(url);
    const position = this.queue.size() - 1;

    this.config.log(`➕ Added to queue at position ${position}: ${url}`);

    // Only start playing if nothing is currently playing
    if (!this.currentlyPlaying) {
      this._playNext();
    }

    return position;
  }

  /**
   * Smart add: if playing freely (empty queue), play immediately. Otherwise, queue it.
   * This is the main method for user song requests.
   * @param {string} url - Yandex Music track URL
   * @returns {Object} - Object with {queued: boolean, position: number|null}
   */
  smartAdd(url) {
    // Check if we're playing freely (queue is empty and something is playing)
    const queueIsEmpty = this.queue.size() === 0;
    const isPlayingFreely = queueIsEmpty && this.currentlyPlaying !== null;

    if (isPlayingFreely) {
      // Queue is empty and music is playing freely - play requested song immediately
      this.config.log(
        `▶️ Queue empty, playing requested song immediately: ${url}`,
      );
      this.currentlyPlaying = url;
      this._sendPlayCommand(url);
      return { queued: false, position: null };
    } else {
      // Queue has songs OR nothing is playing - add to queue
      this.queue.push(url);
      const position = this.queue.size() - 1;

      this.config.log(`➕ Added to queue at position ${position}: ${url}`);

      // Only start playing if nothing is currently playing
      if (!this.currentlyPlaying) {
        this._playNext();
      }

      return { queued: true, position: position };
    }
  }

  /**
   * Handle track completion
   * @private
   */
  _onTrackComplete() {
    this.currentlyPlaying = null;
    this.needVoteSkip = this.config.voteSkipThreshold; // Reset votes
    this._playNext();
  }

  /**
   * Play next song from queue (or fallback if empty)
   * @private
   */
  _playNext() {
    let nextUrl;

    if (this.queue.size() > 0) {
      nextUrl = this.queue.shift();
      this.config.log(
        `▶️ Playing next from queue (${this.queue.size()} remaining)`,
      );
    } else {
      nextUrl = this.config.emptyUrl;
      this.config.log(`▶️ Queue empty, playing fallback`);
    }

    this.currentlyPlaying = nextUrl;
    this._sendPlayCommand(nextUrl);
  }

  /**
   * Skip current song immediately
   */
  skip() {
    this.config.log(`⏭️ Skipping current track`);
    this.currentlyPlaying = null;
    this.needVoteSkip = this.config.voteSkipThreshold;
    this._playNext();
  }

  /**
   * Vote to skip current song
   * @returns {Object} - Object with votesRemaining, skipped boolean, and optional error
   */
  voteSkip() {
    // Don't allow skipping fallback URL
    if (
      this.currentlyPlaying === this.config.emptyUrl ||
      !this.currentlyPlaying
    ) {
      this.config.log(`❌ Cannot skip fallback URL or when nothing is playing`);
      return {
        votesRemaining: this.needVoteSkip,
        skipped: false,
        error: "Nothing to skip",
      };
    }

    this.needVoteSkip--;

    if (this.needVoteSkip < 1) {
      this.skip();
      return { votesRemaining: 0, skipped: true };
    }

    this.config.log(`🗳️ Skip vote cast. Votes remaining: ${this.needVoteSkip}`);
    return { votesRemaining: this.needVoteSkip, skipped: false };
  }

  /**
   * Send play command to UserScript
   * @private
   */
  _sendPlayCommand(url) {
    // Check if UserScript function is available
    if (typeof sendCommandToOtherTabs !== "function") {
      this.config.log(
        "⚠️ sendCommandToOtherTabs not available (UserScript not loaded?)",
      );
      return;
    }

    sendCommandToOtherTabs("song", url);
  }

  /**
   * Clear entire queue (stops at current track)
   */
  clear() {
    this.queue.clear();
    this.config.log(`🗑️ Queue cleared`);
  }

  /**
   * Get queue status and info
   * @returns {Object} - Status object with current state
   */
  getStatus() {
    return {
      currentlyPlaying: this.currentlyPlaying,
      currentSongName: this.currentSongName,
      queueLength: this.queue.size(),
      queuedSongs: this.queue.all(),
      votesNeeded: this.needVoteSkip,
    };
  }

  /**
   * Get current song name
   */
  getCurrentSong() {
    return this.currentSongName;
  }

  /**
   * Get queue size
   */
  size() {
    return this.queue.size();
  }

  /**
   * Get all queued songs
   */
  all() {
    return this.queue.all();
  }
}

// ============================
// MINECRAFT (MINARET) CONNECTOR
// ============================

/**
 * WebSocket connector for local Minecraft server ("minarert")
 * Manages connection lifecycle and message sending
 */
export class MinecraftConnector {
  /**
   * @param {Object} config - Configuration object
   * @param {string} config.url - WebSocket server URL
   * @param {number} config.reconnectDelay - Milliseconds before reconnection attempt
   * @param {Function} config.log - Logging function
   * @param {Function|null} config.onStatusChange - Callback(connected: boolean) for status updates
   */
  constructor(config) {
    this.config = {
      url: "ws://localhost:8765",
      reconnectDelay: 5000,
      log: console.log,
      onStatusChange: null,
      ...config,
    };

    this.ws = null;
    this.connected = false;
    this.shouldReconnect = true; // Flag to control auto-reconnect behavior
    this.reconnectTimer = null; // Store reconnect timer for cleanup
  }

  /**
   * Establish WebSocket connection to Minecraft server
   */
  connect() {
    this.shouldReconnect = true; // Enable auto-reconnect when connecting

    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        this.connected = true;
        this._updateStatus(true);
        this.config.log(`🔗 Connected to ${this.config.url}`);
      };

      this.ws.onmessage = (event) => {
        this.config.log(`📨 Received: ${event.data}`);
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this._updateStatus(false);

        if (event.code === 1006) {
          this.config.log(
            "❌ Connection failed - check credentials and server status",
          );
        } else {
          this.config.log(`❌ Connection closed (code: ${event.code})`);
        }

        // Auto-reconnect only if not explicitly disconnected
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(
            () => this.connect(),
            this.config.reconnectDelay,
          );
        }
      };

      this.ws.onerror = (error) => {
        this.config.log("💥 WebSocket error - authentication may have failed");
      };
    } catch (error) {
      this.config.log(`💥 Connection failed: ${error.message}`);
    }
  }

  /**
   * Send chat message to Minecraft server
   * @param {string} user - Username who sent the message
   * @param {string} message - Message content
   * @returns {boolean} - Success status
   */
  sendMessage(user, message) {
    if (!this.connected || !this.ws) {
      this.config.log("💥 Not connected!");
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
      this.config.log(`💥 Send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send game command to Minecraft server
   * @param {string} command - Minecraft command to execute
   * @returns {boolean} - Success status
   */
  sendCommand(command) {
    if (!this.connected || !this.ws || !command) {
      this.config.log("💥 Not connected!");
      return false;
    }

    try {
      this.ws.send(`{"command": "${command}"}`);
      this.config.log(`📤 Sent: ${command}`);
      return true;
    } catch (error) {
      this.config.log(`💥 Send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if connected to server
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Get WebSocket instance (for direct access if needed)
   */
  getWebSocket() {
    return this.ws;
  }

  /**
   * Update connection status via callback
   */
  _updateStatus(connected) {
    if (this.config.onStatusChange) {
      this.config.onStatusChange(connected);
    }
  }

  /**
   * Disconnect from server and prevent auto-reconnect
   */
  disconnect() {
    this.shouldReconnect = false; // Disable auto-reconnect

    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close WebSocket connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
      this._updateStatus(false);
    }
  }
}

// ============================
// LLM (OLLAMA) CONNECTOR
// ============================

/**
 * HTTP connector for local Ollama LLM server
 * Supports both Ollama native API and OpenAI-compatible API
 * Use cases: chat companion, automoderator, general helper
 */
export class LLMConnector {
  /**
   * @param {Object} config - Configuration object
   * @param {string} config.baseUrl - Ollama server base URL
   * @param {string} config.model - Default model name (e.g., "llama3.2", "mistral")
   * @param {number} config.temperature - Generation temperature (0.0-1.0)
   * @param {number} config.timeout - Request timeout in milliseconds
   * @param {number} config.maxTokens - Maximum tokens to generate
   * @param {number} config.healthCheckInterval - Milliseconds between health checks (0 = disabled)
   * @param {Function} config.log - Logging function
   * @param {Function|null} config.onStatusChange - Callback(connected: boolean) for status updates
   */
  constructor(config) {
    this.config = {
      baseUrl: "http://localhost:11434",
      model: "llama3.2",
      temperature: 0.7,
      timeout: 30000,
      maxTokens: 512,
      healthCheckInterval: 30000, // Check health every 30s
      log: console.log,
      onStatusChange: null,
      ...config,
    };

    this.connected = false;
    this.healthCheckTimer = null;
    this.lastHealthCheck = null;
  }

  /**
   * Initialize connector and verify Ollama server is running
   * Starts periodic health checks if healthCheckInterval > 0
   * @returns {Promise<boolean>} - Connection success status
   */
  async connect() {
    try {
      const healthy = await this.checkHealth();

      if (healthy) {
        this.connected = true;
        this._updateStatus(true);
        this.config.log(`🤖 Connected to Ollama at ${this.config.baseUrl}`);
        this.config.log(`📋 Default model: ${this.config.model}`);

        // Start periodic health checks
        if (this.config.healthCheckInterval > 0) {
          this._startHealthChecks();
        }

        return true;
      } else {
        this.connected = false;
        this._updateStatus(false);
        this.config.log(
          `❌ Ollama server not responding at ${this.config.baseUrl}`,
        );
        return false;
      }
    } catch (error) {
      this.connected = false;
      this._updateStatus(false);
      this.config.log(`💥 Connection failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if Ollama server is healthy and responding
   * @returns {Promise<boolean>} - Health status
   */
  async checkHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.lastHealthCheck = Date.now();

      const wasConnected = this.connected;
      const isHealthy = response.ok;

      if (isHealthy !== wasConnected) {
        this.connected = isHealthy;
        this._updateStatus(isHealthy);

        if (isHealthy) {
          this.config.log(`✅ Ollama server is back online`);
        } else {
          this.config.log(`⚠️ Ollama server stopped responding`);
        }
      }

      return isHealthy;
    } catch (error) {
      const wasConnected = this.connected;

      if (wasConnected) {
        this.connected = false;
        this._updateStatus(false);
        this.config.log(`⚠️ Health check failed: ${error.message}`);
      }

      return false;
    }
  }

  /**
   * List available models on Ollama server
   * @returns {Promise<Array<{name: string, size: number, modified_at: string}>>} - Array of model info
   * @throws {Error} - If request fails or server is unavailable
   */
  async listModels() {
    if (!this.connected) {
      throw new Error("Not connected to Ollama server");
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data.models || [];
    } catch (error) {
      this.config.log(`💥 Failed to list models: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate text using Ollama native API (/api/generate)
   * Supports both streaming and non-streaming responses
   *
   * @param {string} prompt - Text prompt for generation
   * @param {Object} options - Generation options
   * @param {string} options.model - Override default model
   * @param {number} options.temperature - Override default temperature
   * @param {number} options.maxTokens - Override default max tokens
   * @param {string} options.system - System prompt for context
   * @param {boolean} options.stream - Enable streaming response (default: false)
   * @param {Function} options.onChunk - Callback(chunk) for streaming (required if stream=true)
   * @returns {Promise<string>} - Generated text (full response for non-streaming)
   * @throws {Error} - If generation fails or server is unavailable
   */
  async generate(prompt, options = {}) {
    if (!this.connected) {
      throw new Error("Not connected to Ollama server");
    }

    const {
      model = this.config.model,
      temperature = this.config.temperature,
      maxTokens = this.config.maxTokens,
      system = null,
      stream = false,
      onChunk = null,
    } = options;

    // Validate streaming setup
    if (stream && typeof onChunk !== "function") {
      throw new Error("onChunk callback required for streaming");
    }

    const requestBody = {
      model,
      prompt,
      stream,
      options: {
        temperature,
        num_predict: maxTokens,
      },
    };

    if (system) {
      requestBody.system = system;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout,
      );

      const response = await fetch(`${this.config.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Handle streaming response
      if (stream) {
        return await this._handleStreamingResponse(response, onChunk);
      }

      // Handle non-streaming response
      const data = await response.json();
      return data.response || "";
    } catch (error) {
      this.config.log(`💥 Generation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Chat using OpenAI-compatible API (/v1/chat/completions)
   * Supports both streaming and non-streaming responses
   *
   * @param {Array<{role: string, content: string}>} messages - Chat message history
   * @param {Object} options - Chat options
   * @param {string} options.model - Override default model
   * @param {number} options.temperature - Override default temperature
   * @param {number} options.maxTokens - Override default max tokens
   * @param {boolean} options.stream - Enable streaming response (default: false)
   * @param {Function} options.onChunk - Callback(chunk) for streaming (required if stream=true)
   * @returns {Promise<string>} - Assistant's response text
   * @throws {Error} - If chat fails or server is unavailable
   */
  async chat(messages, options = {}) {
    if (!this.connected) {
      throw new Error("Not connected to Ollama server");
    }

    const {
      model = this.config.model,
      temperature = this.config.temperature,
      maxTokens = this.config.maxTokens,
      stream = false,
      onChunk = null,
    } = options;

    // Validate streaming setup
    if (stream && typeof onChunk !== "function") {
      throw new Error("onChunk callback required for streaming");
    }

    const requestBody = {
      model,
      messages,
      stream,
      temperature,
      max_tokens: maxTokens,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout,
      );

      const response = await fetch(
        `${this.config.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Handle streaming response
      if (stream) {
        return await this._handleStreamingChatResponse(response, onChunk);
      }

      // Handle non-streaming response
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    } catch (error) {
      this.config.log(`💥 Chat failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle streaming response from /api/generate
   * @param {Response} response - Fetch API response object
   * @param {Function} onChunk - Callback(chunk) for each generated chunk
   * @returns {Promise<string>} - Full generated text
   * @private
   */
  async _handleStreamingResponse(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((line) => line.trim());

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.response) {
              fullText += json.response;
              onChunk(json.response);
            }
          } catch (parseError) {
            // Ignore malformed JSON chunks
          }
        }
      }

      return fullText;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle streaming response from /v1/chat/completions
   * @param {Response} response - Fetch API response object
   * @param {Function} onChunk - Callback(chunk) for each generated chunk
   * @returns {Promise<string>} - Full assistant message
   * @private
   */
  async _handleStreamingChatResponse(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((line) => line.trim());

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6); // Remove "data: " prefix
            if (jsonStr === "[DONE]") break;

            try {
              const json = JSON.parse(jsonStr);
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                fullText += content;
                onChunk(content);
              }
            } catch (parseError) {
              // Ignore malformed JSON chunks
            }
          }
        }
      }

      return fullText;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Start periodic health checks
   * @private
   */
  _startHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(
      () => this.checkHealth(),
      this.config.healthCheckInterval,
    );
  }

  /**
   * Stop periodic health checks
   * @private
   */
  _stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Update connection status via callback
   * @private
   */
  _updateStatus(connected) {
    if (this.config.onStatusChange) {
      this.config.onStatusChange(connected);
    }
  }

  /**
   * Check if connected to Ollama server
   * @returns {boolean} - Connection status
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Get time since last successful health check
   * @returns {number|null} - Milliseconds since last check, or null if never checked
   */
  getLastHealthCheckAge() {
    if (!this.lastHealthCheck) return null;
    return Date.now() - this.lastHealthCheck;
  }

  /**
   * Disconnect from server and stop health checks
   */
  disconnect() {
    this._stopHealthChecks();

    if (this.connected) {
      this.connected = false;
      this._updateStatus(false);
      this.config.log(`🔌 Disconnected from Ollama`);
    }
  }
}
