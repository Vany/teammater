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
//   YouTube CLIENT — youtube.com, with yt_player in sessionStorage
// ─────────────────────────────────────────────────────────────

(function () {
  "use strict";

  const TAG  = "[MusicBridge]";
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, "⚠️", ...a);
  const err  = (...a) => console.error(TAG, "💥", ...a);

  const isMaster  = !!unsafeWindow.i_am_a_master;
  const isYandex  = location.hostname.includes("music.yandex.");
  const isYoutube = location.hostname.includes("youtube.com");

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
      if (u.searchParams.has("v")) clean.searchParams.set("v", u.searchParams.get("v"));
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
      GM_setValue("yt_next_is_player", true);
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
    let pausePending  = false;

    function onAudioReady(audio) {
      audioEl = audio;
      log(`audio captured, pausePending=${pausePending}`);
      if (pausePending) pause();
    }

    function pause() {
      clearInterval(pauseInterval);
      if (!audioEl) { warn("pause: no audio yet — pending"); pausePending = true; return; }
      pausePending = false;
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
      pausePending = false;
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
      const meta = document.querySelector(
        'div[class^="PlayerBarDesktopWithBackgroundProgressBar"] div[class^="Meta_metaContainer"]'
      );
      return {
        playing:     audioEl ? !audioEl.paused : false,
        currentTime: audioEl?.currentTime ?? 0,
        duration:    audioEl?.duration ?? 0,
        trackInfo:   meta?.innerText ?? "Unknown",
        url:         location.href,
      };
    }

    function hookAudio() {
      log("hooking HTMLMediaElement.prototype.play");
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (!this._bridgeHooked) {
          this._bridgeHooked = true;
          log("attaching play/ended listeners");
          onAudioReady(this);
          this.addEventListener("play", () => {
            const playerBar = document.querySelector(
              'div[class^="PlayerBarDesktopWithBackgroundProgressBar"], div[class^="PlayerBarMobile"]'
            );
            const meta     = playerBar?.querySelector('div[class^="Meta_metaContainer"]')
                          ?? document.querySelector('div[class^="Meta_metaContainer"]');
            const coverImg = playerBar?.querySelector('img[class*="_cover_"]');
            const cover    = coverImg?.src?.replace(/\/\d+x\d+$/, "/200x200") ?? null;
            const titleEl   = meta?.querySelector('[class*="Meta_title"]');
            const versionEl = meta?.querySelector('[class*="Meta_version"]');
            const artistEl  = meta?.querySelector('[class*="Meta_artists"]') ?? meta?.querySelectorAll('[class*="Meta_text"]')?.[1];
            // Fallback: full innerText split by newline (old behaviour)
            const rawText  = meta?.innerText ?? "";
            const name     = titleEl
              ? (titleEl.textContent.trim() + (versionEl ? "\n" + versionEl.textContent.trim() : "") + "\n" + (artistEl?.textContent.trim() ?? ""))
              : rawText;
            log(`music_start: "${name}" cover=${cover}`);
            sendToMaster("music_start", { name, cover });
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
        log("track URL — clicking play in 4s");
        hookAudio();
        setTimeout(() => safeClick('header[class^="TrackModal_header_"] button[aria-label="Playback"]'), 4000);
      } else if (location.href === "https://music.yandex.ru/") {
        log("My Vibes URL — clicking My Vibe in 4s");
        hookAudio();
        setTimeout(() => safeClick('button[aria-label="Play My Vibe"]'), 4000);
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
        case "query_status": sendToMaster("status_reply", status()); break;
        case "ping":         sendToMaster("pong", { type: "yandex" }); break;
        default:             warn(`unknown command: ${command}`);
      }
    });

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

    function validate(p) {
      const details  = p.videoDetails;
      const category = p.microformat?.playerMicroformatRenderer?.category ?? "";
      const views    = parseInt(details?.viewCount ?? "0");
      const duration = parseInt(details?.lengthSeconds ?? "0");
      if (category !== "Music") return `category "${category}" ≠ "Music"`;
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
        title:    p.videoDetails?.title  ?? "Unknown",
        author:   p.videoDetails?.author ?? "",
        duration: parseInt(p.videoDetails?.lengthSeconds ?? "0"),
        cover:         videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null,
        coverFallback: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
        url:      location.href,
      };
      log(`hooking "${info.title}" by "${info.author}"`);

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
      const video = document.querySelector("video");
      const p     = unsafeWindow.ytInitialPlayerResponse;
      return {
        type:        "youtube",
        playing:     video ? !video.paused : false,
        currentTime: video?.currentTime ?? 0,
        duration:    video?.duration ?? 0,
        trackInfo:   p?.videoDetails?.title ?? "Unknown",
        url:         location.href,
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
    const flag = GM_getValue("yt_next_is_player");
    log(`YouTube tab — yt_next_is_player=${flag}`);
    if (flag) {
      GM_deleteValue("yt_next_is_player");
      log("designated as PLAYER (flag)");
      initYoutube();
      return;
    }
    log("role: YouTube observer (not a player tab)");
    return;
  }

  log("role: observer (no role)");

})();
