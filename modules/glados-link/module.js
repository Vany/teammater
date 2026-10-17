/**
 * glados-link — connects teammater to glados's device hub on c, so glados can drive it.
 *
 * vany 2026-10-10: the LLM moves out of teammater to glados; teammater dials c (configurable) and
 * executes her commands; only she may command it.
 *
 * Trust: mutual Ed25519. This browser keeps its own key (WebCrypto, non-extractable, in IndexedDB)
 * and the hub's public key, pinned at pairing. Pairing once: glados runs `hubctl pair teammater`
 * and gives vany a one-time code; vany enters it here. On every connect the hub proves it holds
 * the pinned key before anything runs, and this module proves its own.
 * The hub's certificate is self-signed: open https://c.local:8095 once in this browser and accept.
 *
 * Commands glados can send: say {audio, mime} (her own voice, played as sent) or
 * say {text with [emotion] tags, voice?, lang?} (browser voice fallback), sound {name}, voices, ping.
 * Events this device sends: chat (every Twitch chat line), error (the browser couldn't play).
 * Wire format: SPEC.md beside this file.
 */

import { BaseModule } from "../base-module.js";
import { pickVoice } from "../../utils.js";
import { EVENTS, chatEvent, playFailure, FAILURE_HINT, audioBlob } from "./wire.js";

const DB = "glados-link";
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function idb(op, key, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", op === "get" ? "readonly" : "readwrite");
      const store = tx.objectStore("kv");
      const req = op === "get" ? store.get(key) : op === "put" ? store.put(value, key) : store.delete(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

export class GladosLinkModule extends BaseModule {
  getDisplayName() {
    return "🤖 GLaDOS link";
  }

  getConfig() {
    return {
      connection: {
        hub_url: { type: "text", label: "Hub URL", default: "wss://c.local:8095", stored_as: "glados_hub_url" },
        device_id: { type: "text", label: "Device id", default: "teammater", stored_as: "glados_device_id" },
        pairing_code: { type: "text", label: "Pairing code (once)", default: "", required: false, stored_as: "glados_pairing_code" },
        reconnect_delay: { type: "number", label: "Reconnect Delay (ms)", default: 5000, min: 1000, max: 60000, step: 1000, stored_as: "glados_reconnect_delay" },
      },
    };
  }

  hasControlPanel() {
    return true;
  }

  getControlPanelIcon() {
    return "🤖";
  }

  /** The hub's https address: where a browser accepts its self-signed certificate. */
  _httpsUrl() {
    return this.getConfigValue("hub_url", "wss://c.local:8095").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  }

  /**
   * Control panel: the hub URL with a link to accept its certificate, a connection test, and the
   * pairing state (vany 2026-10-11: "put the URL and a URL test in the module's panel").
   */
  renderControlPanel() {
    const box = document.createElement("div");
    box.style.cssText = "display:flex;flex-direction:column;gap:8px;font-size:13px;";
    const url = this._httpsUrl();
    const row = (label, el) => {
      const r = document.createElement("div");
      r.style.cssText = "display:flex;gap:8px;align-items:center;";
      const l = document.createElement("span");
      l.textContent = label;
      l.style.minWidth = "90px";
      r.append(l, el);
      return r;
    };
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = url + "  (open once, accept the certificate)";
    const result = document.createElement("span");
    result.textContent = "—";
    const test = document.createElement("button");
    test.textContent = "Test";
    test.onclick = async () => {
      result.textContent = "testing…";
      try {
        // no-cors: the hub sends no CORS headers; an opaque answer still proves TLS and reachability.
        const r = await fetch(url, { cache: "no-store", mode: "no-cors" });
        result.textContent = r.type === "opaque" || r.ok ? "✅ hub reachable, certificate accepted" : `⚠️ hub answered ${r.status}`;
      } catch {
        result.textContent = "❌ not reachable — or the certificate isn't accepted yet: open the link above";
      }
    };
    const pairing = document.createElement("span");
    pairing.textContent = "…";
    idb("get", "hubKey").then((k) => {
      pairing.textContent = k ? `paired · hub key ${k.slice(0, 12)}…` : "not paired — ask GLaDOS for a code";
    });
    // Live: _renderStatus() rewrites it on every link change and event (it used to be frozen
    // at render time, since the panel is built once).
    this.ui.panelLink = document.createElement("span");
    this._renderStatus();
    const forget = document.createElement("button");
    forget.textContent = "Forget pairing";
    forget.onclick = async () => {
      await idb("delete", "hubKey");
      pairing.textContent = "not paired — ask GLaDOS for a code";
      this.ws?.close(1000, "unpaired");
    };
    const t = document.createElement("div");
    t.style.cssText = "display:flex;gap:8px;align-items:center;";
    t.append(test, result);
    box.append(row("Hub", link), row("Check", t), row("Pairing", pairing), row("Link", this.ui.panelLink), forget);
    return box;
  }

  /** Always-visible status line under the header (Kira 2026-10-17): link, last event, last error. */
  async initialize(container) {
    await super.initialize(container);
    this.ui.statusLine = document.createElement("div");
    this.ui.statusLine.style.cssText = "font-size:12px;opacity:0.85;padding:2px 8px;";
    this.ui.container.querySelector(".module-header").after(this.ui.statusLine);
    this._renderStatus();
  }

  updateStatus(connected) {
    super.updateStatus(connected);
    this._renderStatus();
  }

  _renderStatus() {
    const clock = (d) => d.toLocaleTimeString();
    const text = [
      this.connected ? "🟢 link up" : "🔴 link down",
      this._last ? `last: ${this._last.dir} ${this._last.name} ${clock(this._last.at)}` : "no events yet",
      this._lastError && `⚠️ ${this._lastError.text} (${clock(this._lastError.at)})`,
    ]
      .filter(Boolean)
      .join(" · ");
    if (this.ui.statusLine) this.ui.statusLine.textContent = text;
    if (this.ui.panelLink) this.ui.panelLink.textContent = text;
  }

  /** Record the last thing that crossed the link: dir "←" from the hub, "→" to it. */
  _note(dir, name) {
    this._last = { dir, name, at: new Date() };
    this._renderStatus();
  }

  _fail(text) {
    this._lastError = { text, at: new Date() };
    this.log(`⚠️ GLaDOS link: ${text}`);
    this._renderStatus();
  }

  /**
   * Send an event to the hub. Nothing is buffered while the link is down: chat from minutes ago
   * is noise to her, and an error about a clip she already gave up on tells her nothing.
   */
  _emit(name, data) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "event", name, data }));
    this._note("→", name);
  }

  /** twitch-chat message handler; a stable reference so reconnects can unregister it first. */
  _onChat = (m) => this._emit("chat", chatEvent(m));

  async _keys() {
    let kp = await idb("get", "keypair");
    if (!kp) {
      kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      await idb("put", "keypair", kp);
    }
    return kp;
  }

  async _open(url) {
    const ws = new WebSocket(url);
    try {
      await this._waitForWebSocket(ws);
    } catch {
      // The browser hides why a wss handshake failed; an unaccepted self-signed certificate
      // and a hub that is down look identical from here, so name both.
      throw new Error(`can't open ${url}: hub down, or its certificate isn't accepted here (open ${this._httpsUrl()})`);
    }
    return ws;
  }

  _next(ws) {
    return new Promise((resolve, reject) => {
      ws.addEventListener("message", (e) => resolve(JSON.parse(e.data)), { once: true });
      ws.addEventListener("close", (e) => reject(new Error(`closed ${e.code} ${e.reason}`)), { once: true });
    });
  }

  async _pair(url, id, code) {
    const kp = await this._keys();
    const pub = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
    const ws = await this._open(url);
    ws.send(JSON.stringify({ t: "pair", id, code, key: pub }));
    const m = await this._next(ws);
    if (m.t !== "paired") throw new Error("pairing refused");
    // The hub proves it knows the code: whoever answered is the hub glados set up, not a stranger.
    const k = await crypto.subtle.importKey("raw", enc.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = b64(await crypto.subtle.sign("HMAC", k, enc.encode(m.hubKey)));
    if (mac !== m.mac) throw new Error("the hub could not prove the pairing code; not pinned");
    await idb("put", "hubKey", m.hubKey);
    this.setConfigValue("pairing_code", "");
    this.log("🤝 Paired with GLaDOS hub");
  }

  async doConnect() {
    this.shouldReconnect = true;
    try {
      await this._handshake();
    } catch (e) {
      this._fail(e.message);
      // A failed attempt retries like a dropped link does. Before, only a close AFTER `ready`
      // scheduled a retry, so a hub that was down at page load stayed down until a reload.
      // A missing pairing waits for vany instead: retrying can't produce a code.
      if (!e.needsPairing) this._scheduleReconnect();
      throw e;
    }
  }

  async _handshake() {
    const url = this.getConfigValue("hub_url", "wss://c.local:8095");
    const id = this.getConfigValue("device_id", "teammater");
    let hubKey = await idb("get", "hubKey");
    const code = this.getConfigValue("pairing_code", "");
    if (!hubKey) {
      if (!code) throw Object.assign(new Error("not paired: ask GLaDOS for a pairing code and enter it in the config"), { needsPairing: true });
      await this._pair(url, id, code);
      hubKey = await idb("get", "hubKey");
    }
    const kp = await this._keys();
    const ws = await this._open(url);
    const nonce = b64(crypto.getRandomValues(new Uint8Array(24)));
    ws.send(JSON.stringify({ t: "hello", id, nonce }));
    const ch = await this._next(ws);
    const hk = await crypto.subtle.importKey("raw", unb64(hubKey), { name: "Ed25519" }, false, ["verify"]);
    const hubOk = ch.t === "challenge" && ch.hubKey === hubKey && (await crypto.subtle.verify({ name: "Ed25519" }, hk, unb64(ch.sig), enc.encode(`hub|${id}|${nonce}`)));
    if (!hubOk) {
      ws.close(4401, "hub failed authentication");
      throw new Error("the hub did not prove its key — refusing to connect");
    }
    const sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, enc.encode(`dev|${id}|${ch.nonce}`)));
    ws.send(JSON.stringify({ t: "auth", sig, commands: ["say", "sound", "voices", "ping"].map((name) => ({ name })), events: EVENTS }));
    const ready = await this._next(ws);
    if (ready.t !== "ready") throw new Error("hub did not accept this device");
    this.ws = ws;
    this._lastError = null;
    this.updateStatus(true);
    this.log("✅ Connected to GLaDOS");
    ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      this.updateStatus(false);
      this.log(`❌ GLaDOS link closed (${e.code})`);
      this._scheduleReconnect();
    };
    // Chat → her. twitch-chat connects after this module, but it is registered at startup and
    // keeps its handlers across its own reconnects, so registering here is enough.
    const chat = this.moduleManager?.get("twitch-chat");
    if (!chat) {
      this._fail("no twitch-chat module: chat events are off");
      return;
    }
    chat.unregisterMessageHandler(this._onChat);
    chat.registerMessageHandler(this._onChat);
  }

  async doDisconnect() {
    this.moduleManager?.get("twitch-chat")?.unregisterMessageHandler(this._onChat);
    this._cleanupReconnect();
  }

  async _onMessage(m) {
    if (m.t !== "cmd") return;
    this._note("←", m.name);
    const reply = (ok, v) => this.ws?.send(JSON.stringify({ t: "result", cid: m.cid, ok, ...(ok ? { value: v } : { error: String(v) }) }));
    try {
      reply(true, await this._run(m.name, m.args ?? {}, m.cid));
    } catch (e) {
      reply(false, e?.message ?? e);
    }
  }

  /**
   * The browser couldn't play: tell her (event), tell vany (status line), and hand back the error
   * for the command's result. One place, so both say paths report the same way.
   */
  _playFailed(err, cid) {
    const reason = playFailure(err);
    const message = `${FAILURE_HINT[reason]}${err?.message ? ` (${err.message})` : ""}`;
    this._emit("error", { cmd: "say", cid, reason, message });
    this._fail(message);
    return new Error(`${reason}: ${message}`);
  }

  /**
   * Play one clip after the ones before it, so her lines never talk over each other. Resolves
   * when this clip starts; a failure later in the clip arrives as an `error` event, since the
   * command's result is already sent by then.
   */
  async _play(blob, cid) {
    const prev = this._audioTail ?? Promise.resolve();
    let finished;
    this._audioTail = new Promise((r) => (finished = r));
    await prev;
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    let started = false;
    const release = () => {
      URL.revokeObjectURL(url);
      finished();
    };
    el.onended = release;
    el.onerror = () => {
      release();
      if (started) this._playFailed(Object.assign(new Error(el.error?.message || "media error"), { name: "PlaybackError" }), cid);
    };
    try {
      await el.play();
    } catch (e) {
      release();
      throw e;
    }
    started = true;
  }

  async _run(name, a, cid) {
    switch (name) {
      case "ping":
        return "pong";
      case "voices":
        return speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
      case "say": {
        // Her own voice, rendered by the hub (Kira 2026-10-17). This replaces the server-TTS path
        // (vany 2026-10-11), whose /api/tts endpoint was never built.
        if (a.audio !== undefined) {
          try {
            await this._play(audioBlob(a.audio, a.mime), cid);
          } catch (e) {
            throw this._playFailed(e, cid);
          }
          this.log(`🗣️ GLaDOS (voice)${typeof a.text === "string" ? `: ${a.text}` : ""}`);
          return "playing";
        }
        if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("say: audio or text required");
        // Browser fallback, so the stream never goes mute: [tags] carry the emotion; the browser
        // voice can't act, so a mood only nudges rate and pitch, and no tag is ever read aloud.
        const MOOD = { sarcastic: [0.95, 0.9], happy: [1.1, 1.15], excited: [1.2, 1.2], sad: [0.85, 0.85], tender: [0.9, 1.05], calm: [0.95, 1], deadpan: [0.9, 0.8], solemn: [0.85, 0.85], angry: [1.1, 0.9], scared: [1.15, 1.2], whispers: [0.9, 1], shouts: [1.1, 1.1], slowly: [0.8, 1], quickly: [1.25, 1] };
        const tags = [...a.text.matchAll(/\[([a-z ]+)\]/gi)].map((m) => m[1].toLowerCase());
        const mood = tags.find((t) => MOOD[t]);
        const plain = a.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
        if (!plain) return "nothing to say";
        const u = new SpeechSynthesisUtterance(plain);
        const v = a.voice ? speechSynthesis.getVoices().find((x) => x.name === a.voice) : pickVoice(a.lang ?? "ru-RU");
        if (v) u.voice = v;
        const [rate, pitch] = mood ? MOOD[mood] : [1, 1];
        u.rate = rate;
        u.pitch = pitch;
        // Chrome refuses speech without a user gesture too, but only says so here, after the
        // result is sent; "not-allowed" is the same autoplay block as audio's NotAllowedError.
        u.onerror = (e) => this._playFailed({ name: e.error === "not-allowed" ? "NotAllowedError" : "SpeechError", message: `speech: ${e.error}` }, cid);
        speechSynthesis.speak(u);
        this.log(`🗣️ GLaDOS: ${plain}`);
        return "spoken";
      }
      case "sound": {
        const mp3 = this.moduleManager?.helpers?.mp3;
        if (typeof mp3 !== "function") throw new Error("sound: no mp3 helper");
        mp3(String(a.name));
        return "played";
      }
      default:
        throw new Error(`unknown command ${name}`);
    }
  }
}
