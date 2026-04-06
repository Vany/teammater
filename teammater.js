// ==UserScript==
// @name         MusicBridge
// @namespace    http://tampermonkey.net/
// @version      2026-04-06
// @description  Bridges Yandex Music and YouTube into a unified stream music queue
// @author       ME
// @match        https://music.yandex.ru/**
// @match        https://www.youtube.com/**
// @match        https://localhost:8443/**
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yandex.ru
// @grant        GM_addValueChangeListener
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        unsafeWindow
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
//   YouTube CLIENT — youtube.com, with i_am_youtube_player = true (sessionStorage)
// ─────────────────────────────────────────────────────────────

(function () {
  "use strict";

  const isMaster  = !!unsafeWindow.i_am_a_master;
  const isYandex  = location.hostname.includes("music.yandex.");
  const isYoutube = location.hostname.includes("youtube.com");

  const TAG = "[MusicBridge]";
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, "⚠️", ...a);
  const err  = (...a) => console.error(TAG, "💥", ...a);

  log(`init — isMaster=${isMaster} isYandex=${isYandex} isYoutube=${isYoutube} url=${location.href}`);

  // Persist YouTube player role across navigations within the same tab
  let isYoutubePlayer = false;
  if (isYoutube && !isMaster) {
    const flag = GM_getValue("yt_next_is_player");
    log(`YouTube tab — yt_next_is_player=${flag} sessionStorage.yt_player=${sessionStorage.getItem("yt_player")}`);
    if (flag) {
      isYoutubePlayer = true;
      sessionStorage.setItem("yt_player", "1");
      GM_deleteValue("yt_next_is_player");
      log("YouTube tab designated as PLAYER (flag from GM)");
    } else if (sessionStorage.getItem("yt_player")) {
      isYoutubePlayer = true;
      log("YouTube tab resumed as PLAYER (sessionStorage)");
    }
    unsafeWindow.i_am_youtube_player = isYoutubePlayer;
  }

  // ── Transport ──────────────────────────────────────────────

  function sendMsg(target, command, payload) {
    log(`→ send target=${target} command=${command}`, payload ?? "");
    GM_setValue("message", { target, command, payload });
    GM_deleteValue("message");
  }

  function sendToMaster(command, payload) {
    log(`→ master command=${command}`, payload ?? "");
    sendMsg("master", command, payload);
  }

  // ── MASTER ─────────────────────────────────────────────────

  if (isMaster) {
    const replyListeners = {};

    GM_addValueChangeListener("message", (name, _old, msg) => {
      try {
        if (!msg || typeof msg !== "object") return;
        if (msg.target !== "master" && msg.target !== "all") return;
        log(`← recv command=${msg.command}`, msg.payload ?? "");
        if (replyListeners[msg.command]) replyListeners[msg.command](msg.payload);
        else warn(`no listener for command=${msg.command}`);
      } catch (e) { err("MASTER handler error", e); }
    });

    unsafeWindow.sendCommandToOtherTabs = (command, payload, target = "all") => {
      log(`sendCommandToOtherTabs target=${target} command=${command}`, payload ?? "");
      sendMsg(target, command, payload);
    };

    unsafeWindow.registerReplyListener = (name, fn) => {
      log(`registerReplyListener: ${name}`);
      replyListeners[name] = fn;
    };

    let _ytTab = null; // GM tab handle for the current YouTube player tab

    unsafeWindow.openYoutubePlayer = (url) => {
      log(`openYoutubePlayer: ${url}`);
      if (_ytTab) { log("openYoutubePlayer: closing previous YT tab"); _ytTab.close(); _ytTab = null; }
      GM_setValue("yt_next_is_player", true);
      _ytTab = GM_openInTab(url, { active: true });
      log("openYoutubePlayer: tab opened, ref stored");
    };

    unsafeWindow.closeYoutubePlayer = () => {
      if (_ytTab) { log("closeYoutubePlayer: closing YT tab"); _ytTab.close(); _ytTab = null; }
      else warn("closeYoutubePlayer: no tab ref to close");
    };

    log("role: MASTER");
    return;
  }

  // ── YANDEX CLIENT ──────────────────────────────────────────

  if (isYandex) {
    let _audioEl = null;       // set when audio element first plays
    let _pauseInterval = null;
    let _pausePending = false; // pause requested before audio existed

    function yandexPause() {
      log("yandexPause called");
      _pauseInterval && clearInterval(_pauseInterval);
      if (!_audioEl) {
        warn("yandexPause: no audio yet — setting pending flag");
        _pausePending = true;
        return;
      }
      _pausePending = false;
      log(`yandexPause: audio found paused=${_audioEl.paused} muted=${_audioEl.muted}`);
      _audioEl.muted = true;
      _audioEl.pause();
      // Force-hold: Yandex React may try to resume — keep muting + pausing
      _pauseInterval = setInterval(() => {
        if (!_audioEl) { clearInterval(_pauseInterval); return; }
        if (!_audioEl.paused) { log("yandexPause interval: re-pausing"); _audioEl.pause(); }
        _audioEl.muted = true;
      }, 200);
    }

    function yandexResume() {
      log("yandexResume called");
      _pausePending = false;
      clearInterval(_pauseInterval);
      _pauseInterval = null;
      if (!_audioEl) { warn("yandexResume: no audio element"); return; }
      log(`yandexResume: audio found paused=${_audioEl.paused} muted=${_audioEl.muted}`);
      _audioEl.muted = false;
      _audioEl.play();
    }

    // Store audio ref as soon as Yandex creates it; apply pending pause if needed
    function _onAudioReady(audio) {
      _audioEl = audio;
      log(`_onAudioReady: audio element captured, _pausePending=${_pausePending}`);
      if (_pausePending) yandexPause();
    }

    GM_addValueChangeListener("message", (name, _old, msg) => {
      try {
        if (!msg || typeof msg !== "object") return;
        if (msg.target !== "yandex" && msg.target !== "all") return;
        log(`← Yandex recv command=${msg.command}`, msg.payload ?? "");
        handleYandexCommand(msg.command, msg.payload, { yandexPause, yandexResume });
      } catch (e) { err("Yandex handler error", e); }
    });

    autoPlayYandex(_onAudioReady);
    log("role: Yandex CLIENT");
    return;
  }

  // ── YOUTUBE CLIENT ─────────────────────────────────────────

  if (isYoutube && isYoutubePlayer) {
    GM_addValueChangeListener("message", (name, _old, msg) => {
      try {
        if (!msg || typeof msg !== "object") return;
        if (msg.target !== "youtube" && msg.target !== "all") return;
        log(`← YouTube recv command=${msg.command}`, msg.payload ?? "");
        handleYoutubeCommand(msg.command, msg.payload);
      } catch (e) { err("YouTube handler error", e); }
    });

    // Auto-setup if page loaded directly at a watch URL
    if (isYoutubeWatchUrl()) {
      log("YouTube PLAYER: watch URL on load — calling setupYoutubePlayer()");
      setupYoutubePlayer();
    } else {
      log(`YouTube PLAYER: non-watch URL on load (${location.href}), waiting for song command`);
    }

    log("role: YouTube PLAYER");
    return;
  }

  if (isYoutube) {
    log("role: YouTube observer (not a player tab)");
  } else {
    log("role: observer (no role)");
  }

  // ════════════════════════════════════════════════════════════
  // YANDEX handlers
  // ════════════════════════════════════════════════════════════

  function handleYandexCommand(command, payload, { yandexPause, yandexResume } = {}) {
    switch (command) {
      case "song":         handleYandexSong(payload, yandexResume); break;
      case "pause":        yandexPause?.(); break;
      case "resume":       yandexResume?.(); break;
      case "next":         safeClick('button[aria-label="Next song"]'); break;
      case "query_status": sendToMaster("status_reply", yandexStatus()); break;
      case "ping":         sendToMaster("pong", { type: "yandex" }); break;
      default:             warn(`Yandex: unknown command "${command}"`);
    }
  }

  function handleYandexSong(url, yandexResume) {
    if (!url) { warn("handleYandexSong: empty url"); return; }
    log(`handleYandexSong: url=${url} current=${location.href}`);
    if (window.location.href !== url) {
      log("handleYandexSong: navigating to URL");
      window.location = url;
    } else {
      log("handleYandexSong: already on URL, resuming");
      yandexResume?.();
    }
  }

  function yandexStatus() {
    const audio = document.querySelector("audio");
    const meta = document.querySelector(
      'div[class^="PlayerBarDesktopWithBackgroundProgressBar"] div[class^="Meta_metaContainer"]'
    );
    const status = {
      playing: audio ? !audio.paused : false,
      currentTime: audio?.currentTime ?? 0,
      duration: audio?.duration ?? 0,
      trackInfo: meta?.innerText ?? "Unknown",
      url: location.href,
    };
    log("yandexStatus:", status);
    return status;
  }

  function autoPlayYandex(onAudioReady) {
    const trackRe = /^https:\/\/music\.yandex\.(ru|com)\/album\/\d+\/track\/\d+/;
    if (trackRe.test(location.href)) {
      log("autoPlayYandex: track URL, hooking audio + clicking play in 4s");
      hookYandexAudio(onAudioReady);
      setTimeout(() => safeClick('header[class^="TrackModal_header_"] button[aria-label="Playback"]'), 4000);
    } else if (location.href === "https://music.yandex.ru/") {
      log("autoPlayYandex: My Vibes URL, hooking audio + clicking My Vibe in 4s");
      hookYandexAudio(onAudioReady);
      setTimeout(() => safeClick('button[aria-label="Play My Vibe"]'), 4000);
    } else {
      log(`autoPlayYandex: no autoplay for URL=${location.href}, still hooking audio`);
      hookYandexAudio(onAudioReady);
    }
  }

  function hookYandexAudio(onAudioReady) {
    log("hookYandexAudio: patching HTMLMediaElement.prototype.play");
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (!this._endedHooked) {
        this._endedHooked = true;
        log("hookYandexAudio: attaching play/ended listeners to audio element");
        onAudioReady?.(this); // capture audio element ref
        this.addEventListener("play", () => {
          const meta = document.querySelector(
            'div[class^="PlayerBarDesktopWithBackgroundProgressBar"] div[class^="Meta_metaContainer"]'
          );
          const name = meta?.innerText ?? "";
          log(`Yandex music_start: "${name}"`);
          sendToMaster("music_start", name);
        });
        this.addEventListener("ended", () => {
          log(`Yandex music_done: ${location.href}`);
          sendToMaster("music_done", location.href);
        });
      }
      return origPlay.apply(this, args);
    };
  }

  // ════════════════════════════════════════════════════════════
  // YOUTUBE handlers
  // ════════════════════════════════════════════════════════════

  function handleYoutubeCommand(command, payload) {
    switch (command) {
      case "song":         handleYoutubeSong(payload); break;
      case "pause":        {
        log("YouTube pause");
        document.querySelector("video")?.pause();
        break;
      }
      case "resume":       {
        log("YouTube resume");
        document.querySelector("video")?.play();
        break;
      }
      case "query_status": sendToMaster("status_reply", youtubeStatus()); break;
      case "ping":         sendToMaster("pong", { type: "youtube" }); break;
      default:             warn(`YouTube: unknown command "${command}"`);
    }
  }

  function cleanYoutubeUrl(url) {
    try {
      const u = new URL(url);
      const clean = new URL("https://www.youtube.com/watch");
      if (u.searchParams.has("v")) clean.searchParams.set("v", u.searchParams.get("v"));
      if (u.searchParams.has("t")) clean.searchParams.set("t", u.searchParams.get("t"));
      return clean.toString();
    } catch { return url; }
  }

  function handleYoutubeSong(url) {
    if (!url) { warn("handleYoutubeSong: empty url"); return; }
    const clean = cleanYoutubeUrl(url);
    log(`handleYoutubeSong: url=${clean} (original=${url}) current=${location.href}`);
    const currentClean = cleanYoutubeUrl(location.href);
    if (currentClean !== clean) {
      log("handleYoutubeSong: navigating to URL");
      window.location = clean; // page reloads → setupYoutubePlayer() on next load
    } else {
      log("handleYoutubeSong: already on URL, calling setupYoutubePlayer()");
      setupYoutubePlayer();
    }
  }

  function isYoutubeWatchUrl() {
    return /youtube\.com\/watch/.test(location.href);
  }

  function setupYoutubePlayer() {
    log("setupYoutubePlayer: waiting for YT ready...");
    waitForYtReady()
      .then(({ p, video, player }) => {
        const details = p.videoDetails;
        log(`setupYoutubePlayer: got data — title="${details?.title}" category="${p.microformat?.playerMicroformatRenderer?.category}" duration=${details?.lengthSeconds}s views=${details?.viewCount}`);
        const error = validateYoutubeVideo(p);
        if (error) {
          warn(`setupYoutubePlayer: validation failed — ${error}`);
          sendToMaster("youtube_invalid", { url: location.href, reason: error });
          return;
        }
        log("setupYoutubePlayer: validation passed, hooking events + playing");
        hookYoutubeVideoEvents(p, video, player);
        playYoutubeVideo(player, video);
      })
      .catch((reason) => {
        warn(`setupYoutubePlayer: failed — ${reason}`);
        sendToMaster("youtube_invalid", { url: location.href, reason: reason ?? "timeout" });
      });
  }

  // Wait for ytInitialPlayerResponse, video element, and #movie_player to all be ready
  function waitForYtReady(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      (function check() {
        const p      = unsafeWindow.ytInitialPlayerResponse;
        const video  = document.querySelector("video");
        const player = document.querySelector("#movie_player");
        const ready  = !!(p?.videoDetails?.videoId && video && player);
        if (ready) {
          log(`waitForYtReady: ready — videoId=${p.videoDetails.videoId}`);
          return resolve({ p, video, player });
        }
        if (Date.now() > deadline) return reject("timeout waiting for player");
        setTimeout(check, 200);
      })();
    });
  }

  function validateYoutubeVideo(p) {
    const details  = p.videoDetails;
    const category = p.microformat?.playerMicroformatRenderer?.category ?? "";
    const views    = parseInt(details?.viewCount ?? "0");
    const duration = parseInt(details?.lengthSeconds ?? "0");

    if (category !== "Music")  return `category "${category}" ≠ "Music"`;
    if (views < 1000)          return `only ${views} views`;
    if (duration < 120)        return `too short (${duration}s, min 120)`;
    if (duration > 480)        return `too long (${duration}s, max 480)`;
    return null;
  }

  function hookYoutubeVideoEvents(p, video, player) {
    if (video._ytHooked) { log("hookYoutubeVideoEvents: already hooked, skipping"); return; }
    video._ytHooked = true;

    const info = {
      title:    p.videoDetails?.title  ?? "Unknown",
      author:   p.videoDetails?.author ?? "",
      duration: parseInt(p.videoDetails?.lengthSeconds ?? "0"),
      url:      location.href,
    };
    log(`hookYoutubeVideoEvents: hooking "${info.title}" by "${info.author}"`);

    video.addEventListener("play", () => {
      log(`YouTube play event → youtube_ready: "${info.title}"`);
      sendToMaster("youtube_ready", info);
    }, { once: true });

    if (!video.paused) {
      log("hookYoutubeVideoEvents: video already playing → immediate youtube_ready");
      sendToMaster("youtube_ready", info);
    }

    video.addEventListener("ended", () => {
      player.stopVideo?.();
      const clean = cleanYoutubeUrl(location.href);
      log(`YouTube ended → music_done: ${clean}`);
      sendToMaster("music_done", clean);
      // MASTER closes the tab via GM tab handle
    });
  }

  // Use YouTube's internal player API — most reliable, no DOM fragility
  function playYoutubeVideo(player, video) {
    if (typeof player.playVideo === "function") {
      log("playYoutubeVideo: calling player.playVideo()");
      player.playVideo();
      return;
    }
    warn("playYoutubeVideo: player.playVideo not available, falling back to video.play()");
    video.play().catch(() => {
      warn("playYoutubeVideo: video.play() failed, clicking .ytp-play-button");
      document.querySelector(".ytp-play-button")?.click();
    });
  }

  function youtubeStatus() {
    const video = document.querySelector("video");
    const p = unsafeWindow.ytInitialPlayerResponse;
    const status = {
      type:        "youtube",
      playing:     video ? !video.paused : false,
      currentTime: video?.currentTime ?? 0,
      duration:    video?.duration ?? 0,
      trackInfo:   p?.videoDetails?.title ?? "Unknown",
      url:         location.href,
    };
    log("youtubeStatus:", status);
    return status;
  }

  // ── Shared util ────────────────────────────────────────────

  function safeClick(selector) {
    const el = document.querySelector(selector);
    if (el) { log(`safeClick: "${selector}"`); el.click(); }
    else warn(`safeClick: element not found — "${selector}"`);
  }

})();
