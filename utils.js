// ============================
// HTTP UTILITIES
// ============================

/**
 * Generic HTTP request wrapper for Twitch API calls
 * Automatically injects OAuth token and Client-ID from storage
 * @param {string} url - Full API endpoint URL
 * @param {Object} options - Fetch options (method, headers, body, etc.)
 * @returns {Promise<Response>} - Fetch response object
 * @throws {Error} - If request fails with status code and error text
 */
export async function request(url, options = {}) {
  const token = localStorage.getItem("twitch_token");
  const CLIENT_ID = localStorage.getItem("twitch_client_id");

  const defaultOptions = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": CLIENT_ID,
      "Content-Type": "application/json",
    },
  };

  const mergedOptions = {
    ...defaultOptions,
    ...options,
    headers: {
      ...defaultOptions.headers,
      ...options.headers,
    },
  };

  const response = await fetch(url, mergedOptions);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} - ${errorText}`);
  }

  return response;
}

// ============================
// DECK (QUEUE/STACK) UTILITIES
// ============================

/**
 * Persistent double-ended queue backed by localStorage
 * Supports push/pop (stack operations) and unshift/shift (queue operations)
 * Batches mutations and flushes to localStorage periodically for performance
 *
 * Operations:
 * - push(item): Add to end (stack push)
 * - pop(): Remove from end (stack pop)
 * - unshift(item): Add to front (queue enqueue)
 * - shift(): Remove from front (queue dequeue)
 * - peekTop(): View last item without removing
 * - peekBottom(): View first item without removing
 * - clear(): Remove all items
 * - all(): Get copy of all items
 * - size(): Get item count
 * - flush(): Force immediate write to localStorage
 */
export class PersistentDeck {
  /**
   * @param {string} name - localStorage key for persistence
   * @param {number} flushInterval - Milliseconds between auto-flushes (default: 1000)
   */
  constructor(name, flushInterval = 1000) {
    this.key = name;
    this.flushInterval = flushInterval;
    this.dirty = false;
    this._load();
    this._startAutoFlush();
  }

  _load() {
    const raw = localStorage.getItem(this.key);
    this.data = raw ? JSON.parse(raw) : [];
  }

  _save() {
    localStorage.setItem(this.key, JSON.stringify(this.data));
    this.dirty = false;
  }

  _markDirty() {
    this.dirty = true;
  }

  _startAutoFlush() {
    this.timer = setInterval(() => {
      if (this.dirty) {
        this._save();
      }
    }, this.flushInterval);
  }

  push(item) {
    this.data.push(item);
    this._markDirty();
  }

  pop() {
    const item = this.data.pop();
    this._markDirty();
    return item;
  }

  unshift(item) {
    this.data.unshift(item);
    this._markDirty();
  }

  shift() {
    const item = this.data.shift();
    this._markDirty();
    return item;
  }

  peekTop() {
    return this.data[this.data.length - 1];
  }

  peekBottom() {
    return this.data[0];
  }

  clear() {
    this.data = [];
    this._markDirty();
  }

  all() {
    return [...this.data];
  }

  size() {
    return this.data.length;
  }

  /**
   * Force immediate write to localStorage
   * Useful before page unload or critical operations
   */
  flush() {
    if (this.dirty) {
      this._save();
    }
  }

  /**
   * Stop auto-flush timer and write final state
   */
  destroy() {
    clearInterval(this.timer);
    this.flush();
  }
}

// ============================
// IRC UTILITIES
// ============================

/**
 * Parse IRC tags from raw IRC message
 * IRC tags format: @key1=value1;key2=value2;key3=value3 :rest of message
 * Used to extract metadata like user-id, message-id, badges, etc.
 *
 * @param {string} rawMessage - Raw IRC message string starting with @
 * @returns {Object|null} - Object with tag key-value pairs, or null if no tags present
 *
 * @example
 *   Input: "@user-id=123;msg-id=abc :user!user@user PRIVMSG #channel :hello"
 *   Output: { "user-id": "123", "msg-id": "abc" }
 */
export function parseIrcTags(rawMessage) {
  if (!rawMessage.startsWith("@")) return null;

  const tagEnd = rawMessage.indexOf(" ");
  if (tagEnd === -1) return null;

  const tagsString = rawMessage.substring(1, tagEnd);
  const tags = {};

  tagsString.split(";").forEach((tag) => {
    const [key, value] = tag.split("=");
    tags[key] = value || "";
  });

  return tags;
}

/**
 * Parse IRC PRIVMSG correctly handling tags, prefix, and message
 * Properly extracts username and message text from tagged IRC messages
 *
 * Format: [@tags] :nick!user@host PRIVMSG #channel :message
 *
 * @param {string} rawMessage - Raw IRC message
 * @returns {{username: string, message: string}|null} - Parsed data or null if not PRIVMSG
 *
 * @example
 *   parseIrcMessage("@emotes=0-4:123 :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :hello")
 *   => { username: "nick", message: "hello" }
 */
export function parseIrcMessage(rawMessage) {
  let message = rawMessage;

  // Strip tags if present
  if (message.startsWith("@")) {
    const tagEnd = message.indexOf(" ");
    if (tagEnd === -1) return null;
    message = message.substring(tagEnd + 1);
  }

  // Parse IRC prefix and command
  // Format: :nick!user@host PRIVMSG #channel :message text\r\n
  // Note: IRC messages end with \r\n, so we need to handle that
  const match = message.match(
    /^:([^!]+)![^\s]+ PRIVMSG #[^\s]+ :(.+?)(?:\r\n)?$/,
  );
  if (!match) return null;

  return {
    username: match[1],
    message: match[2].trim(),
  };
}

// ============================
// LANGUAGE DETECTION
// ============================

/**
 * Detect language of text based on Unicode script ranges
 * Fast, zero-dependency detection for Cyrillic (Russian) vs Latin (English)
 *
 * @param {string} text - Text to analyze
 * @returns {"ru"|"en"|"unknown"} - Detected language code
 *
 * @example
 *   detectLanguage("Привет мир") => "ru"
 *   detectLanguage("Hello world") => "en"
 *   detectLanguage("123 !@#") => "unknown"
 */
export function detectLanguage(text) {
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;

  if (cyrillicCount > latinCount) return "ru";
  if (latinCount > cyrillicCount) return "en";
  return "unknown";
}
