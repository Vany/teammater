/**
 * Kira overlay: /obs bus → mouth + mood state → one frame + bounce. Rules live in mouth.js
 * (loudness → speaking) and mood.js (emotion tags, idle yawn).
 *
 * The bus client is a copy of obs.js's, not shared: obs.html was live on stream when this was
 * written (2026-10-17), so refactoring it wasn't worth the risk. Fold them together later.
 */

import { createMouth, bounce } from "./mouth.js";
import { createMood } from "./mood.js";

const params = new URLSearchParams(location.search);
const threshold = Number(params.get("threshold")) || 0.02;
const box = document.getElementById("kira");
const frames = [...box.querySelectorAll("img")];

const mouth = createMouth({ threshold, holdMs: 200 });
const mood = createMood({ now0: performance.now() });
let speaking = false;
let blinking = false;

/** Show exactly one frame. A blink replaces only the plain idle frame. */
function render() {
  let frame = mood.frame(performance.now(), speaking);
  if (frame === "idle" && blinking) frame = "wink";
  for (const img of frames) img.classList.toggle("on", img.id === frame);
  box.classList.toggle("speaking", speaking);
}

// Blink while idle, every 3–6 s for 150 ms (random, so it never looks like a metronome).
// The frame is a wink until a closed-eyes frame exists; ?blink=0 turns it off.
if (params.get("blink") !== "0") {
  const blink = () => {
    blinking = true;
    render();
    setTimeout(() => {
      blinking = false;
      render();
    }, 150);
    setTimeout(blink, 3000 + Math.random() * 3000);
  };
  setTimeout(blink, 3000);
}

// Emotions and yawns change on time alone, with no bus message, so re-check 4× a second.
setInterval(render, 250);

let holdTimer = null;

function onLevel(level) {
  speaking = mouth(level, performance.now());
  box.style.setProperty("--amp", speaking ? bounce(level, threshold).toFixed(3) : "0");
  render();
  // Levels stop arriving when a clip ends (the last is 0), so re-check once the hold
  // runs out; otherwise the speaking frame would stay until the next clip.
  clearTimeout(holdTimer);
  if (speaking) holdTimer = setTimeout(() => onLevel(0), 210);
}

function onEmotion(emotion) {
  mood.emotion(emotion, performance.now());
  render();
}

render();

// ── /obs bus (pattern from obs.js: loopback gets the token from /api/info) ──
const [proto, port] = location.protocol === "https:" ? ["wss:", 8443] : ["ws:", 8442];
const WS_BASE = `${proto}//${location.hostname}:${port}/obs`;
let busToken = null;
let reconnectTimer = null;

async function ensureToken() {
  try {
    const { bus_token } = await (await fetch("/api/info")).json();
    if (bus_token) busToken = bus_token;
  } catch {
    /* server briefly unreachable: keep the last known token */
  }
  if (!busToken) console.error("[kira] No bus token — /obs will refuse the connection");
  return busToken;
}

async function connect() {
  const token = await ensureToken();
  if (!token) {
    reconnectTimer = setTimeout(connect, 3000);
    return;
  }
  const ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(token)}`);
  ws.onmessage = ({ data }) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "kira_level" && typeof msg.level === "number") onLevel(msg.level);
    if (msg.type === "kira_emotion" && typeof msg.emotion === "string") onEmotion(msg.emotion);
  };
  ws.onclose = () => {
    onLevel(0);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onerror = () => ws.close();
}

connect();
