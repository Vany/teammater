/**
 * glados-link wire shapes — the pure part of the protocol, kept apart from the module so it is
 * testable under node and readable by whoever writes the hub side. Full description: SPEC.md here.
 *
 * Kira 2026-10-17: chat lines go to the hub as events (she used to read chat anonymously over
 * IRC), and `say` carries her own voice as audio; a playback failure must reach her as an event.
 */

/** Events this device declares in `auth.events`; the hub learns what it may receive. */
export const EVENTS = [{ name: "chat" }, { name: "error" }];

/**
 * One twitch-chat message (the twitch-chat module's handler payload) → `chat` event data.
 * `user` is the login (stable key), `display` the name as shown; `badges` names only
 * ("broadcaster/1,subscriber/12" → ["broadcaster","subscriber"]) — versions mean nothing to her.
 */
export function chatEvent({ username, message, tags, messageId }) {
  const sent = Number(tags?.["tmi-sent-ts"]);
  return {
    id: messageId ?? tags?.id ?? "",
    user: String(username).toLowerCase(),
    display: tags?.["display-name"] || String(username),
    text: String(message),
    ts: Number.isFinite(sent) && sent > 0 ? sent : Date.now(),
    badges: (tags?.badges ?? "").split(",").filter(Boolean).map((b) => b.split("/")[0]),
  };
}

/**
 * Why the browser refused to play, as one word the hub can branch on.
 * `play()` rejects with NotAllowedError when no user gesture has unlocked audio on the page
 * (autoplay policy) and NotSupportedError when the data or mime can't be decoded.
 */
export function playFailure(err) {
  if (err?.name === "NotAllowedError") return "autoplay";
  if (err?.name === "NotSupportedError") return "decode";
  return "playback";
}

/** What to tell vany, per reason — shown in the UI and sent as the event's `message`. */
export const FAILURE_HINT = {
  autoplay: "browser blocked autoplay: click anywhere on the teammater page once",
  decode: "browser can't decode this audio (check mime and data)",
  playback: "audio playback failed",
};

/** base64 audio from the hub → Blob for an <audio> element; bad base64 counts as `decode`. */
export function audioBlob(b64, mime) {
  if (typeof b64 !== "string" || b64 === "") throw Object.assign(new Error("say: audio is empty"), { name: "NotSupportedError" });
  if (typeof mime !== "string" || !/^audio\//.test(mime)) throw Object.assign(new Error(`say: mime must be audio/*, got ${mime}`), { name: "NotSupportedError" });
  let bytes;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw Object.assign(new Error("say: audio is not valid base64"), { name: "NotSupportedError" });
  }
  return new Blob([bytes], { type: mime });
}
