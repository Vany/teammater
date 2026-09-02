// ==UserScript==
// @name         MusicBridge
// @namespace    http://tampermonkey.net/
// @version      2026-04-06
// @description  Bridges Yandex Music and YouTube into a unified stream music queue
// @author       ME
// @match        https://music.yandex.ru/**
// @match        https://www.youtube.com/**
// @match        https://youtu.be/**
// @match        https://localhost:8443/**
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yandex.ru
// @grant        GM_addValueChangeListener
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

// ─────────────────────────────────────────────────────────────
// Message protocol
//   All messages: { target: "yandex"|"youtube"|"master"|"all", command, payload }
//   Transport: GM_setValue("message", msg) → GM_addValueChangeListener on all tabs
//
// Roles:
//   MASTER       — localhost:8443  (i_am_a_master = true on window)
//   Yandex CLIENT — music.yandex.ru
//   YouTube CLIENT — youtube.com, with yt_player === "1" in sessionStorage
//                     (claimed via a videoId-scoped GM flag; see role dispatch)
// ─────────────────────────────────────────────────────────────

(function () {
  "use strict";

  const TAG  = "[MusicBridge]";
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, "⚠️", ...a);
  const err  = (...a) => console.error(TAG, "💥", ...a);

  const isMaster  = !!unsafeWindow.i_am_a_master;
  const isYandex  = location.hostname.includes("music.yandex.");
  const isYoutube = location.hostname.includes("youtube.com") || location.hostname === "youtu.be";

  log(`init — isMaster=${isMaster} isYandex=${isYandex} isYoutube=${isYoutube} url=${location.href}`);

  // ── Shared transport ───────────────────────────────────────

  function sendMsg(target, command, payload) {
    log(`→ ${target}::${command}`, payload ?? "");
    GM_setValue("message", { target, command, payload });
    GM_deleteValue("message");
  }

  function sendToMaster(command, payload) {
    sendMsg("master", command, payload);
  }

  function onMessage(targetRole, handler) {
    GM_addValueChangeListener("message", (_name, _old, msg) => {
      try {
        if (!msg || typeof msg !== "object") return;
        if (msg.target !== targetRole && msg.target !== "all") return;
        log(`← ${targetRole}::${msg.command}`, msg.payload ?? "");
        handler(msg.command, msg.payload);
      } catch (e) { err(`${targetRole} handler error`, e); }
    });
  }

  // ── Shared utils ───────────────────────────────────────────

  function safeClick(selector) {
    const el = document.querySelector(selector);
    if (el) { log(`click: "${selector}"`); el.click(); }
    else warn(`element not found: "${selector}"`);
  }

  function cleanYoutubeUrl(url) {
    try {
      const u     = new URL(url);
      const clean = new URL("https://www.youtube.com/watch");
      // youtu.be/VIDEO_ID → extract id from pathname
      if (u.hostname === "youtu.be") {
        const v = u.pathname.slice(1); // strip leading /
        if (v) clean.searchParams.set("v", v);
      } else {
        if (u.searchParams.has("v")) clean.searchParams.set("v", u.searchParams.get("v"));
      }
      if (u.searchParams.has("t")) clean.searchParams.set("t", u.searchParams.get("t"));
      return clean.toString();
    } catch { return url; }
  }

  // ══════════════════════════════════════════════════════════
  // MASTER role
  // ══════════════════════════════════════════════════════════

  function initMaster() {
    const listeners = {};

    onMessage("master", (command, payload) => {
      if (listeners[command]) listeners[command](payload);
      else warn(`no listener for command=${command}`);
    });

    unsafeWindow.sendCommandToOtherTabs = (command, payload, target = "all") => {
      sendMsg(target, command, payload);
    };

    unsafeWindow.registerReplyListener = (name, fn) => {
      log(`registerReplyListener: ${name}`);
      listeners[name] = fn;
    };

    let _ytTab = null;

    unsafeWindow.openYoutubePlayer = (url) => {
      log(`openYoutubePlayer: ${url}`);
      if (_ytTab) { log("closing previous YT tab"); _ytTab.close(); _ytTab = null; }
      // Name the video the claim is FOR. A bare `true` was claimable by any
      // youtube.com page that happened to load next — including one the
      // streamer opened themselves — which then drove the queue with the wrong
      // video while closeYoutubePlayer() closed the innocent tab.
      // Via cleanYoutubeUrl so the short form is covered: youtu.be/ID carries
      // the id in the PATH and has no ?v= at all, so reading searchParams
      // directly returned null for a first-class input — and a null id makes
      // the claim unscoped again, which is the whole defect this scoping was
      // added to close.
      let videoId = null;
      try { videoId = new URL(cleanYoutubeUrl(url)).searchParams.get("v"); } catch { /* keep null */ }
      GM_setValue("yt_next_is_player", { videoId, at: Date.now() });
      _ytTab = GM_openInTab(url, { active: true });
    };

    unsafeWindow.closeYoutubePlayer = () => {
      if (_ytTab) { log("closeYoutubePlayer"); _ytTab.close(); _ytTab = null; }
      else warn("closeYoutubePlayer: no tab ref");
    };

    log("role: MASTER");
  }

  // ══════════════════════════════════════════════════════════
  // YANDEX role
  // ══════════════════════════════════════════════════════════

  function initYandex() {
    // Audio element captured on first play; pausing with interval beats React's state machine
    let audioEl       = null;
    let pauseInterval = null;
    let shouldBePaused = false; // persistent intent — survives track changes in My Vibes

    function onAudioReady(audio) {
      audioEl = audio;
      log(`audio captured, shouldBePaused=${shouldBePaused}`);
      if (shouldBePaused) pause();
    }

    function pause() {
      shouldBePaused = true;
      clearInterval(pauseInterval);
      if (!audioEl) { warn("pause: no audio yet — pending"); return; }
      log(`pause audio (paused=${audioEl.paused} muted=${audioEl.muted})`);
      audioEl.muted = true;
      audioEl.pause();
      pauseInterval = setInterval(() => {
        if (!audioEl) { clearInterval(pauseInterval); return; }
        if (!audioEl.paused) { log("re-pausing"); audioEl.pause(); }
        audioEl.muted = true;
      }, 200);
    }

    function resume() {
      shouldBePaused = false;
      clearInterval(pauseInterval);
      pauseInterval = null;
      if (!audioEl) { warn("resume: no audio"); return; }
      log(`resume audio (paused=${audioEl.paused} muted=${audioEl.muted})`);
      audioEl.muted = false;
      audioEl.play();
    }

    function navigateOrResume(url) {
      if (!url) { warn("song: empty url"); return; }
      log(`song url=${url} current=${location.href}`);
      if (location.href !== url) { log("navigating"); window.location = url; }
      else { log("already on URL, resuming"); resume(); }
    }

    function status() {
      const track = readCurrentTrack();
      return {
        playing:       audioEl ? !audioEl.paused : false,
        currentTime:   audioEl?.currentTime ?? 0,
        duration:      audioEl?.duration ?? 0,
        trackInfo:     track.title ? `${track.artist} - ${track.title}` : "Unknown",
        title:         track.title,
        artist:        track.artist,
        version:       track.version,
        cover:         track.cover,
        coverFallback: track.coverFallback,
        source:        "yandex",
        url:           location.href,
      };
    }

    function hookAudio() {
      log("hooking HTMLMediaElement.prototype.play");
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (shouldBePaused) {
          log("play() blocked — shouldBePaused");
          this.muted = true;
          return Promise.reject(new DOMException("play blocked by MusicBridge", "AbortError"));
        }
        if (!this._bridgeHooked) {
          this._bridgeHooked = true;
          log("attaching play/ended listeners");
          onAudioReady(this);
          this.addEventListener("play", () => {
            sendCurrentTrackToMaster();
          });
          this.addEventListener("ended", () => {
            log(`music_done: ${location.href}`);
            sendToMaster("music_done", location.href);
          });
        }
        return origPlay.apply(this, args);
      };
    }

    function autoPlay() {
      const trackRe = /^https:\/\/music\.yandex\.(ru|com)\/album\/\d+\/track\/\d+/;
      if (trackRe.test(location.href)) {
        log("track URL — clicking play in 4s if needed");
        hookAudio();
        setTimeout(() => {
          // Scoped to page header to avoid hitting the player bar button.
          // aria-label="Playback" only when paused; "Pause" when already playing — skip click in that case.
          // TrackModalControls = track-specific header (not the album header, not the player bar)
          const btn = document.querySelector('div[class*="TrackModalControls_controlsContainer"] button[aria-label="Playback"]');
          if (btn) { log("clicking track Playback"); btn.click(); }
          else { log("track already playing — no click needed"); }
        }, 4000);
      } else if (location.href === "https://music.yandex.ru/") {
        log("My Vibes URL — clicking play in 4s");
        hookAudio();
        setTimeout(() => safeClick('button[class*="AlbumCover_playButton"]'), 4000);
      } else {
        log(`no autoplay for ${location.href}, hooking audio only`);
        hookAudio();
      }
    }

    onMessage("yandex", (command, payload) => {
      switch (command) {
        case "song":         navigateOrResume(payload); break;
        case "pause":        pause(); break;
        case "resume":       resume(); break;
        case "next":         safeClick('button[aria-label="Next song"]'); break;
        case "prev":         safeClick('button[aria-label="Previous song"]'); break;
        case "query_status": {
          sendToMaster("status_reply", status());
          // music_start means "a track STARTED", per SPEC — it must not be
          // synthesised from whatever the playerbar happens to show. This tab
          // is paused whenever a YouTube track is playing, and the master
          // overwrites nowPlaying unconditionally, so firing here put the stale
          // Yandex track on the OBS overlay and into the "What's Playing"
          // reward while entirely different audio was on stream.
          sendCurrentTrackToMaster();
          break;
        }
        case "ping":         sendToMaster("pong", { type: "yandex" }); break;
        default:             warn(`unknown command: ${command}`);
      }
    });

    function readCurrentTrack() {
      const trackEl  = document.querySelector('div[class*="VibePlayerbarMeta_trackNameText"]:not([aria-hidden="true"])');
      const rawText  = trackEl?.textContent?.trim() ?? "";
      const sep      = "  —  ";
      const sepIdx   = rawText.indexOf(sep);
      const vibeArtist = document.querySelector('[class*="SeparatedArtists_root_variant_breakWord"]')
                           ?.getAttribute('title')?.trim() ?? null;
      let title, artist;
      if (sepIdx > -1) {
        title  = rawText.slice(sepIdx + sep.length).trim();
        artist = vibeArtist ?? rawText.slice(0, sepIdx).trim();
      } else {
        title  = rawText;
        artist = vibeArtist ?? "";
      }
      const coverImg = document.querySelector('img[class*="AlbumCover_cover__"]');
      const cover    = coverImg?.src?.replace(/\/\d+x\d+$/, "/200x200") ?? null;
      return { title, artist, version: "", cover, coverFallback: null, source: "yandex", url: location.href };
    }

    function sendCurrentTrackToMaster() {
      // Single gate for every music_start this tab emits. Paused means this is
      // not our track: either the streamer paused, or the master paused us
      // because a YouTube song took over.
      if (!audioEl || audioEl.paused) {
        log("music_start suppressed — audio not playing");
        return;
      }
      const info = readCurrentTrack();
      if (!info.title) return;
      log(`music_start: "${info.title}" by "${info.artist}" cover=${info.cover}`);
      sendToMaster("music_start", info);
    }

    // Direct /obs bus connection — handles pause/resume without Tampermonkey on the remote end
    // fetch() runs in the PAGE's origin (music.yandex.ru), so a plain fetch
    // to localhost:8443 is a cross-origin request — the server sends no CORS
    // headers (never needed one before), so the browser blocks it outright
    // and the caught error was silent, retrying forever. GM_xmlhttpRequest
    // runs in the userscript's own privileged context instead, which is
    // exactly what it's for: bypassing page-origin CORS without having to
    // open up the server's response headers to a third-party origin.
    function fetchBusToken() {
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: "https://localhost:8443/api/info",
          onload: (res) => {
            try { resolve(JSON.parse(res.responseText).bus_token || null); }
            catch { resolve(null); }
          },
          onerror: () => resolve(null),
        });
      });
    }

    async function connectObsBus() {
      // The bus requires a token; this script talks to localhost, and
      // /api/info hands bus_token to loopback callers only.
      const token = await fetchBusToken();
      if (!token) {
        log("no /obs bus token — retrying in 3s");
        setTimeout(connectObsBus, 3000);
        return;
      }
      const ws = new WebSocket(`wss://localhost:8443/obs?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        // Re-send current track info so master has up-to-date artist on
        // reconnect/reload — but ONLY if this tab is the one actually playing.
        // A server restart or sleep/wake used to republish a paused tab's last
        // track as if it had just started.
        sendCurrentTrackToMaster();
      };
      ws.onmessage = ({ data }) => {
        try {
          const msg = JSON.parse(data);
          switch (msg.type) {
            // pause/resume only. music_skip and music_prev are handled by the
            // MASTER's Music Queue module, which owns the queue and reaches
            // this tab through the GM transport — acting on them HERE too made
            // every phone tap advance Yandex twice and desync the queue's
            // My Vibes fallback position. pause/resume stay because they are
            // idempotent and must work even with no master running.
            case "music_pause":  pause(); break;
            case "music_resume": resume(); break;
          }
        } catch {}
      };
      ws.onclose = () => setTimeout(connectObsBus, 3000);
      ws.onerror = () => {};
    }
    connectObsBus();

    autoPlay();
    log("role: Yandex CLIENT");
  }

  // ══════════════════════════════════════════════════════════
  // YOUTUBE role
  // ══════════════════════════════════════════════════════════

  function initYoutube() {
    function waitForReady(timeout = 10000) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeout;
        (function check() {
          const p      = unsafeWindow.ytInitialPlayerResponse;
          const video  = document.querySelector("video");
          const player = document.querySelector("#movie_player");
          if (p?.videoDetails?.videoId && video && player) {
            log(`player ready — videoId=${p.videoDetails.videoId}`);
            return resolve({ p, video, player });
          }
          if (Date.now() > deadline) return reject("timeout waiting for player");
          setTimeout(check, 200);
        })();
      });
    }

    // lore-ok[db5df4c7]: fixed in the .map() below — every entry is now anchored
    // with \b (on the sides that end in a word character), and the list is
    // sorted longest-first so multi-word phrases are not shadowed. The word
    // list itself is unchanged; the missing boundaries were the defect.
    const MUSIC_RE = new RegExp(
      [
        // General
        'music','song','audio','official','official video','official audio','official lyric',
        'lyric video','music video','video','track','single','album',
        'lyrics','live','performance','concert','recording','studio','hit','tune',
        // Featuring
        'feat','feat.','ft.','ft ','featuring',
        // Production
        'remix','cover','instrumental','karaoke','acapella','mashup','edit','version',
        'extended','demo','radio edit','dj mix','remaster','remastered',
        'acoustic','unplugged','visualizer','audio only',
        // Genres
        'pop','rock','rap','hip hop','jazz','blues','classical','electronic','edm',
        'trance','techno','metal','folk','country','reggae','soul','rnb','r&b','dance',
        'punk','indie','alternative','trap','lo-fi','house','disco','swing','gospel',
        'opera','latin','k-pop','j-pop','ambient','grunge','ska',
        // Release types
        'showcase','compilation','ost','soundtrack','theme','intro','outro','score',
        'suite','symphony','ballad','anthem','single release','ep','lp','mixtape',
        'premiere','debut','release','new release','original',
        // Industry
        'band','artist','singer','producer','group','vevo','official channel','record label',
        'playlist','mv',
      ]
      // Longest first: JS alternation is leftmost-first, so without this
      // 'official' would shadow 'official video' and the two would never be
      // counted as distinct keywords.
      .sort((a, b) => b.length - a.length)
      // Word boundaries are mandatory. Unbounded, this list matched INSIDE
      // ordinary words — 'ost' in "most", 'ep' in "episode", 'hit' in "white",
      // 'lp' in "help" — so "Most epic episode" scored two hits and any video
      // passed the category gate. Anchor only on the sides that actually end
      // in a word character: 'feat.' and 'ft.' end in punctuation, where \b
      // would demand a following word char and never match.
      .map(w => {
        const t = w.trim();
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return (/^\w/.test(t) ? '\\b' : '') + escaped + (/\w$/.test(t) ? '\\b' : '');
      })
      .join('|'),
      'i'
    );

    function looksLikeMusic(p) {
      const title = p.videoDetails?.title ?? "";
      const desc  = p.videoDetails?.shortDescription
                 ?? p.microformat?.playerMicroformatRenderer?.description?.simpleText
                 ?? "";
      const tags  = (p.videoDetails?.keywords ?? []).join(" ");
      const text  = `${title} ${desc} ${tags}`;
      const matches = text.match(new RegExp(MUSIC_RE.source, 'gi')) ?? [];
      const unique  = new Set(matches.map(m => m.toLowerCase()));
      return unique.size >= 2;
    }

    function validate(p) {
      const details  = p.videoDetails;
      const category = p.microformat?.playerMicroformatRenderer?.category ?? "";
      const views    = parseInt(details?.viewCount ?? "0");
      const duration = parseInt(details?.lengthSeconds ?? "0");
      if (category !== "Music") {
        if (!looksLikeMusic(p)) return `category "${category}" ≠ Music, no music keywords`;
        log(`category "${category}" ≠ Music but keywords match — treating as music`);
      }
      if (views < 1000)         return `only ${views} views`;
      if (duration < 120)       return `too short (${duration}s, min 120)`;
      if (duration > 480)       return `too long (${duration}s, max 480)`;
      return null;
    }

    function hookEvents(p, video, player) {
      if (video._bridgeHooked) { log("already hooked"); return; }
      video._bridgeHooked = true;

      const videoId = p.videoDetails?.videoId ?? "";
      const info = {
        title:         p.videoDetails?.title  ?? "Unknown",
        artist:        p.videoDetails?.author ?? "",
        version:       "",
        cover:         videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null,
        coverFallback: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
        source:        "youtube",
        url:           cleanYoutubeUrl(location.href),
        duration:      parseInt(p.videoDetails?.lengthSeconds ?? "0"),
      };
      log(`hooking "${info.title}" by "${info.artist}"`);

      video.addEventListener("play", () => {
        log(`play → youtube_ready: "${info.title}"`);
        sendToMaster("youtube_ready", info);
      }, { once: true });

      if (!video.paused) {
        log("already playing → immediate youtube_ready");
        sendToMaster("youtube_ready", info);
      }

      video.addEventListener("ended", () => {
        player.stopVideo?.();
        const clean = cleanYoutubeUrl(location.href);
        log(`ended → music_done: ${clean}`);
        sendToMaster("music_done", clean);
      });
    }

    function play(player, video) {
      if (typeof player.playVideo === "function") {
        log("player.playVideo()");
        player.playVideo();
      } else {
        warn("playVideo not available, falling back");
        video.play().catch(() => document.querySelector(".ytp-play-button")?.click());
      }
    }

    function setup() {
      log("waiting for YT ready...");
      waitForReady()
        .then(({ p, video, player }) => {
          const d = p.videoDetails;
          log(`got data — "${d?.title}" category=${p.microformat?.playerMicroformatRenderer?.category} ${d?.lengthSeconds}s ${d?.viewCount} views`);
          const error = validate(p);
          if (error) {
            warn(`validation failed: ${error}`);
            sendToMaster("youtube_invalid", { url: location.href, reason: error });
            return;
          }
          log("validation passed");
          hookEvents(p, video, player);
          play(player, video);
        })
        .catch((reason) => {
          warn(`setup failed: ${reason}`);
          sendToMaster("youtube_invalid", { url: location.href, reason: reason ?? "timeout" });
        });
    }

    function navigateOrSetup(url) {
      if (!url) { warn("song: empty url"); return; }
      const clean = cleanYoutubeUrl(url);
      log(`song url=${clean} current=${location.href}`);
      if (cleanYoutubeUrl(location.href) !== clean) {
        log("navigating");
        window.location = clean;
      } else {
        log("already on URL, calling setup()");
        setup();
      }
    }

    function status() {
      const video   = document.querySelector("video");
      const p       = unsafeWindow.ytInitialPlayerResponse;
      const videoId = p?.videoDetails?.videoId ?? null;
      const title   = p?.videoDetails?.title ?? "Unknown";
      const artist  = p?.videoDetails?.author ?? "";
      return {
        type:          "youtube",
        playing:       video ? !video.paused : false,
        currentTime:   video?.currentTime ?? 0,
        duration:      video?.duration ?? 0,
        trackInfo:     title,
        title,
        artist,
        version:       "",
        cover:         videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null,
        coverFallback: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
        source:        "youtube",
        url:           location.href,
      };
    }

    onMessage("youtube", (command, payload) => {
      switch (command) {
        case "song":         navigateOrSetup(payload); break;
        case "pause":        { log("pause"); document.querySelector("video")?.pause(); break; }
        case "resume":       { log("resume"); document.querySelector("video")?.play(); break; }
        case "query_status": sendToMaster("status_reply", status()); break;
        case "ping":         sendToMaster("pong", { type: "youtube" }); break;
        default:             warn(`unknown command: ${command}`);
      }
    });

    if (/youtube\.com\/watch/.test(location.href)) {
      log("watch URL on load — calling setup()");
      setup();
    }

    log("role: YouTube PLAYER");
  }

  // ══════════════════════════════════════════════════════════
  // Role dispatch
  // ══════════════════════════════════════════════════════════

  if (isMaster) {
    initMaster();
    return;
  }

  if (isYandex) {
    initYandex();
    return;
  }

  if (isYoutube) {
    // Role persistence, for real this time. sessionStorage is per-TAB and
    // survives navigation, which is exactly the property the header comment and
    // SPEC.md have always claimed and the code never had: the GM flag is
    // global and one-shot, so the first full page load consumed it and every
    // load after that — including the `song` command's own
    // `window.location = clean` — demoted the player to a dead observer that
    // answers nothing and stalls the master until its 65s watchdog.
    if (sessionStorage.getItem("yt_player") === "1") {
      log("role: YouTube PLAYER (restored from sessionStorage)");
      initYoutube();
      return;
    }

    // The designation names the VIDEO it was opened for. It used to be a bare
    // `true`, claimable by whichever youtube.com page loaded first — so a tab
    // the streamer opened themselves could steal it, play their own video,
    // drive the queue with it, and leave closeYoutubePlayer() closing the
    // innocent tab instead.
    const claim = GM_getValue("yt_next_is_player");
    const wantId = claim && typeof claim === "object" ? claim.videoId : null;
    const thisId = new URL(location.href).searchParams.get("v");
    log(`YouTube tab — claim=${JSON.stringify(claim)} thisVideo=${thisId}`);

    // Require a MATCH. `!wantId` used to mean "unscoped, anyone may take it",
    // which reopened the steal for every URL form that yielded no id.
    if (claim && wantId && wantId === thisId) {
      GM_deleteValue("yt_next_is_player");
      sessionStorage.setItem("yt_player", "1");
      log(`designated as PLAYER (claim${wantId ? " for " + wantId : ""})`);
      initYoutube();
      return;
    }

    log("role: YouTube observer (not a player tab)");
    return;
  }

  log("role: observer (no role)");

})();
