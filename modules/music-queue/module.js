/**
 * Music Queue Module
 *
 * Yandex Music + YouTube queue with viewer-driven requests and vote-skip.
 * Cross-tab control via UserScript globals:
 *   sendCommandToOtherTabs(command, payload, target)
 *   registerReplyListener(event, callback)
 *   openYoutubePlayer(url)
 *
 * Now-playing state is broadcast to /obs for the OBS overlay widget.
 *
 * Routing:
 *   Yandex URLs  → target: "yandex"
 *   YouTube URLs → target: "youtube" (opens/reuses a YouTube player tab)
 *   When YouTube plays: Yandex is paused
 *   When switching back to Yandex: YouTube is paused
 */

import { BaseModule } from "../base-module.js";
import { PersistentDeck } from "../../utils.js";

const YOUTUBE_RE = /youtube\.com\/watch/;

export class MusicQueueModule extends BaseModule {
  constructor() {
    super();
    this.queue = null;
    this.currentlyPlaying = null; // URL currently sent to player; emptyUrl = My Vibes
    this.nowPlaying = { title: "", artist: "" }; // last known track from music_start / youtube_ready
    this.needVoteSkip = 3;
    this._obsWs = null;
    // cached config values set in doConnect
    this._emptyUrl = "https://music.yandex.ru/";
    this._voteSkipThreshold = 3;
    // YouTube state
    this._ytPlayerActive = false; // true while a YouTube tab is open and acting as player
    this._watchdogTimer = null;
    this._pongReceived = false;
  }

  getDisplayName() { return "🎵 Music Queue"; }

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
          min: 1, max: 10, step: 1,
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

  // ── Lifecycle ────────────────────────────────────────────

  async doConnect() {
    this._emptyUrl = this.getConfigValue("empty_url", "https://music.yandex.ru/");
    this._voteSkipThreshold = parseInt(this.getConfigValue("vote_skip_threshold", "3"));
    this.needVoteSkip = this._voteSkipThreshold;

    const initialName = this.getConfigValue("initial_song_name", "Silence by silencer");
    this.nowPlaying = this._parseSongName(initialName);

    this.queue = new PersistentDeck(this.getConfigValue("persistence_key", "toplay"));

    this._setupListeners();
    this._connectObs();

    if (this.queue.size() === 0) {
      this._playNext();
    }

    this.log("✅ Music Queue initialized");
  }

  async doDisconnect() {
    this._stopWatchdog();
    if (this._obsWs) {
      this._obsWs.onclose = null;
      this._obsWs.close();
      this._obsWs = null;
    }
    this.queue?.flush();
    this.log("🔌 Music Queue disconnected");
  }

  // ── Cross-tab communication ──────────────────────────────

  _setupListeners() {
    if (typeof registerReplyListener !== "function") {
      this.log("⚠️ registerReplyListener not available (UserScript not loaded?)");
      return;
    }

    registerReplyListener("music_done", (url) => {
      // Ignore My Vibes track endings — those auto-advance internally on Yandex
      if (this.currentlyPlaying === this._emptyUrl || this.currentlyPlaying === null) return;
      this.log(`🎵 Track finished: ${url}`);
      // Close YouTube tab from MASTER (only MASTER has the GM tab handle)
      if (this._ytPlayerActive && typeof closeYoutubePlayer === "function") {
        closeYoutubePlayer();
      }
      this.currentlyPlaying = null;
      this._ytPlayerActive = false;
      this.needVoteSkip = this._voteSkipThreshold;
      this._stopWatchdog();
      this._playNext();
    });

    registerReplyListener("music_start", (name) => {
      this.nowPlaying = this._parseSongName(name);
      this.log(`🎵 Now playing: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
    });

    registerReplyListener("youtube_ready", (info) => {
      this.nowPlaying = { title: info.title ?? "Unknown", artist: info.author ?? "" };
      this._ytPlayerActive = true;
      this.log(`▶️ YouTube ready: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
      this._startWatchdog("youtube");
    });

    registerReplyListener("youtube_invalid", ({ url, reason }) => {
      this.log(`❌ YouTube invalid [${reason}]: ${url}`);
      this.currentlyPlaying = null;
      this._ytPlayerActive = false;
      this._stopWatchdog();
      this._playNext();
    });

    registerReplyListener("status_reply", (data) => {
      if (!data?.trackInfo) return;
      if (data.type === "youtube" && !this._ytPlayerActive) {
        this._ytPlayerActive = true;
        this.log("📺 YouTube player tab detected (was unknown after reconnect)");
      }
      this.nowPlaying = this._parseSongName(data.trackInfo);
      this.log(`🎵 Status synced: ${this.nowPlaying.title}`);
      this._refreshStatusDisplay();
    });

    registerReplyListener("pong", ({ type }) => {
      this.log(`🏓 Pong from ${type}`);
      this._pongReceived = true;
    });

    // required by UserScript protocol (MASTER receives these commands too via "all")
    registerReplyListener("song", () => {});

    if (typeof sendCommandToOtherTabs === "function") {
      sendCommandToOtherTabs("query_status", null);
    }
  }

  /** Send command to specific target tab type. */
  _send(command, payload, target = "all") {
    if (typeof sendCommandToOtherTabs !== "function") {
      this.log("⚠️ sendCommandToOtherTabs not available (UserScript not loaded?)");
      return;
    }
    sendCommandToOtherTabs(command, payload, target);
  }

  // ── YouTube helpers ──────────────────────────────────────

  _isYoutube(url) {
    return YOUTUBE_RE.test(url);
  }

  /**
   * Route song to the correct player tab.
   * - YouTube: pause Yandex, open/reuse YouTube player tab
   * - Yandex:  pause YouTube (if active), send to Yandex tab
   */
  _playSong(url) {
    if (this._isYoutube(url)) {
      // Pause Yandex before handing off to YouTube
      this._send("pause", null, "yandex");

      if (!this._ytPlayerActive) {
        if (typeof openYoutubePlayer === "function") {
          openYoutubePlayer(url);
          this.log(`📺 Opening new YouTube player tab: ${url}`);
        } else {
          this.log("⚠️ openYoutubePlayer not available (UserScript not loaded?)");
        }
      } else {
        this._send("song", url, "youtube");
      }
    } else {
      // Yandex URL — pause YouTube if it was playing
      if (this._ytPlayerActive) {
        this._send("pause", null, "youtube");
        this._ytPlayerActive = false;
      }
      this._send("song", url, "yandex");
    }
  }

  // ── Watchdog ─────────────────────────────────────────────

  _startWatchdog(tabType) {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (!this.currentlyPlaying || this.currentlyPlaying === this._emptyUrl) {
        this._stopWatchdog();
        return;
      }
      this._pongReceived = false;
      this._send("ping", null, tabType);
      setTimeout(() => {
        if (!this._pongReceived) {
          this.log(`⚠️ Watchdog: no pong from ${tabType} — assuming dead, advancing queue`);
          this.currentlyPlaying = null;
          this._ytPlayerActive = false;
          this._stopWatchdog();
          this._playNext();
        }
      }, 5000);
    }, 60000);
    this.log(`🐕 Watchdog started for ${tabType}`);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ── Queue logic ──────────────────────────────────────────

  _playNext() {
    this._stopWatchdog();
    if (this.queue.size() > 0) {
      const url = this.queue.shift();
      this.log(`▶️ Playing queued song (${this.queue.size()} remaining)`);
      this.currentlyPlaying = url;
      this._playSong(url);
      if (!this._isYoutube(url)) {
        // Yandex fires music_start which triggers watchdog indirectly via status
        // Start watchdog now so we detect tab death
        this._startWatchdog("yandex");
      }
      // YouTube watchdog is started in youtube_ready listener
    } else {
      this.log("▶️ Queue empty, returning to My Vibes");
      this.currentlyPlaying = this._emptyUrl;
      // Pause YouTube tab but keep _ytPlayerActive — tab is still open, reuse it next time
      if (this._ytPlayerActive) this._send("pause", null, "youtube");
      this._send("song", this._emptyUrl, "yandex");
    }
  }

  /** Play immediately if idle/My Vibes, otherwise enqueue. */
  smartAdd(url) {
    const idle = this.currentlyPlaying === null || this.currentlyPlaying === this._emptyUrl;
    if (idle) {
      this.log(`▶️ Idle, playing immediately: ${url}`);
      this.currentlyPlaying = url;
      this._playSong(url);
      return { queued: false, position: null };
    }
    this.queue.push(url);
    const position = this.queue.size() - 1;
    this.log(`➕ Queued at position ${position + 1}: ${url}`);
    this._broadcastNowPlaying();
    return { queued: true, position };
  }

  skip() {
    this.log("⏭️ Skipping current track");
    this._stopWatchdog();
    if (this.queue.size() === 0) {
      // No queue — advance Yandex playlist or return to My Vibes
      if (this._ytPlayerActive) {
        this._send("pause", null, "youtube");
        this._ytPlayerActive = false;
      }
      this._send("next", null, "yandex");
      return;
    }
    this.currentlyPlaying = null;
    this.needVoteSkip = this._voteSkipThreshold;
    this._playNext();
  }

  voteSkip() {
    const onMyVibes = this.currentlyPlaying === this._emptyUrl || !this.currentlyPlaying;
    if (onMyVibes) {
      if (this.queue.size() === 0) {
        this._send("next", null, "yandex");
        return { votesRemaining: 0, skipped: true, error: null };
      }
      return { votesRemaining: this.needVoteSkip, skipped: false, error: "Nothing to skip" };
    }

    this.needVoteSkip--;
    if (this.needVoteSkip < 1) {
      this.skip();
      return { votesRemaining: 0, skipped: true, error: null };
    }
    this.log(`🗳️ Skip vote cast. ${this.needVoteSkip} more needed`);
    return { votesRemaining: this.needVoteSkip, skipped: false, error: null };
  }

  clear() {
    this.queue.clear();
    this.log("🗑️ Queue cleared");
    this._broadcastNowPlaying();
  }

  getStatus() {
    return {
      currentlyPlaying: this.currentlyPlaying,
      currentSongName: `${this.nowPlaying.title} by ${this.nowPlaying.artist}`,
      queueLength: this.queue?.size() ?? 0,
      queuedSongs: this.queue?.all() ?? [],
      votesNeeded: this.needVoteSkip,
      ytPlayerActive: this._ytPlayerActive,
    };
  }

  // ── OBS broadcast ────────────────────────────────────────

  _connectObs() {
    const [proto, port] = location.protocol === "https:" ? ["wss:", 8443] : ["ws:", 8442];
    const url = `${proto}//${location.hostname}:${port}/obs`;
    const ws = new WebSocket(url);
    ws.onopen = () => this.log("📡 OBS broadcast connected");
    ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if (msg.request === "now_playing") this._broadcastNowPlaying();
      } catch {}
    };
    ws.onclose = () => {
      this._obsWs = null;
      if (this.connected) setTimeout(() => this._connectObs(), 3000);
    };
    ws.onerror = () => ws.close();
    this._obsWs = ws;
  }

  _broadcastNowPlaying() {
    if (!this._obsWs || this._obsWs.readyState !== WebSocket.OPEN) return;
    this._obsWs.send(JSON.stringify({
      now_playing: {
        artist: this.nowPlaying.artist,
        title: this.nowPlaying.title,
        queue_size: this.queue?.size() ?? 0,
      },
    }));
  }

  // ── Shared util ──────────────────────────────────────────

  /** Parse "title\nauthor" or "title by author" into {title, artist}. */
  _parseSongName(name) {
    if (name.includes("\n")) {
      const [title, artist = ""] = name.split("\n");
      return { title: title.trim(), artist: artist.trim() };
    }
    const byIdx = name.lastIndexOf(" by ");
    if (byIdx > 0) {
      return { title: name.slice(0, byIdx).trim(), artist: name.slice(byIdx + 4).trim() };
    }
    return { title: name.trim(), artist: "" };
  }

  // ── Control panel ────────────────────────────────────────

  hasControlPanel() { return true; }

  renderControlPanel() {
    const container = document.createElement("div");

    const statusDisplay = document.createElement("div");
    statusDisplay.className = "status-display";
    statusDisplay.id = "musicQueueStatus";
    this._updateStatusDisplay(statusDisplay);

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "🔄 Refresh";
    refreshBtn.className = "action-button";
    refreshBtn.style.cssText = "width:100%;margin-top:10px";
    refreshBtn.addEventListener("click", () => {
      this._send("query_status", null);
      this._updateStatusDisplay(statusDisplay);
    });

    const statusSection = this._createSection("Queue Status");
    statusSection.append(statusDisplay, refreshBtn);
    container.appendChild(statusSection);

    const queueList = document.createElement("div");
    queueList.className = "queued-songs-list";
    queueList.id = "queuedSongsList";
    this._updateQueueList(queueList);

    const queueSection = this._createSection("Queued Songs");
    queueSection.appendChild(queueList);
    container.appendChild(queueSection);

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "song-url-input";
    urlInput.placeholder = "https://music.yandex.ru/album/12345/track/67890";

    const addBtn = document.createElement("button");
    addBtn.textContent = "➕ Add to Queue";
    addBtn.className = "action-button";
    addBtn.style.width = "100%";
    addBtn.addEventListener("click", () => {
      const url = urlInput.value.trim();
      if (!url) return;
      const result = this.smartAdd(url);
      this.log(result.queued ? `✅ Queued at position ${result.position + 1}` : "▶️ Playing immediately");
      urlInput.value = "";
      this._updateQueueList(queueList);
      this._updateStatusDisplay(statusDisplay);
    });

    const addSection = this._createSection("Add Song");
    addSection.append(urlInput, addBtn);
    container.appendChild(addSection);

    const buttonGrid = document.createElement("div");
    buttonGrid.className = "button-grid";
    buttonGrid.append(
      this._createControlButton("⏭️ Skip", () => {
        this.skip();
        this._updateQueueList(queueList);
        this._updateStatusDisplay(statusDisplay);
      }),
      this._createControlButton("🗳️ Vote Skip", () => {
        const r = this.voteSkip();
        if (r.error) this.log(`❌ ${r.error}`);
        else if (r.skipped) this.log("⏭️ Skipped");
        else this.log(`🗳️ ${r.votesRemaining} votes remaining`);
        this._updateStatusDisplay(statusDisplay);
      }),
      this._createControlButton("🗑️ Clear Queue", () => {
        this.clear();
        this._updateQueueList(queueList);
        this._updateStatusDisplay(statusDisplay);
      }),
    );

    const controlsSection = this._createSection("Controls");
    controlsSection.appendChild(buttonGrid);
    container.appendChild(controlsSection);

    return container;
  }

  _refreshStatusDisplay() {
    const el = document.getElementById("musicQueueStatus");
    if (el) this._updateStatusDisplay(el);
    const ql = document.getElementById("queuedSongsList");
    if (ql) this._updateQueueList(ql);
  }

  _createSection(title) {
    const section = document.createElement("div");
    section.className = "queue-section";
    const h = document.createElement("h3");
    h.textContent = title;
    section.appendChild(h);
    return section;
  }

  _createControlButton(text, onClick) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.className = "action-button";
    btn.addEventListener("click", onClick);
    return btn;
  }

  _updateStatusDisplay(el) {
    const s = this.getStatus();
    const ytBadge = s.ytPlayerActive ? ' <span style="color:#f00">▶ YT</span>' : "";
    el.innerHTML = `
      <div class="status-item"><strong>Playing:</strong><span>${s.currentlyPlaying || "Nothing"}${ytBadge}</span></div>
      <div class="status-item"><strong>Song:</strong><span>${s.currentSongName}</span></div>
      <div class="status-item"><strong>Queue:</strong><span>${s.queueLength}</span></div>
      <div class="status-item"><strong>Votes needed:</strong><span>${s.votesNeeded}</span></div>
    `;
  }

  _updateQueueList(el) {
    const songs = this.queue?.all() ?? [];
    el.innerHTML = songs.length
      ? songs.map((url, i) => `<div class="queued-song-item">${i + 1}. ${url}</div>`).join("")
      : '<p class="empty-state">No songs in queue</p>';
  }

  // ── Context ──────────────────────────────────────────────

  getContextContribution() {
    return {
      musicQueue: this,
      currentSong: `${this.nowPlaying.title} by ${this.nowPlaying.artist}`,
    };
  }
}
