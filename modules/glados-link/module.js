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
 * Commands glados can send: say {text, emotion?, voice?, rate?, pitch?, lang?} (see
 * shared/tts-contract.md: server voice first, browser voice as fallback), sound {name}, voices, ping.
 */

import { BaseModule } from "../base-module.js";
import { pickVoice } from "../../utils.js";

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
        tts_url: { type: "text", label: "TTS endpoint (teammater server)", default: "https://localhost:8443/api/tts", required: false, stored_as: "glados_tts_url" },
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
    const conn = document.createElement("span");
    conn.textContent = this.isConnected() ? "🟢 connected" : "🔴 not connected";
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
    box.append(row("Hub", link), row("Check", t), row("Pairing", pairing), row("Link", conn), forget);
    return box;
  }

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
    await this._waitForWebSocket(ws);
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
    const url = this.getConfigValue("hub_url", "wss://c.local:8095");
    const id = this.getConfigValue("device_id", "teammater");
    this.shouldReconnect = true;
    let hubKey = await idb("get", "hubKey");
    const code = this.getConfigValue("pairing_code", "");
    if (!hubKey) {
      if (!code) throw new Error("not paired: ask GLaDOS for a pairing code and enter it in the config");
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
    ws.send(JSON.stringify({ t: "auth", sig, commands: ["say", "sound", "voices", "ping"].map((name) => ({ name })), events: [] }));
    const ready = await this._next(ws);
    if (ready.t !== "ready") throw new Error("hub did not accept this device");
    this.ws = ws;
    this.updateStatus(true);
    this.log("✅ Connected to GLaDOS");
    ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      this.updateStatus(false);
      this.log(`❌ GLaDOS link closed (${e.code})`);
      this._scheduleReconnect();
    };
  }

  async doDisconnect() {
    this._cleanupReconnect();
    this.ws?.close(1000, "disconnect");
  }

  async _onMessage(m) {
    if (m.t !== "cmd") return;
    const reply = (ok, v) => this.ws?.send(JSON.stringify({ t: "result", cid: m.cid, ok, ...(ok ? { value: v } : { error: String(v) }) }));
    try {
      reply(true, await this._run(m.name, m.args ?? {}));
    } catch (e) {
      reply(false, e?.message ?? e);
    }
  }

  async _run(name, a) {
    switch (name) {
      case "ping":
        return "pong";
      case "voices":
        return speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
      case "say": {
        if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("say: text required");
        // The server speaks with a real voice model (contract: shared/tts-contract.md); without it,
        // the browser's own voice, so the stream never goes mute.
        const tts = this.getConfigValue("tts_url", "");
        if (tts) {
          try {
            const r = await fetch(tts, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) });
            if (r.ok) {
              this.log(`🗣️ GLaDOS (server): ${a.text}`);
              return "spoken by server";
            }
          } catch {
            // fall through to the browser voice
          }
        }
        const u = new SpeechSynthesisUtterance(a.text);
        const v = a.voice ? speechSynthesis.getVoices().find((x) => x.name === a.voice) : pickVoice(a.lang ?? "ru-RU");
        if (v) u.voice = v;
        const e = a.emotion ?? {};
        u.rate = Number(a.rate ?? 1) * (1 + 0.25 * (Number(e.arousal ?? 0.3) - 0.3));
        u.pitch = 1 + Number(a.pitch ?? 0) + 0.2 * Number(e.valence ?? 0);
        speechSynthesis.speak(u);
        this.log(`🗣️ GLaDOS: ${a.text}`);
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
