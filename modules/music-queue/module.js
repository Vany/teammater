/**
 * Music Queue Module
 *
 * Yandex Music + YouTube queue with viewer-driven requests and vote-skip.
 * Communicates with browser tabs via the MusicBridge UserScript (teammater.js).
 * Broadcasts now-playing state to /obs for the OBS overlay widget.
 */

import { BaseModule } from "../base-module.js";
import { PersistentDeck } from "../../utils.js";
import { getBusToken, busUrl } from "../../bus-token.js";

const YOUTUBE_RE = /youtube\.com\/watch|youtu\.be\//;

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
    this.nowPlaying      = { title: "", artist: "", version: "", cover: null, coverFallback: null, source: "", url: "" };
    this.needVoteSkip    = 3;
    this._musicPaused    = false;
    this._obsWs          = null;
    this._emptyUrl       = "https://music.yandex.ru/";
    this._voteSkipThreshold = 3;
    this._ytPlayerActive = false;   // YouTube player tab is open
    this._watchdogTimer  = null;
    this._watchdogPongTimeout = null; // per-tick "did we get a pong" timer — see _stopWatchdog
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
    this._voteSkipThreshold = this.getConfigInt("vote_skip_threshold", 3);
    this.needVoteSkip       = this._voteSkipThreshold;
    this.nowPlaying         = { ...this._parseSongName(this.getConfigValue("initial_song_name", "Silence by silencer")), cover: null, coverFallback: null, source: "", url: "" };
    this.queue              = new PersistentDeck(this.getConfigValue("persistence_key", "toplay"));

    this._setupListeners();
    this._connectObs();

    // Either way we must START something. _playNext() drains the restored deck
    // when it is non-empty and falls back to My Vibes when it is not — the old
    // `if (size === 0)` guard did the opposite of what the queue needs: with
    // songs restored from localStorage nothing played at all, currentlyPlaying
    // stayed null, and smartAdd reads null as "idle" and plays the NEXT request
    // immediately — jumping the paid songs it was supposed to be holding.
    this._playNext();

    this.log(`✅ Music Queue initialized (${this.queue.size()} queued)`);
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

    bridge.listen("music_start", (info) => {
      this.nowPlaying = {
        title:         info.title        ?? "",
        artist:        info.artist       ?? "",
        version:       info.version      ?? "",
        cover:         info.cover        ?? null,
        coverFallback: info.coverFallback ?? null,
        source:        info.source       ?? "yandex",
        url:           info.url          ?? "",
      };
      this.log(`🎵 Now playing: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
    });

    bridge.listen("youtube_ready", (info) => {
      bridge.send("pause", null, "yandex");
      this.nowPlaying = {
        title:         this._stripArtistFromTitle(info.title ?? "Unknown", info.artist ?? ""),
        artist:        info.artist        ?? "",
        version:       info.version       ?? "",
        cover:         info.cover         ?? null,
        coverFallback: info.coverFallback  ?? null,
        source:        "youtube",
        url:           info.url           ?? "",
      };
      this._ytPlayerActive = true;
      this.log(`▶️ YouTube ready: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
      this._startWatchdog("youtube");
    });

    bridge.listen("youtube_invalid", ({ url, reason }) => {
      this.log(`❌ YouTube invalid [${reason}]: ${url}`);
      bridge.closeYoutube();
      this._resetTrack();
      this._playNext();
    });

    bridge.listen("status_reply", (data) => {
      if (!data?.trackInfo) return;
      // Only believe a YouTube tab that is on the track we think is playing.
      // A skipped tab is left OPEN and merely paused (see skip()), and it keeps
      // answering query_status forever — so any status_reply used to resurrect
      // _ytPlayerActive, after which the next music_resume sent `resume` to it
      // too and the old video played audibly over the current one.
      const replyId = this._youtubeVideoId(data.url);
      if (
        data.type === "youtube" &&
        !this._ytPlayerActive &&
        replyId &&
        replyId === this._youtubeVideoId(this.currentlyPlaying)
      ) {
        this._ytPlayerActive = true;
        this.log("📺 YouTube player tab detected on reconnect");
      }
      const parsed = data.title
        ? { title: data.title, artist: data.artist ?? "", version: data.version ?? "" }
        : this._parseSongName(data.trackInfo);
      this.nowPlaying = {
        ...parsed,
        cover:         data.cover         ?? null,
        coverFallback: data.coverFallback  ?? null,
        source:        data.source         ?? "",
        url:           data.url            ?? "",
      };
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
    this._musicPaused     = false;
    this._stopWatchdog();
  }

  // ── Routing ──────────────────────────────────────────────

  _isYoutube(url) { return YOUTUBE_RE.test(url); }

  /**
   * Video id from any YouTube URL form, or null.
   *
   * Compared instead of whole URLs because the two sides never hold the same
   * string: the module stores the URL as REQUESTED, while the tab reports
   * location.href after navigating to the cleaned form (and YouTube may add
   * its own params). The id is the only stable identity.
   * @private
   */
  _youtubeVideoId(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
      return u.searchParams.get("v");
    } catch {
      return null;
    }
  }

  _playSong(url) {
    if (this._isYoutube(url)) {
      bridge.send("pause", null, "yandex");
      // Delay opening YouTube to let the pause propagate through GM_setValue → Yandex listener
      setTimeout(() => bridge.openYoutube(url), 400);
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
      // Tracked so _stopWatchdog() can cancel it — see the note there for why
      // an untracked timeout here is a real race, not just untidy cleanup.
      this._watchdogPongTimeout = setTimeout(() => {
        this._watchdogPongTimeout = null;
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
    if (this._watchdogPongTimeout) {
      // Without this, skipping a track while its watchdog ping is in flight
      // left the 5s "no pong" timeout armed. It fires against whichever
      // track is playing BY THEN — the new, healthy one — reads
      // _pongReceived (shared, not per-cycle) as false because the new
      // cycle hadn't gotten its own pong yet either, and wrongly advances
      // past a track that was never actually stuck.
      clearTimeout(this._watchdogPongTimeout);
      this._watchdogPongTimeout = null;
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
      // Arm for BOTH sources. Waiting for youtube_ready left the window
      // between opening the tab and playback unwatched: a tab closed (or
      // autoplay-blocked) before its play event emits no youtube_ready, no
      // youtube_invalid — that 10s timeout runs INSIDE the tab — and no
      // music_done, so currentlyPlaying wedged forever. youtube_ready still
      // restarts the watchdog once playback actually begins.
      this._startWatchdog(this._isYoutube(url) ? "youtube" : "yandex");
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
      // Arm the watchdog exactly as _playNext does — for BOTH sources. Without
      // it a dead player tab never sends music_done, currentlyPlaying stays set
      // forever, and every later request queues behind a phantom track with no
      // recovery. See the note in _playNext for why YouTube cannot wait for
      // youtube_ready to arm it.
      this._startWatchdog(this._isYoutube(url) ? "youtube" : "yandex");
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
      // Reset BEFORE handing back to My Vibes. Skipping the last queued track
      // used to leave currentlyPlaying pointing at the dead song: no
      // music_done, no music_start and no watchdog would ever fire again, so
      // smartAdd saw the stale value as "busy" and queued every later request
      // behind a phantom track until a reload.
      this._resetTrack();
      bridge.send("next", null, "yandex");
      return;
    }
    this._resetTrack();
    this._playNext();
  }

  pauseMusic() {
    this._musicPaused = true;
    bridge.send("pause", null, "yandex");
    this._obsSend({ type: "music_pause" });
    if (this._ytPlayerActive) bridge.send("pause", null, "youtube");
    this._broadcastNowPlaying();
    this.log("⏸ Music paused (remote)");
  }

  resumeMusic() {
    this._musicPaused = false;
    bridge.send("resume", null, "yandex");
    // Mirror pauseMusic: it pauses BOTH players when a YouTube tab is active,
    // so resuming only Yandex left the current YouTube track paused forever
    // while Yandex started playing its own track audibly underneath — the
    // widget said playing, the audio was a different song entirely.
    if (this._ytPlayerActive) bridge.send("resume", null, "youtube");
    this._obsSend({ type: "music_resume" });
    this._broadcastNowPlaying();
    this.log("▶ Music resumed (remote)");
  }

  _obsSend(obj) {
    if (this._obsWs?.readyState === WebSocket.OPEN)
      this._obsWs.send(JSON.stringify(obj));
  }

  prevSong() {
    bridge.send("prev", null, "yandex");
    this.log("⏮ Prev (remote)");
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

  async _connectObs() {
    const token = await getBusToken();
    if (!token) {
      this.log("❌ No /obs bus token — cannot connect (is the server local?)");
      return;
    }
    const ws = new WebSocket(busUrl(token));
    ws.onopen    = () => this.log("📡 OBS connected");
    ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        // Answer regardless of cover: gating on it left a coverless track
        // unanswerable, so a client that reconnected mid-track kept showing
        // the server's last cover-bearing (i.e. previous) song forever.
        if (msg.request === "now_playing") { this._broadcastNowPlaying(); return; }
        switch (msg.type) {
          case "music_pause":  this.pauseMusic();  break;
          case "music_resume": this.resumeMusic(); break;
          case "music_skip":   this.skip();        break;
          case "music_prev":   this.prevSong();    break;
        }
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
      type:          "now_playing",
      title:         this.nowPlaying.title,
      artist:        this.nowPlaying.artist,
      version:       this.nowPlaying.version      ?? "",
      cover:         this.nowPlaying.cover,
      coverFallback: this.nowPlaying.coverFallback ?? null,
      source:        this.nowPlaying.source        ?? "",
      url:           this.nowPlaying.url           ?? "",
      queue_size:    this.queue?.size() ?? 0,
      paused:        this._musicPaused,
    }));
  }

  // ── Song name parsing ────────────────────────────────────

  /** Parse "title[\nversion]\nauthor" or "title by author" → {title, version, artist}. */
  _parseSongName(name) {
    let title, version = "", artist;
    if (name.includes("\n")) {
      const parts = name.split("\n").map(s => s.trim()).filter(Boolean);
      if (parts.length >= 3) {
        [title, version, artist] = parts;
      } else if (parts.length === 2) {
        [title, artist] = parts;
      } else {
        title = parts[0] ?? ""; artist = "";
      }
    } else {
      const byIdx = name.lastIndexOf(" by ");
      if (byIdx > 0) {
        title  = name.slice(0, byIdx).trim();
        artist = name.slice(byIdx + 4).trim();
      } else {
        title = name.trim(); artist = "";
      }
    }
    return { title: this._stripArtistFromTitle(title, artist), version, artist };
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

  // Both render functions below build DOM via textContent rather than
  // innerHTML template strings. currentlyPlaying/currentSongName/queued URLs
  // are all attacker-reachable: YOUTUBE_RE/YANDEX_RE (actions.js) validate
  // only a URL PREFIX with no trailing `$` anchor, so
  // "https://youtu.be/ID<img src=x onerror=...>" passes validation intact
  // and used to be interpolated straight into innerHTML here — script
  // execution in the localhost control-panel origin, which holds the Twitch
  // OAuth token and the /obs bus token in localStorage. A YouTube video
  // TITLE is equally attacker-controlled (upload one, or use an existing
  // video) and reaches currentSongName the same unescaped way. textContent
  // never parses its input as markup, so this closes the class outright
  // rather than trying to escape each interpolation site correctly.
  _updateStatusDisplay(el) {
    const s = this.getStatus();
    el.innerHTML = "";
    const addRow = (label, valueText, extraNode) => {
      const row = document.createElement("div");
      row.className = "status-item";
      const strong = document.createElement("strong");
      strong.textContent = label;
      const span = document.createElement("span");
      span.textContent = valueText;
      if (extraNode) span.appendChild(extraNode);
      row.append(strong, span);
      el.appendChild(row);
    };
    let ytBadge = null;
    if (s.ytPlayerActive) {
      ytBadge = document.createElement("span");
      ytBadge.style.color = "#f00";
      ytBadge.textContent = " ▶ YT";
    }
    addRow("Playing:", s.currentlyPlaying || "Nothing", ytBadge);
    addRow("Song:", s.currentSongName);
    addRow("Queue:", String(s.queueLength));
    addRow("Votes needed:", String(s.votesNeeded));
  }

  _updateQueueList(el) {
    const songs = this.queue?.all() ?? [];
    el.innerHTML = "";
    if (!songs.length) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No songs in queue";
      el.appendChild(p);
      return;
    }
    songs.forEach((url, i) => {
      const div = document.createElement("div");
      div.className = "queued-song-item";
      div.textContent = `${i + 1}. ${url}`;
      el.appendChild(div);
    });
  }

  // ── Context ──────────────────────────────────────────────

  getContextContribution() {
    return {
      musicQueue:  this,
      currentSong: `${this.nowPlaying.title} by ${this.nowPlaying.artist}`,
    };
  }
}
