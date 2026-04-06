/**
 * Music Queue Module
 *
 * Yandex Music + YouTube queue with viewer-driven requests and vote-skip.
 * Communicates with browser tabs via the MusicBridge UserScript (teammater.js).
 * Broadcasts now-playing state to /obs for the OBS overlay widget.
 */

import { BaseModule } from "../base-module.js";
import { PersistentDeck } from "../../utils.js";

const YOUTUBE_RE = /youtube\.com\/watch/;

// ── MusicBridge interface ────────────────────────────────────
// Wraps all access to UserScript globals exposed on unsafeWindow.
// Checked lazily — script may load before UserScript initializes.

const bridge = {
  get ok() { return typeof sendCommandToOtherTabs === "function"; },
  send(command, payload, target = "all") {
    if (!this.ok) { console.warn("[MusicQueue] MusicBridge not available"); return; }
    sendCommandToOtherTabs(command, payload, target);
  },
  listen(event, fn) {
    if (typeof registerReplyListener !== "function") {
      console.warn("[MusicQueue] registerReplyListener not available");
      return;
    }
    registerReplyListener(event, fn);
  },
  openYoutube(url) {
    if (typeof openYoutubePlayer !== "function") {
      console.warn("[MusicQueue] openYoutubePlayer not available");
      return;
    }
    openYoutubePlayer(url);
  },
  closeYoutube() {
    if (typeof closeYoutubePlayer !== "function") {
      console.warn("[MusicQueue] closeYoutubePlayer not available");
      return;
    }
    closeYoutubePlayer();
  },
};

// ────────────────────────────────────────────────────────────

export class MusicQueueModule extends BaseModule {
  constructor() {
    super();
    this.queue           = null;
    this.currentlyPlaying = null;   // URL sent to player; emptyUrl = My Vibes
    this.nowPlaying      = { title: "", artist: "" };
    this.needVoteSkip    = 3;
    this._obsWs          = null;
    this._emptyUrl       = "https://music.yandex.ru/";
    this._voteSkipThreshold = 3;
    this._ytPlayerActive = false;   // YouTube player tab is open
    this._watchdogTimer  = null;
    this._pongReceived   = false;
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
          default: 3, min: 1, max: 10, step: 1,
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
    this._emptyUrl          = this.getConfigValue("empty_url", "https://music.yandex.ru/");
    this._voteSkipThreshold = parseInt(this.getConfigValue("vote_skip_threshold", "3"));
    this.needVoteSkip       = this._voteSkipThreshold;
    this.nowPlaying         = this._parseSongName(this.getConfigValue("initial_song_name", "Silence by silencer"));
    this.queue              = new PersistentDeck(this.getConfigValue("persistence_key", "toplay"));

    this._setupListeners();
    this._connectObs();

    if (this.queue.size() === 0) this._playNext();

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

  // ── Cross-tab listeners ──────────────────────────────────

  _setupListeners() {
    if (!bridge.ok) {
      this.log("⚠️ MusicBridge not available (UserScript not loaded?)");
    }

    bridge.listen("music_done", (url) => {
      // Ignore My Vibes endings — Yandex auto-advances internally
      if (this.currentlyPlaying === this._emptyUrl || this.currentlyPlaying === null) return;
      this.log(`🎵 Track finished: ${url}`);
      if (this._ytPlayerActive) bridge.closeYoutube();
      this._resetTrack();
      this._playNext();
    });

    bridge.listen("music_start", (name) => {
      this.nowPlaying = this._parseSongName(name);
      this.log(`🎵 Now playing: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
    });

    bridge.listen("youtube_ready", (info) => {
      this.nowPlaying      = { title: this._stripArtistFromTitle(info.title ?? "Unknown", info.author ?? ""), artist: info.author ?? "" };
      this._ytPlayerActive = true;
      this.log(`▶️ YouTube ready: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
      this._startWatchdog("youtube");
    });

    bridge.listen("youtube_invalid", ({ url, reason }) => {
      this.log(`❌ YouTube invalid [${reason}]: ${url}`);
      this._resetTrack();
      this._playNext();
    });

    bridge.listen("status_reply", (data) => {
      if (!data?.trackInfo) return;
      if (data.type === "youtube" && !this._ytPlayerActive) {
        this._ytPlayerActive = true;
        this.log("📺 YouTube player tab detected on reconnect");
      }
      this.nowPlaying = this._parseSongName(data.trackInfo);
      this.log(`🎵 Status synced: ${this.nowPlaying.title}`);
      this._refreshStatusDisplay();
    });

    bridge.listen("pong", ({ type }) => {
      this.log(`🏓 Pong from ${type}`);
      this._pongReceived = true;
    });

    bridge.listen("song", () => {}); // MASTER receives "all" messages; ignore own sends

    bridge.send("query_status", null);
  }

  // ── Track state ──────────────────────────────────────────

  /** Reset all per-track state after a track ends or is skipped. */
  _resetTrack() {
    this.currentlyPlaying = null;
    this._ytPlayerActive  = false;
    this.needVoteSkip     = this._voteSkipThreshold;
    this._stopWatchdog();
  }

  // ── Routing ──────────────────────────────────────────────

  _isYoutube(url) { return YOUTUBE_RE.test(url); }

  _playSong(url) {
    if (this._isYoutube(url)) {
      bridge.send("pause", null, "yandex");
      bridge.openYoutube(url);
      this.log(`📺 Opening YouTube player: ${url}`);
    } else {
      if (this._ytPlayerActive) {
        bridge.send("pause", null, "youtube");
        this._ytPlayerActive = false;
      }
      bridge.send("song", url, "yandex");
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
      bridge.send("ping", null, tabType);
      setTimeout(() => {
        if (!this._pongReceived) {
          this.log(`⚠️ Watchdog: no pong from ${tabType} — advancing queue`);
          this._resetTrack();
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
      this.log(`▶️ Playing next (${this.queue.size()} remaining): ${url}`);
      this.currentlyPlaying = url;
      this._playSong(url);
      if (!this._isYoutube(url)) this._startWatchdog("yandex");
      // YouTube watchdog starts in youtube_ready listener
    } else {
      this.log("▶️ Queue empty — returning to My Vibes");
      this.currentlyPlaying = this._emptyUrl;
      if (this._ytPlayerActive) bridge.send("pause", null, "youtube");
      bridge.send("song", this._emptyUrl, "yandex");
    }
  }

  /** Play immediately if idle, otherwise enqueue. */
  smartAdd(url) {
    const idle = this.currentlyPlaying === null || this.currentlyPlaying === this._emptyUrl;
    if (idle) {
      this.log(`▶️ Idle — playing immediately: ${url}`);
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
    this.log("⏭️ Skipping");
    if (this._ytPlayerActive) {
      bridge.send("pause", null, "youtube");
      this._ytPlayerActive = false;
    }
    if (this.queue.size() === 0) {
      this._stopWatchdog();
      bridge.send("next", null, "yandex");
      return;
    }
    this._resetTrack();
    this._playNext();
  }

  voteSkip() {
    const onMyVibes = !this.currentlyPlaying || this.currentlyPlaying === this._emptyUrl;
    if (onMyVibes) {
      if (this.queue.size() === 0) {
        bridge.send("next", null, "yandex");
        return { votesRemaining: 0, skipped: true, error: null };
      }
      return { votesRemaining: this.needVoteSkip, skipped: false, error: "Nothing to skip" };
    }
    this.needVoteSkip--;
    if (this.needVoteSkip < 1) {
      this.skip();
      return { votesRemaining: 0, skipped: true, error: null };
    }
    this.log(`🗳️ Vote cast — ${this.needVoteSkip} more needed`);
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
      currentSongName:  `${this.nowPlaying.title} by ${this.nowPlaying.artist}`,
      queueLength:      this.queue?.size() ?? 0,
      queuedSongs:      this.queue?.all() ?? [],
      votesNeeded:      this.needVoteSkip,
      ytPlayerActive:   this._ytPlayerActive,
    };
  }

  // ── OBS broadcast ────────────────────────────────────────

  _connectObs() {
    const [proto, port] = location.protocol === "https:" ? ["wss:", 8443] : ["ws:", 8442];
    const ws = new WebSocket(`${proto}//${location.hostname}:${port}/obs`);
    ws.onopen    = () => this.log("📡 OBS connected");
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
    ws.onerror  = () => ws.close();
    this._obsWs = ws;
  }

  _broadcastNowPlaying() {
    if (!this._obsWs || this._obsWs.readyState !== WebSocket.OPEN) return;
    this._obsWs.send(JSON.stringify({
      now_playing: {
        artist:     this.nowPlaying.artist,
        title:      this.nowPlaying.title,
        queue_size: this.queue?.size() ?? 0,
      },
    }));
  }

  // ── Song name parsing ────────────────────────────────────

  /** Parse "title\nauthor" or "title by author" → {title, artist}. Strips artist from title. */
  _parseSongName(name) {
    let title, artist;
    if (name.includes("\n")) {
      [title, artist = ""] = name.split("\n");
      title = title.trim(); artist = artist.trim();
    } else {
      const byIdx = name.lastIndexOf(" by ");
      if (byIdx > 0) {
        title  = name.slice(0, byIdx).trim();
        artist = name.slice(byIdx + 4).trim();
      } else {
        title = name.trim(); artist = "";
      }
    }
    return { title: this._stripArtistFromTitle(title, artist), artist };
  }

  /**
   * Remove redundant artist prefix/suffix from title.
   * e.g. "GHOST DATA - Inhuman" by "GHOST DATA" → "Inhuman"
   */
  _stripArtistFromTitle(title, artist) {
    if (!artist) return title;
    const a = artist.toLowerCase();
    const t = title.toLowerCase();
    for (const sep of [" - ", ": ", " — "]) {
      if (t.startsWith(a + sep)) return title.slice(artist.length + sep.length).trim();
      if (t.endsWith(sep + a))   return title.slice(0, title.length - sep.length - artist.length).trim();
    }
    return title;
  }

  // ── Control panel ────────────────────────────────────────

  hasControlPanel() { return true; }

  renderControlPanel() {
    const container = document.createElement("div");

    const statusEl = document.createElement("div");
    statusEl.className = "status-display";
    statusEl.id = "musicQueueStatus";
    this._updateStatusDisplay(statusEl);

    const refreshBtn = this._createControlButton("🔄 Refresh", () => {
      bridge.send("query_status", null);
      this._updateStatusDisplay(statusEl);
    });
    refreshBtn.style.cssText = "width:100%;margin-top:10px";

    const statusSection = this._createSection("Queue Status");
    statusSection.append(statusEl, refreshBtn);

    const queueEl = document.createElement("div");
    queueEl.className = "queued-songs-list";
    queueEl.id = "queuedSongsList";
    this._updateQueueList(queueEl);
    const queueSection = this._createSection("Queued Songs");
    queueSection.appendChild(queueEl);

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "song-url-input";
    urlInput.placeholder = "https://music.yandex.ru/album/12345/track/67890";
    const addBtn = this._createControlButton("➕ Add to Queue", () => {
      const url = urlInput.value.trim();
      if (!url) return;
      const r = this.smartAdd(url);
      this.log(r.queued ? `✅ Queued at position ${r.position + 1}` : "▶️ Playing immediately");
      urlInput.value = "";
      this._updateQueueList(queueEl);
      this._updateStatusDisplay(statusEl);
    });
    addBtn.style.width = "100%";
    const addSection = this._createSection("Add Song");
    addSection.append(urlInput, addBtn);

    const grid = document.createElement("div");
    grid.className = "button-grid";
    grid.append(
      this._createControlButton("⏭️ Skip", () => {
        this.skip();
        this._updateQueueList(queueEl);
        this._updateStatusDisplay(statusEl);
      }),
      this._createControlButton("🗳️ Vote Skip", () => {
        const r = this.voteSkip();
        if (r.error)    this.log(`❌ ${r.error}`);
        else if (r.skipped) this.log("⏭️ Skipped");
        else            this.log(`🗳️ ${r.votesRemaining} votes remaining`);
        this._updateStatusDisplay(statusEl);
      }),
      this._createControlButton("🗑️ Clear Queue", () => {
        this.clear();
        this._updateQueueList(queueEl);
        this._updateStatusDisplay(statusEl);
      }),
    );
    const controlsSection = this._createSection("Controls");
    controlsSection.appendChild(grid);

    container.append(statusSection, queueSection, addSection, controlsSection);
    return container;
  }

  _refreshStatusDisplay() {
    const s = document.getElementById("musicQueueStatus");
    const q = document.getElementById("queuedSongsList");
    if (s) this._updateStatusDisplay(s);
    if (q) this._updateQueueList(q);
  }

  _createSection(title) {
    const s = document.createElement("div");
    s.className = "queue-section";
    const h = document.createElement("h3");
    h.textContent = title;
    s.appendChild(h);
    return s;
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
    const yt = s.ytPlayerActive ? ' <span style="color:#f00">▶ YT</span>' : "";
    el.innerHTML = `
      <div class="status-item"><strong>Playing:</strong><span>${s.currentlyPlaying || "Nothing"}${yt}</span></div>
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
      musicQueue:  this,
      currentSong: `${this.nowPlaying.title} by ${this.nowPlaying.artist}`,
    };
  }
}
