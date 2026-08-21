/**
 * /obs bus token — acquisition and URL building.
 *
 * The bus is NOT a read-only feed: it carries twitch_timeout, twitch_shoutout
 * and cmd_* record/scene commands that the main page executes with the
 * streamer's Twitch moderator token. The server binds 0.0.0.0 and the QR
 * workflow deliberately invites household devices onto the network, so the
 * server now requires ?token=<secret> on /obs.
 *
 * Two ways to obtain it, because remote devices must not be able to ask:
 *   - localhost pages (index.html, obs.html, the UserScript): GET /api/info,
 *     which includes `bus_token` ONLY for loopback callers.
 *   - remote devices (the phone): the token arrives in the QR URL fragment as
 *     `#token=…`, and is kept in localStorage so later visits work without it.
 *
 * A fragment, not a query string: fragments are not sent to the server and do
 * not land in access logs or Referer headers.
 */

const STORAGE_KEY = "obs_bus_token";

/**
 * Resolve the bus token, caching it in localStorage.
 * @returns {Promise<string>} the token, or "" if it could not be obtained
 */
export async function getBusToken() {
  // 1. URL fragment wins — a fresh QR scan should override a stale stored one.
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get("token");
  if (fromHash) {
    localStorage.setItem(STORAGE_KEY, fromHash);
    // Strip it from the address bar so it is not shoulder-surfed or bookmarked.
    history.replaceState(null, "", location.pathname + location.search);
    return fromHash;
  }

  // 2. Every current caller of this function (modules/obs, modules/music-queue)
  // is loopback-capable — served from index.html on localhost:8443 — so always
  // ask the server first rather than trusting whatever is cached. Used to
  // return the stored value unconditionally: if server/certs/ ever gets wiped
  // and regenerates the token, these pages COULD have self-healed by asking
  // again, but instead retried the dead token forever, indistinguishable from
  // any other reconnect failure. The cache now only matters as a fallback for
  // when the server is transiently unreachable, not as the source of truth.
  const stored = localStorage.getItem(STORAGE_KEY);
  try {
    const response = await fetch("/api/info");
    const { bus_token } = await response.json();
    if (bus_token) {
      localStorage.setItem(STORAGE_KEY, bus_token);
      return bus_token;
    }
  } catch {
    // Server unreachable right now — fall through to the cache below rather
    // than going straight to "" and forcing an immediate hard failure.
  }

  return stored || "";
}

/**
 * Build the /obs WebSocket URL for this origin, token included.
 * @param {string} token - from getBusToken()
 * @returns {string}
 */
export function busUrl(token) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/obs?token=${encodeURIComponent(token)}`;
}
