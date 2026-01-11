/**
 * Music Queue Module
 *
 * Cross-tab Yandex Music control with queue management.
 * Depends on UserScript-provided globals:
 * - registerReplyListener(eventName, callback)
 * - sendCommandToOtherTabs(command, data)
 *
 * Features:
 * - Song queue management
 * - Vote skip system
 * - Control modal for queue inspection
 * - Cross-tab communication
 *
 * Based on MusicQueue from connectors.js
 */

import { BaseModule } from "../base-module.js";
import { PersistentDeck } from "../../utils.js";

export class MusicQueueModule extends BaseModule {
  constructor() {
    super();
    this.queue = null;
    this.currentlyPlaying = null;
    this.currentSongName = "Unknown Track";
    this.needVoteSkip = 3; // Will be set from config
    this.onSongStartCallback = null;
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "🎵 Music Queue";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      queue: {
        empty_url: {
          type: "text",
          label: "Fallback URL (when queue empty)",
          default: "https://music.yandex.ru/",
        },
        vote_skip_threshold: {
          type: "number",
          label: "Vote Skip Threshold",
          default: 3,
          min: 1,
          max: 10,
          step: 1,
        },
        initial_song_name: {
          type: "text",
          label: "Initial Song Name",
          default: "Silence by silencer",
          stored_as: "music_initial_song_name",
        },
      },
      storage: {
        persistence_key: {
          type: "text",
          label: "LocalStorage Key",
          default: "toplay",
        },
      },
    };
  }

  /**
   * This module has a control panel (queue management modal)
   */
  hasControlPanel() {
    return true;
  }

  /**
   * Render control panel content (queue management UI)
   */
  renderControlPanel() {
    const container = document.createElement("div");

    // Queue Status Section
    const statusSection = this._createSection("Queue Status");
    const statusDisplay = document.createElement("div");
    statusDisplay.className = "status-display";
    statusDisplay.id = "musicQueueStatus";
    this._updateStatusDisplay(statusDisplay);
    statusSection.appendChild(statusDisplay);

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "🔄 Refresh Status";
    refreshBtn.className = "action-button";
    refreshBtn.style.width = "100%";
    refreshBtn.style.marginTop = "10px";
    refreshBtn.addEventListener("click", () => {
      this._updateStatusDisplay(statusDisplay);
      this.log("🔄 Queue status refreshed");
    });
    statusSection.appendChild(refreshBtn);
    container.appendChild(statusSection);

    // Queued Songs Section
    const queueSection = this._createSection("Queued Songs");
    const queueList = document.createElement("div");
    queueList.className = "queued-songs-list";
    queueList.id = "queuedSongsList";
    this._updateQueueList(queueList);
    queueSection.appendChild(queueList);
    container.appendChild(queueSection);

    // Add Song Section
    const addSection = this._createSection("Add Song to Queue");
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "song-url-input";
    urlInput.placeholder = "https://music.yandex.ru/album/12345/track/67890";
    addSection.appendChild(urlInput);

    const addBtn = document.createElement("button");
    addBtn.textContent = "➕ Add to Queue";
    addBtn.className = "action-button";
    addBtn.style.width = "100%";
    addBtn.addEventListener("click", () => {
      const url = urlInput.value.trim();
      if (!url) {
        this.log(`⚠️ Please enter a URL`);
        return;
      }

      const result = this.smartAdd(url);
      if (result.queued) {
        this.log(`✅ Song queued at position ${result.position + 1}`);
      } else {
        this.log(`▶️ Song playing immediately`);
      }
      urlInput.value = "";
      this._updateQueueList(queueList);
      this._updateStatusDisplay(statusDisplay);
    });
    addSection.appendChild(addBtn);
    container.appendChild(addSection);

    // Queue Controls Section
    const controlsSection = this._createSection("Queue Controls");
    const buttonGrid = document.createElement("div");
    buttonGrid.className = "button-grid";

    const skipBtn = this._createControlButton("⏭️ Skip Song", () => {
      this.skip();
      this.log("⏭️ Song skipped");
      this._updateQueueList(queueList);
      this._updateStatusDisplay(statusDisplay);
    });

    const voteSkipBtn = this._createControlButton("🗳️ Vote Skip", () => {
      const result = this.voteSkip();
      if (result.skipped) {
        this.log("⏭️ Skip threshold reached, song skipped");
      } else if (result.error) {
        this.log(`❌ ${result.error}`);
      } else {
        this.log(`🗳️ Vote cast, ${result.votesRemaining} more needed`);
      }
      this._updateStatusDisplay(statusDisplay);
    });

    const clearBtn = this._createControlButton("🗑️ Clear Queue", () => {
      this.clear();
      this.log("🗑️ Queue cleared");
      this._updateQueueList(queueList);
      this._updateStatusDisplay(statusDisplay);
    });

    buttonGrid.appendChild(skipBtn);
    buttonGrid.appendChild(voteSkipBtn);
    buttonGrid.appendChild(clearBtn);
    controlsSection.appendChild(buttonGrid);
    container.appendChild(controlsSection);

    return container;
  }

  /**
   * Helper: Create section container
   */
  _createSection(title) {
    const section = document.createElement("div");
    section.className = "queue-section";

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    return section;
  }

  /**
   * Helper: Create control button
   */
  _createControlButton(text, onClick) {
    const button = document.createElement("button");
    button.textContent = text;
    button.className = "action-button";
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * Helper: Update status display
   */
  _updateStatusDisplay(element) {
    const status = this.getStatus();
    element.innerHTML = `
      <div class="status-item">
        <strong>Currently Playing:</strong>
        <span>${status.currentlyPlaying || "Nothing"}</span>
      </div>
      <div class="status-item">
        <strong>Song Name:</strong>
        <span>${status.currentSongName}</span>
      </div>
      <div class="status-item">
        <strong>Queue Length:</strong>
        <span>${status.queueLength}</span>
      </div>
      <div class="status-item">
        <strong>Votes Needed:</strong>
        <span>${status.votesNeeded}</span>
      </div>
    `;
  }

  /**
   * Helper: Update queue list
   */
  _updateQueueList(element) {
    const songs = this.queue?.all() || [];

    if (songs.length === 0) {
      element.innerHTML = '<p class="empty-state">No songs in queue</p>';
    } else {
      element.innerHTML = songs
        .map((url, idx) => {
          return `<div class="queued-song-item">${idx + 1}. ${url}</div>`;
        })
        .join("");
    }
  }

  /**
   * Connect (setup queue and listeners)
   */
  async doConnect() {
    this.log("🎵 Initializing Music Queue...");

    // Initialize persistent queue
    const persistenceKey = this.getConfigValue("persistence_key", "toplay");
    this.queue = new PersistentDeck(persistenceKey);

    // Set vote skip threshold
    const threshold = parseInt(this.getConfigValue("vote_skip_threshold", "3"));
    this.needVoteSkip = threshold;

    // Set initial song name
    this.currentSongName = this.getConfigValue(
      "initial_song_name",
      "Silence by silencer",
    );

    // Setup cross-tab listeners
    this._setupListeners();

    // Start playing fallback if queue empty
    if (this.queue.size() === 0) {
      this.skip();
    }

    this.log("✅ Music Queue initialized");
  }

  /**
   * Disconnect (cleanup)
   */
  async doDisconnect() {
    this.log("🔌 Disconnecting Music Queue...");

    // Flush queue to localStorage
    if (this.queue) {
      this.queue.flush();
    }

    this.log("✅ Music Queue disconnected");
  }

  /**
   * Setup cross-tab communication listeners
   */
  _setupListeners() {
    // Check if UserScript functions are available
    if (typeof registerReplyListener !== "function") {
      this.log(
        "⚠️ registerReplyListener not available (UserScript not loaded?)",
      );
      return;
    }

    // Listen for song completion
    registerReplyListener("music_done", (url) => {
      this.log(`🎵 Track finished: ${url}`);
      this._onTrackComplete();
    });

    // Listen for song start (track info broadcast)
    registerReplyListener("music_start", (name) => {
      const formatted = name.replace(/\n/, " by ");
      this.currentSongName = formatted;
      this.log(`🎵 Now playing: ${formatted}`);

      // Update control panel status display if it exists
      const statusDisplay = document.getElementById("musicQueueStatus");
      if (statusDisplay) {
        this._updateStatusDisplay(statusDisplay);
      }

      if (this.onSongStartCallback) {
        this.onSongStartCallback(formatted);
      }
    });

    // Dummy listener for song command (required by UserScript)
    registerReplyListener("song", (url) => {});

    // Request current status from music player on init
    if (typeof sendCommandToOtherTabs === "function") {
      // Listen for status reply
      registerReplyListener("status_reply", (data) => {
        if (data && data.trackInfo) {
          const formatted = data.trackInfo.replace(/\n/, " by ");
          this.currentSongName = formatted;
          this.log(`🎵 Current song synced: ${formatted}`);

          // Update control panel status display if it exists
          const statusDisplay = document.getElementById("musicQueueStatus");
          if (statusDisplay) {
            this._updateStatusDisplay(statusDisplay);
          }
        }
      });

      // Send query
      sendCommandToOtherTabs("query_status", null);
      this.log("📡 Querying music player for current song...");
    }
  }

  /**
   * Handle track completion
   */
  _onTrackComplete() {
    this.currentlyPlaying = null;
    this.needVoteSkip = parseInt(
      this.getConfigValue("vote_skip_threshold", "3"),
    );
    this._playNext();
  }

  /**
   * Play next song from queue (or fallback if empty)
   */
  _playNext() {
    let nextUrl;

    if (this.queue.size() > 0) {
      nextUrl = this.queue.shift();
      this.log(`▶️ Playing next from queue (${this.queue.size()} remaining)`);
    } else {
      nextUrl = this.getConfigValue("empty_url", "https://music.yandex.ru/");
      this.log(`▶️ Queue empty, playing fallback`);
    }

    this.currentlyPlaying = nextUrl;
    this._sendPlayCommand(nextUrl);
  }

  /**
   * Send play command to UserScript
   */
  _sendPlayCommand(url) {
    // Check if UserScript function is available
    if (typeof sendCommandToOtherTabs !== "function") {
      this.log(
        "⚠️ sendCommandToOtherTabs not available (UserScript not loaded?)",
      );
      return;
    }

    this.log(`📡 Sending play command to music tab: ${url}`);
    sendCommandToOtherTabs("song", url);
    this.log(`✅ Play command sent`);
  }

  /**
   * Add song to queue (doesn't auto-play if something is already playing)
   */
  add(url) {
    this.queue.push(url);
    const position = this.queue.size() - 1;

    this.log(`➕ Added to queue at position ${position}: ${url}`);

    // Only start playing if nothing is currently playing
    if (!this.currentlyPlaying) {
      this._playNext();
    }

    return position;
  }

  /**
   * Smart add: if queue is empty, play immediately. Otherwise, queue it.
   */
  smartAdd(url) {
    const queueIsEmpty = this.queue.size() === 0;

    if (queueIsEmpty) {
      // Queue is empty - play requested song immediately
      this.log(`▶️ Queue empty, playing requested song immediately: ${url}`);
      this.currentlyPlaying = url;
      this._sendPlayCommand(url);
      return { queued: false, position: null };
    } else {
      // Queue has songs - add to queue
      this.queue.push(url);
      const position = this.queue.size() - 1;

      this.log(`➕ Added to queue at position ${position}: ${url}`);

      return { queued: true, position: position };
    }
  }

  /**
   * Skip current song immediately
   */
  skip() {
    this.log(`⏭️ Skipping current track`);
    this.currentlyPlaying = null;
    this.needVoteSkip = parseInt(
      this.getConfigValue("vote_skip_threshold", "3"),
    );
    this._playNext();
  }

  /**
   * Vote to skip current song
   */
  voteSkip() {
    const emptyUrl = this.getConfigValue(
      "empty_url",
      "https://music.yandex.ru/",
    );

    // Don't allow skipping fallback URL
    if (this.currentlyPlaying === emptyUrl || !this.currentlyPlaying) {
      this.log(`❌ Cannot skip fallback URL or when nothing is playing`);
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

    this.log(`🗳️ Skip vote cast. Votes remaining: ${this.needVoteSkip}`);
    return { votesRemaining: this.needVoteSkip, skipped: false };
  }

  /**
   * Clear entire queue (stops at current track)
   */
  clear() {
    this.queue.clear();
    this.log(`🗑️ Queue cleared`);
  }

  /**
   * Get queue status and info
   */
  getStatus() {
    return {
      currentlyPlaying: this.currentlyPlaying,
      currentSongName: this.currentSongName,
      queueLength: this.queue?.size() || 0,
      queuedSongs: this.queue?.all() || [],
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
   * Set song start callback
   */
  setOnSongStart(callback) {
    this.onSongStartCallback = callback;
  }

  /**
   * Provide context for actions
   */
  getContextContribution() {
    if (!this.isConnected()) {
      return { musicQueue: null };
    }

    return {
      musicQueue: {
        add: this.add.bind(this),
        smartAdd: this.smartAdd.bind(this),
        skip: this.skip.bind(this),
        voteSkip: this.voteSkip.bind(this),
        clear: this.clear.bind(this),
        getStatus: this.getStatus.bind(this),
        getCurrentSong: this.getCurrentSong.bind(this),
        setOnSongStart: this.setOnSongStart.bind(this),
        needVoteSkip: this.needVoteSkip,
        currentSong: this.currentSongName,
      },
    };
  }
}
