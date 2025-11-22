// ============================
// EXTERNAL CONNECTORS
// ============================
// This module handles external system integrations:
// - Music Queue: Cross-tab music control via UserScript
// - Minecraft (Minaret): WebSocket connection to local game server

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
    this.needVoteSkip = this.config.voteSkipThreshold;
    this.currentSong = "Unknown Track";

    this._setupListeners();
  }

  /**
   * Setup cross-tab communication listeners
   * Depends on UserScript globals: registerReplyListener
   */
  _setupListeners() {
    // Check if UserScript functions are available
    if (typeof registerReplyListener !== "function") {
      this.config.log("⚠️ registerReplyListener not available (UserScript not loaded?)");
      return;
    }

    // Listen for song completion
    registerReplyListener("music_done", (url) => {
      console.log("music done: " + url);
      if (url !== this.config.emptyUrl) {
        this.skip();
      } else {
        this.queue.shift();
      }
      console.log(this.queue.all());
    });

    // Listen for song start (track info broadcast)
    registerReplyListener("music_start", (name) => {
      name = name.replace(/\n/, " by ");
      this.currentSong = name;
      if (this.config.onSongStart) {
        this.config.onSongStart(name);
      }
    });

    // Dummy listener for song command (required by UserScript)
    registerReplyListener("song", (url) => {});
  }

  /**
   * Add song to queue and play if queue was empty
   * @param {string} url - Yandex Music track URL
   * @returns {number} - Queue position (0-indexed)
   */
  add(url) {
    const wasEmpty = this.queue.size() === 0;
    this.queue.push(url);

    if (wasEmpty) {
      this._play(url);
    }

    return this.queue.size() - 1;
  }

  /**
   * Skip current song and play next in queue
   */
  skip() {
    this.queue.shift();
    if (this.queue.size() > 0) {
      this._play(this.queue.peekBottom());
    } else {
      this._play(this.config.emptyUrl);
    }
  }

  /**
   * Play a song URL via cross-tab communication
   * @param {string} url - Song URL to play
   */
  _play(url) {
    this.needVoteSkip = this.config.voteSkipThreshold;
    console.log("Playing song: " + url);

    // Check if UserScript function is available
    if (typeof sendCommandToOtherTabs !== "function") {
      this.config.log("⚠️ sendCommandToOtherTabs not available (UserScript not loaded?)");
      return;
    }

    sendCommandToOtherTabs("song", url);
  }

  /**
   * Vote to skip current song
   * @returns {Object} - Object with votesRemaining and skipped boolean
   */
  voteSkip() {
    this.needVoteSkip--;

    if (this.needVoteSkip < 1) {
      this.config.log("⏭️ Skip threshold reached! Skipping song...");
      this.skip();
      this.needVoteSkip = this.config.voteSkipThreshold;
      return { votesRemaining: 0, skipped: true };
    }

    this.config.log(`🗳️ Skip vote cast. Votes remaining: ${this.needVoteSkip}`);
    return { votesRemaining: this.needVoteSkip, skipped: false };
  }

  /**
   * Get current song name
   */
  getCurrentSong() {
    return this.currentSong;
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
  }

  /**
   * Establish WebSocket connection to Minecraft server
   */
  connect() {
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
          this.config.log("❌ Connection failed - check credentials and server status");
        } else {
          this.config.log(`❌ Connection closed (code: ${event.code})`);
        }

        // Auto-reconnect
        setTimeout(() => this.connect(), this.config.reconnectDelay);
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
        })
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
   * Disconnect from server
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
      this._updateStatus(false);
    }
  }
}
