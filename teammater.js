// ==UserScript==
// @name         yandexmusic nexter (fixed for new UI)
// @namespace    http://tampermonkey.net/
// @version      2025-08-06
// @description  Skip songs in Yandex Music with cross-tab commands (new UI compatible)
// @author       ME
// @match        https://music.yandex.ru/**
// @match        https://localhost:8443
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yandex.ru
// @grant        GM_addValueChangeListener
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";
  var replylisteners = {};

  function safeClick(path) {
    const btn = document.querySelector(path);
    if (btn) {
      btn.click();
      console.log("➡️ Clicked");
    } else {
      console.warn("⚠️ button not found");
    }
  }

  function hookAudioStartStopped(start, stop) {
    const oldPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (!this._endedHooked) {
        this._endedHooked = true;
        this.addEventListener("play", () => {
          console.log("🎵 Track started:", this.currentSrc);
          try {
            start && start(this);
          } catch (e) {
            console.error("start callback error", e);
          }
        });
        this.addEventListener("ended", () => {
          console.log("🎵 Track finished:", this.currentSrc);
          try {
            stop && stop(this);
          } catch (e) {
            console.error("callback error", e);
          }
        });
      }
      return oldPlay.apply(this, args);
    };
  }

  function handleCommand(command, payload) {
    if (!command) return;
    if (command == "song") {
      window.location = payload;
    } else {
      console.warn("⚠️ Unknown command:", command);
    }
  }

  if (!unsafeWindow.i_am_a_master) {
    GM_addValueChangeListener("message", (name, oldValue, newValue, remote) => {
      try {
        if (!newValue || typeof newValue !== "object") return;
        handleCommand(newValue.command, newValue.payload);
      } catch (err) {
        console.error("💥 Error in message handler:", err);
      }
    });
  } else {
    GM_addValueChangeListener("message", (name, oldValue, newValue, remote) => {
      try {
        if (!newValue || typeof newValue !== "object") return;

        if (newValue.command && replylisteners[newValue.command]) {
          replylisteners[newValue.command](newValue.payload);
        } else {
          console.log(replylisteners);
          console.warn(
            "Unknown command " + newValue.command + "  => " + newValue.payload,
          );
        }
      } catch (err) {
        console.error("💥 Error in reply handler:", err);
      }
    });
  }

  unsafeWindow.sendCommandToOtherTabs = function (command, payload) {
    GM_setValue("message", { command, payload });
    GM_deleteValue("message"); // cleanup
  };

  unsafeWindow.registerReplyListener = (name, listener) => {
    console.log("registerReplyListener", name);
    replylisteners[name] = listener;
  };

  function registerMusicHandler() {
    hookAudioStartStopped(
      (th) => {
        sendCommandToOtherTabs(
          "music_start",
          document.querySelector(
            'div[class^="PlayerBarDesktopWithBackgroundProgressBar"] div[class^="Meta_metaContainer"]',
          ).innerText,
        );
      },
      (th) => {
        sendCommandToOtherTabs("music_done", window.location.href);
      },
    );
  }

  // Auto-play tracks when directly loaded
  function autoPlayTrack() {
    const trackUrlPattern =
      /^https:\/\/music\.yandex\.(ru|com)\/album\/\d+\/track\/\d+/;

    if (trackUrlPattern.test(window.location.href)) {
      registerMusicHandler();
      setTimeout(() => {
        console.log("🎵 Track URL detected, attempting auto-play");
        safeClick(
          'header[class^="TrackModal_header_"] button[aria-label="Playback"]',
        );
      }, 4000);
    } else if (window.location.href == "https://music.yandex.ru/") {
      registerMusicHandler();
      setTimeout(() => {
        safeClick('button[aria-label="Play My Vibe"]');
      }, 4000);
    }
  }

  console.log(
    "✅ yandexmusic nexter loaded",
    unsafeWindow.i_am_a_master ? "⛑️ MASTER" : "🪲 CLIENT",
  );

  // Check for auto-play on load
  autoPlayTrack();
})();
