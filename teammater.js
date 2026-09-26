// ==UserScript==
// @name         MusicBridge
// @namespace    http://tampermonkey.net/
// @version      2026-09-26.1
// @description  Bridges Yandex Music and YouTube into a unified stream music queue
// @updateURL    http://localhost:8442/teammater.js
// @downloadURL  http://localhost:8442/teammater.js
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
//
// Updates: Tampermonkey pulls new versions from @updateURL — the local server
// serves this file straight from the repo — but ONLY installs one whose
// @version is higher than the installed one. Bump @version on every change or
// the fix never arrives. Plain http on :8442 on purpose: the https listener
// uses a self-signed cert, and an extension's background update fetch should
// not depend on whether that cert is trusted outside a clicked-through tab.

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
      // Clean ONCE and use it for both the claim id and the tab we open. The
      // raw url was being opened while only the id was computed from the clean
      // one — so `list=`/`index=` survived into the player tab and YouTube
      // autoadvanced into a playlist, which is the exact thing cleanYoutubeUrl
      // exists to prevent (SPEC.md, and teammater.test.js asserts the purpose).
      // The cleaning only ever ran on the `song`-to-YouTube path, which the
      // module never sends — every real playback goes through here.
      const cleanUrl = cleanYoutubeUrl(url);
      let videoId = null;
      try { videoId = new URL(cleanUrl).searchParams.get("v"); } catch { /* keep null */ }
      GM_setValue("yt_next_is_player", { videoId, at: Date.now() });
      _ytTab = GM_openInTab(cleanUrl, { active: true });
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

    /** The My Vibes page, compared by ORIGIN+PATH so a query string or hash
     *  does not make an equal page look different. */
    function isMyVibes(url) {
      try {
        const u = new URL(url, location.href);
        return u.origin === "https://music.yandex.ru" && (u.pathname === "/" || u.pathname === "");
      } catch { return false; }
    }

    /** A track page: exactly what the request validator (actions.js YANDEX_RE)
     *  accepts — album-prefixed OR bare `/track/N`. This used to require the
     *  album prefix, so a bare link passed validation, the tab navigated to it,
     *  and autoPlay fell through to "no autoplay": request accepted, points
     *  spent, nothing played. Yandex does not redirect the bare form (checked
     *  2026-09-26: HTTP 200, URL unchanged in the SPA). teammater.test.js pins
     *  this against YANDEX_RE so the two cannot drift apart again. */
    function isYandexTrack(url) {
      return /^https:\/\/music\.yandex\.(ru|com)\/(album\/\d+\/)?track\/\d+/.test(url);
    }

    /** When a play selector misses, name what IS on the page so the correct
     *  selector is one console paste away instead of a round of guessing. */
    function warnPlayCandidates() {
      const candidates = [...document.querySelectorAll("button")]
        .map((b) => ({
          cls: typeof b.className === "string" ? b.className : "",
          aria: b.getAttribute("aria-label") || "",
          test: b.getAttribute("data-test-id") || "",
          inTrackModal: !!b.closest('[class*="TrackModal"]'),
        }))
        .filter((c) => /play|pause|vibe|Слушать|Воспроизв|Пауза/i.test(`${c.cls} ${c.aria} ${c.test}`))
        .slice(0, 12);
      warn(`candidate play buttons on this page: ${JSON.stringify(candidates, null, 1)}`);
    }

    // The My Vibes play button. Yandex has redesigned this page before (SPEC
    // records the v4 change that broke the artist selector), so treat a miss as
    // "the markup moved", not "wait longer".
    const MY_VIBES_PLAY = 'button[class*="AlbumCover_playButton"]';

    /** Start My Vibes by clicking its play button. The ONLY way this page
     *  begins playing — there is nothing to resume until it does. */
    function startMyVibes() {
      log("starting My Vibes");
      hookAudio();

      // RETRY rather than one shot at a fixed 4s. That delay was a guess about
      // how long this SPA takes to render, and it loses the race on a cold load
      // — the button simply is not there yet and the single click is spent.
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        const btn = document.querySelector(MY_VIBES_PLAY);
        if (btn) {
          log(`My Vibes play button found after ${tries}s — clicking`);
          btn.click();
          clearInterval(timer);
          return;
        }
        if (tries < 15) return;
        clearInterval(timer);

        // Still nothing after 15s: the selector is stale, not slow.
        warn(`My Vibes play button NOT FOUND after ${tries}s — selector "${MY_VIBES_PLAY}" is stale`);
        warnPlayCandidates();
      }, 1000);
    }

    // The track page's header controls. Scoped to TrackModalControls so it can
    // never hit the player-bar button (that one resumes whatever played last).
    // aria-label is "Playback" while paused and "Pause" while playing.
    const TRACK_PLAY  = 'div[class*="TrackModalControls_controlsContainer"] button[aria-label="Playback"]';
    const TRACK_PAUSE = 'div[class*="TrackModalControls_controlsContainer"] button[aria-label="Pause"]';

    /** Start a requested track. Same retry-and-report shape as startMyVibes,
     *  for the same two reasons: the old one-shot click at a fixed 4s lost the
     *  race on a slow load, and a MISSING button was logged as "track already
     *  playing — no click needed". So a stale selector and a slow page both
     *  looked like success while the URL changed and nothing played. Now
     *  "already playing" must be positively observed (Pause shown, or the
     *  hooked audio element running); a miss after 15s is a loud warning with
     *  the candidates. */
    function startTrack() {
      hookAudio();
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        if (audioEl && !audioEl.paused) {
          log(`track audio already running after ${tries}s — no click needed`);
          clearInterval(timer);
          return;
        }
        if (document.querySelector(TRACK_PAUSE)) {
          log(`track shows Pause after ${tries}s — already playing, no click needed`);
          clearInterval(timer);
          return;
        }
        const btn = document.querySelector(TRACK_PLAY);
        if (btn) {
          log(`track Playback button found after ${tries}s — clicking`);
          btn.click();
          clearInterval(timer);
          return;
        }
        if (tries < 15) return;
        clearInterval(timer);
        warn(`track play button NOT FOUND after ${tries}s on ${location.href} — selector "${TRACK_PLAY}" is stale; nothing is playing`);
        warnPlayCandidates();
      }, 1000);
    }

    function navigateOrResume(url) {
      if (!url) { warn("song: empty url"); return; }
      log(`song url=${url} current=${location.href}`);
      if (location.href !== url) { log("navigating"); window.location = url; }
      else if (isMyVibes(url)) {
        // ALREADY HERE IS NOT ALREADY PLAYING. When the queue empties, the
        // master sends `song <root>` while the tab is already sitting on the
        // root — the previous track finished here and the page went idle. The
        // old branch called resume(), which play()s the audio element captured
        // for that finished track: a spent element (a real status_reply showed
        // duration 0.015s), so it ended within milliseconds, emitted an instant
        // music_done, re-announced the PREVIOUS song as music_start, and My
        // Vibes never started at all. The play button is the only thing that
        // starts this page, and until it is clicked there is nothing to resume.
        log("already on My Vibes but idle — starting it rather than resuming");
        startMyVibes();
      }
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

    let audioHooked = false;

    function hookAudio() {
      // Install ONCE per page. It replaces HTMLMediaElement.prototype.play with
      // a wrapper that closes over the previous one, so calling it again stacks
      // another layer — harmless once, but startMyVibes() now runs on every
      // queue drain without a reload, which would pile up wrappers for the life
      // of the tab.
      if (audioHooked) { log("audio already hooked"); return; }
      audioHooked = true;
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
      if (isYandexTrack(location.href)) {
        log("track URL — starting it");
        startTrack();
      } else if (isMyVibes(location.href)) {
        log("My Vibes URL — starting it");
        startMyVibes();
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
        // YouTube plays pre-roll ads in the SAME video element, and `ended`
        // fires when the ad ends too — which would report the song as finished
        // (and stopVideo() would kill the ad→content transition) before it ever
        // started. Ignore an `ended` that arrives while the player still says
        // an ad is showing, or that fires far short of the known duration.
        // NOTE: not verified against live YouTube — flagged by review as
        // unconfirmed, and this guard is written to be harmless if ads do not
        // in fact share the element: a real track end has ad-showing false and
        // currentTime at the duration, so it still passes.
        if (document.querySelector(".ad-showing")) {
          log("ended during an ad — ignoring");
          return;
        }
        const dur = info.duration;
        if (dur > 0 && video.currentTime > 0 && video.currentTime < dur * 0.5) {
          log(`ended at ${video.currentTime}s of ${dur}s — too early, ignoring`);
          return;
        }
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
