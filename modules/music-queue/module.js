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
    this._probeTimer     = null;   // restore-probe deadline
    this._probeRetry     = null;   // held-deck retry
    this._pongTypes      = new Set(); // which tab types answered the last probe
    this._torndown       = false;  // set by doDisconnect; gates bridge listeners
    this._confirmedTabs  = new Set(); // tab types that have EVER answered a ping
  }

  getDisplayName() { return "🎵 Music Queue"; }

  /**
   * Can a request actually REACH a player right now?
   *
   * isConnected() only reports this module's checkbox: doConnect deliberately
   * warns rather than throwing when the MusicBridge UserScript is absent
   * (the script may initialise after this module, so failing there would be
   * wrong), and the module stays green. But the UserScript IS the delivery
   * path — without it every command is dropped, so a paid Music Request was
   * accepted, marked FULFILLED, and vanished. Callers that spend a viewer's
   * points must ask this, not isConnected().
   * @returns {boolean}
   */
  canDeliver() {
    return bridge.ok;
  }

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
    this._torndown = false;
    this._emptyUrl          = this.getConfigValue("empty_url", "https://music.yandex.ru/");
    this._voteSkipThreshold = this.getConfigInt("vote_skip_threshold", 3);
    this.needVoteSkip       = this._voteSkipThreshold;
    this.nowPlaying         = { ...this._parseSongName(this.getConfigValue("initial_song_name", "Silence by silencer")), cover: null, coverFallback: null, source: "", url: "" };
    this.queue              = new PersistentDeck(this.getConfigValue("persistence_key", "toplay"));

    this._setupListeners();
    this._connectObs();

    // ALWAYS probe first, empty deck or not. Starting anything synchronously
    // here races the status_reply that would tell us a YouTube tab from before
    // this reload is still audibly playing — and the empty-deck branch used to
    // start My Vibes straight over it. What to do once the probe answers
    // depends on the deck, and _probe decides that at fire time.
    this._probe();

    this.log(`✅ Music Queue initialized (${this.queue.size()} queued)`);
  }

  /**
   * Ask whether any player tab is listening, and start the held deck if one is.
   *
   * RETRIES until it succeeds, because the previous version probed exactly once
   * at connect and then told the operator to "open music.yandex.ru to start it"
   * — advice nothing in the code could act on. With smartAdd now correctly
   * queueing behind a held deck, that left music silent with no way back except
   * an undocumented tap on Skip.
   * @private
   */
  _probe() {
    this._cancelProbe();
    this._pongReceived = false;
    this._pongTypes.clear();
    // "all", not "yandex": a YouTube player tab left over from before a panel
    // reload must be discovered too, so it can be ADOPTED rather than played
    // over — see the status_reply listener.
    bridge.send("query_status", null, "all");
    bridge.send("ping", null, "all");
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      // Re-check at FIRE time. The module can be unchecked inside the probe
      // window, and starting here would drain the paid deck with the checkbox
      // off — the same class the index.js isEnabled() fix just closed.
      if (!this._live()) {
        this.log("⏸️ Restore probe abandoned — module no longer enabled");
        return;
      }
      if (this.currentlyPlaying) return; // adopted a live tab meanwhile
      if (this.queue.size() === 0) {
        // No deck to protect: hand to My Vibes, which consumes nothing and
        // arms no watchdog. Reached only after the probe window, so a live
        // YouTube tab has had its chance to be adopted first.
        this._cancelProbe();
        this._playNext();
        return;
      }

      // Which tab must exist depends on the deck HEAD. A YouTube track opens
      // its own tab, so it can always start; a Yandex track needs a Yandex tab
      // that is already open. Accepting any pong meant a stale PAUSED YouTube
      // tab could satisfy the probe, we would start a Yandex track into a void,
      // and the watchdog — which pings "yandex" specifically — would get no
      // answer and drain the paid deck exactly as before, through a new door.
      if (this._canPlay(this.queue.peekBottom())) {
        this.log("🎵 Player tab available — resuming restored queue");
        this._playNext();
        return;
      }
      this.log(`⏸️ No player tab answered — ${this.queue.size()} song(s) held; open music.yandex.ru and they will start automatically`);
      this._probeRetry = setTimeout(() => this._probe(), 30000);
    }, 5000);
  }

  /**
   * Can this URL actually be started right now?
   *
   * A YouTube track opens its own tab, so it always can. A Yandex track needs a
   * Yandex tab that is already open — sending `song` into a void looks like
   * playback to us, and the watchdog then reads the missing pong as "track
   * ended" and eats the next paid request, and the next.
   *
   * Only meaningful right after a probe, which populates _pongTypes on purpose.
   * It is deliberately NOT used to gate ordinary advances: on the normal path
   * no probe has run, _pongTypes is empty, and gating there would refuse to
   * advance a perfectly healthy queue. The later-advance case is handled in the
   * watchdog instead, by distinguishing a tab that died from one that never
   * existed (_confirmedTabs).
   * @private
   */
  _canPlay(url) {
    if (url === undefined || url === null) return true;   // My Vibes fallback
    if (this._isYoutube(url)) return true;                 // opens its own tab
    return this._pongTypes.has("yandex");
  }

  /** @private */
  _cancelProbe() {
    if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
    if (this._probeRetry) { clearTimeout(this._probeRetry); this._probeRetry = null; }
  }

  async doDisconnect() {
    // Bridge listeners cannot be unregistered (no such API in the UserScript),
    // so this flag is what stops them acting — see _live()/_on().
    this._torndown = true;
    this._cancelProbe();
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

  /**
   * May this module act on a bridge event right now?
   *
   * registerReplyListener has NO unregister API (teammater.js), so every
   * listener registered here lives in the UserScript for the life of the page
   * and keeps firing after doDisconnect. Without this gate, music_done and
   * youtube_invalid still ran _resetTrack + _playNext with the checkbox off —
   * the queue drained itself while the module showed disconnected. The probe
   * got a fire-time check for exactly this reason; these needed the same one,
   * which is why it lives in a single place both can use.
   * @private
   */
  _live() {
    // NOT `this.connected`: _setupListeners runs inside doConnect, where
    // connected is still false, so gating on it would drop the very
    // status_reply the connect-time probe is waiting for and adoption would
    // never happen. An explicit teardown flag says what is actually meant —
    // "this module has been switched off" — with no connect-time race.
    return this.isEnabled() && !this._torndown;
  }

  /**
   * Register a bridge listener that is inert while the module is not live.
   * Every listener in _setupListeners goes through here, so the check cannot be
   * forgotten for one of them the way it was forgotten for all of them.
   * @private
   */
  _on(event, fn) {
    bridge.listen(event, (...args) => {
      if (!this._live()) return;
      fn(...args);
    });
  }

  _setupListeners() {
    if (!bridge.ok) {
      this.log("⚠️ MusicBridge not available (UserScript not loaded?)");
    }

    this._on("music_done", (url) => {
      // Ignore My Vibes endings — Yandex auto-advances internally
      if (this.currentlyPlaying === this._emptyUrl || this.currentlyPlaying === null) return;
      // A skipped-but-still-loading YouTube tab eventually ends too. Advancing
      // on that would skip a second song that never played.
      if (this._isYoutube(url) && !this._isCurrentYoutube(url)) {
        this.log(`🚫 Ignoring music_done for a track we are not on: ${url}`);
        return;
      }
      this.log(`🎵 Track finished: ${url}`);
      if (this._ytPlayerActive) bridge.closeYoutube();
      this._resetTrack();
      this._playNext();
    });

    this._on("music_start", (info) => {
      // Same inactive-source guard status_reply has. The Yandex tab's pause is
      // page-lifetime closure state in the UserScript, so a reload or a freshly
      // opened music.yandex.ru during a YouTube track auto-plays My Vibes —
      // genuinely playing, so the UserScript's own paused-gate passes — and
      // that music_start would otherwise replace the YouTube track on the
      // overlay and in the paid "What's Playing" answer.
      const source = info?.source ?? "yandex";
      if (this._ytPlayerActive && source !== "youtube") {
        this.log(`🚫 Ignoring music_start from ${source} while a YouTube track is active`);
        // Put it back where the module expects it, rather than leaving a second
        // audible track running under the stream.
        bridge.send("pause", null, "yandex");
        return;
      }
      this.nowPlaying = {
        title:         info.title        ?? "",
        artist:        info.artist       ?? "",
        version:       info.version      ?? "",
        cover:         info.cover        ?? null,
        coverFallback: info.coverFallback ?? null,
        source:        info.source       ?? "yandex",
        url:           info.url          ?? "",
      };
      // Same pending-pause reconciliation as youtube_ready: a Yandex `song`
      // command reloads the tab, so a pause tapped while it was loading is
      // wiped by the reload and has to be re-applied when it reports in.
      if (this._musicPaused) {
        this.log("⏸️ Applying pause requested while the track was loading");
        bridge.send("pause", null, "yandex");
      }
      this.log(`🎵 Now playing: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
    });

    this._on("youtube_ready", (info) => {
      // A tab opened for a track that has since been skipped finishes loading
      // and reports in anyway — 1-12s later. Acting on it paused whatever is
      // now playing, hijacked nowPlaying, and its eventual music_done advanced
      // the queue past a song that never finished. Only the track we are
      // currently on may speak.
      if (!this._isCurrentYoutube(info?.url)) {
        this.log(`🚫 Ignoring late youtube_ready for a skipped track: ${info?.url}`);
        bridge.closeYoutube();
        return;
      }
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
      // Apply a pause requested while this tab was still loading. pauseMusic
      // can only reach the YouTube tab once _ytPlayerActive is true, and that
      // does not flip until right here — so a pause tapped during the 1-12s
      // load window went to Yandex instead and the video then started at full
      // volume while the phone, the widget and the flag all said paused.
      if (this._musicPaused) {
        this.log("⏸️ Applying pause requested while the track was loading");
        bridge.send("pause", null, "youtube");
      }
      this.log(`▶️ YouTube ready: ${this.nowPlaying.title} by ${this.nowPlaying.artist}`);
      this._broadcastNowPlaying();
      this._refreshStatusDisplay();
      this._startWatchdog("youtube");
    });

    this._on("youtube_invalid", ({ url, reason }) => {
      this.log(`❌ YouTube invalid [${reason}]: ${url}`);
      bridge.closeYoutube();
      this._resetTrack();
      this._playNext();
    });

    this._on("status_reply", (data) => {
      if (!data?.trackInfo) return;
      const replyId = this._youtubeVideoId(data.url);

      const isYoutubeReply = (data.source ?? data.type) === "youtube";
      if (isYoutubeReply && !this._ytPlayerActive) {
        if (!this.currentlyPlaying && data.playing) {
          // ADOPT. This is the reconnect case the guard existed for and which
          // the id check had made unreachable: after a panel reload
          // currentlyPlaying is null, so nothing could ever match. Meanwhile a
          // YouTube tab is still audibly playing, and starting the deck over it
          // gave two songs at once. Take ownership of what is already playing
          // instead of competing with it.
          this.currentlyPlaying = data.url;
          this._ytPlayerActive = true;
          this._cancelProbe();
          this._startWatchdog("youtube");
          this.log(`📺 Adopted the YouTube tab already playing: ${data.url}`);
        } else if (replyId && replyId === this._youtubeVideoId(this.currentlyPlaying)) {
          // Believe a tab only when it is on the track we think is playing. A
          // SKIPPED tab is left open and merely paused, and answers forever —
          // resurrecting from it sent a later `resume` to the wrong video.
          this._ytPlayerActive = true;
          this.log("📺 YouTube player tab detected on reconnect");
        }
      }

      // Do not let an inactive player rewrite what is on screen. The Yandex tab
      // stays open and answering while a YouTube song plays, so its reply used
      // to overwrite nowPlaying with a stale track — putting the wrong song on
      // the OBS overlay and into the paid "What's Playing" answer. Same defect
      // as the music_start synthesis fixed in the UserScript; this is the
      // other half of it, on the module side.
      // Match on `source`, NOT `type`. status_reply and pong are different
      // payloads: pong carries {type} from BOTH tabs, but status_reply carries
      // `type` only from YouTube — Yandex's status() has `source: "yandex"` and
      // no type at all. Testing `data.type` therefore never fired for the one
      // tab this guard exists to block, so the first version of it was inert.
      // Both status() implementations do carry `source`.
      const replySource = data.source ?? data.type;
      const activeSource = this._ytPlayerActive ? "youtube" : "yandex";
      if (replySource && replySource !== activeSource) {
        this.log(`🚫 Ignoring status_reply from inactive ${replySource} player`);
        return;
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

    this._on("pong", ({ type }) => {
      this.log(`🏓 Pong from ${type}`);
      this._pongReceived = true;
      if (type) {
        this._pongTypes.add(type);
        this._confirmedTabs.add(type); // never cleared: "has existed this session"
      }
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
    // Clear the remote pause HERE, not in _playNext: a `song` command reloads
    // the Yandex tab and wipes the pause the tab was holding, so starting a
    // track while _musicPaused is true left the flag lying about audible music.
    // _playNext and smartAdd's idle branch both reach playback through this
    // one function — putting it in _playNext covered only half the paths,
    // which is what co-reviewer 14176a52 caught.
    if (this._musicPaused) {
      this.log("▶️ Paused state cleared by track change");
      this._musicPaused = false;
    }
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
        if (this._pongReceived) return;
        // "Never answered" is NOT "died mid-track", and only the second one
        // justifies eating a paid request. If this tab type has never once
        // ponged, the tab does not exist — advancing would shift and persist
        // away one song every ~65s until the deck was empty, having played
        // nothing. Hold and re-probe instead; the deck is the thing we cannot
        // get back.
        if (!this._confirmedTabs.has(tabType)) {
          // PUT THE SONG BACK. Holding it as currentlyPlaying was a lie — the
          // track never started — and the lie wedged its own recovery: _probe
          // returns early on `if (this.currentlyPlaying) return`, so the 30s
          // retry scheduled here could never fire, and a stray music_done from
          // any unrelated tab would have been accepted as this phantom's end
          // and silently skipped the paid song. Restoring the deck and clearing
          // the track is the only honest description of "we could not start it".
          const stalled = this.currentlyPlaying;
          this._resetTrack();
          if (stalled && stalled !== this._emptyUrl) this.queue.unshift(stalled);
          this.log(`⏸️ Watchdog: no ${tabType} tab has ever answered — ${this.queue.size()} song(s) held, retrying every 30s`);
          this._cancelProbe();
          this._probeRetry = setTimeout(() => this._probe(), 30000);
          return;
        }
        this.log(`⚠️ Watchdog: no pong from ${tabType} — advancing queue`);
        // DEMOTE the tab type. _confirmedTabs answered "did this ever exist",
        // but the question that justifies eating a paid request is "does one
        // exist NOW" — so a tab closed mid-set looked like a fresh death on
        // every miss and drained the whole deck at one song per ~65s. After one
        // advance the type is unconfirmed again, so the NEXT miss takes the
        // hold branch above: at most one song is lost to a genuinely dying tab.
        this._confirmedTabs.delete(tabType);
        this._resetTrack();
        this._playNext();
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
    // A non-empty deck is NOT idle even when nothing is playing yet: that is
    // exactly the restored-queue state above, and playing immediately there
    // would jump the paid songs being held. This is the ordering half of the
    // original bug; the connect-time probe (_probe) is the starting half.
    const idle =
      (this.currentlyPlaying === null || this.currentlyPlaying === this._emptyUrl) &&
      this.queue.size() === 0;
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
    const wasYoutube = this._ytPlayerActive || this._isYoutube(this.currentlyPlaying);
    if (this._ytPlayerActive) {
      bridge.send("pause", null, "youtube");
      this._ytPlayerActive = false;
    }
    // A YouTube tab opened for a track we are now skipping is still LOADING,
    // and _ytPlayerActive stays false for the whole 1-12s before its
    // youtube_ready arrives — so the pause above misses it entirely. The
    // youtube_ready and music_done listeners therefore check the event against
    // the current track (_isCurrentYoutube) rather than trusting the flag.
    if (this.queue.size() === 0) {
      this._stopWatchdog();
      // Reset BEFORE handing back to My Vibes. Skipping the last queued track
      // used to leave currentlyPlaying pointing at the dead song: no
      // music_done, no music_start and no watchdog would ever fire again, so
      // smartAdd saw the stale value as "busy" and queued every later request
      // behind a phantom track until a reload.
      this._resetTrack();
      // Hand back to My Vibes properly. `next` alone was sent to a Yandex tab
      // that THIS MODULE had put into a persistent 200ms re-pause loop when the
      // YouTube song started, and nothing ever lifted it — so skipping the last
      // queued track when it was a YouTube one advanced a paused tab and left
      // the stream in silence, with the YouTube tab still open.
      if (wasYoutube) {
        bridge.closeYoutube();
        bridge.send("resume", null, "yandex");
      }
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
    // Resume ONLY the active player. Pause is asymmetric on purpose: while a
    // YouTube track plays, the Yandex tab is already held in the 200ms
    // re-pause loop _playSong put it in, so pausing it again is a no-op.
    // Resuming it is NOT — mirroring resume to both lifted that hold and
    // restarted the Yandex track underneath the YouTube video, two songs at
    // once. The earlier mirror fixed the reverse case and created this one.
    if (this._ytPlayerActive) {
      bridge.send("resume", null, "youtube");
    } else {
      bridge.send("resume", null, "yandex");
    }
    this._obsSend({ type: "music_resume" });
    this._broadcastNowPlaying();
    this.log("▶ Music resumed (remote)");
  }

  _obsSend(obj) {
    if (this._obsWs?.readyState === WebSocket.OPEN)
      this._obsWs.send(JSON.stringify(obj));
  }

  /**
   * True when `url` is the YouTube track currently playing.
   * Compared by video id — the module stores the URL as requested while the tab
   * reports location.href after navigating to the cleaned form.
   * @private
   */
  _isCurrentYoutube(url) {
    const id = this._youtubeVideoId(url);
    return Boolean(id) && id === this._youtubeVideoId(this.currentlyPlaying);
  }

  prevSong() {
    // Mirror the ACTIVE player, as pauseMusic()/resumeMusic() already do. Sent
    // blindly to Yandex, the mobile ⏮ button mutated a tab that this module had
    // deliberately paused while a YouTube song played.
    if (this._ytPlayerActive) {
      this.log("⏮ Prev ignored — a YouTube track is playing (no previous-track concept)");
      return;
    }
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
