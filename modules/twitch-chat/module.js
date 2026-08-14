/**
 * Twitch Chat Module
 *
 * IRC WebSocket connection to Twitch chat.
 *
 * Features:
 * - IRC connection with CAP REQ for tags/commands/membership
 * - Message parsing (PRIVMSG with tags)
 * - Chat message sending (normal, action, whisper)
 * - Auto-reconnection
 * - Chat history for LLM monitoring
 * - Following list fetch + friend presence detection (JOIN/PART)
 *   Broadcasts: friend_joined { user }, friends_watching { users[] }
 */

import { BaseModule } from "../base-module.js";
import { parseIrcTags, parseIrcMessage } from "../../utils.js";

const CHAT_STORAGE_KEY = "CHAT";

export class TwitchChatModule extends BaseModule {
  constructor() {
    super();
    this.channel = null;
    this.username = null;
    this.userId = null;
    this.token = null;
    this.userIdCache = {};
    this.chatHistory = this._loadChatHistory();
    this.chatMarkerPosition = this.chatHistory.length; // mark all restored as already seen
    this.messageHandlers = []; // Array of {priority, handler} objects
    this.followingSet = new Set();    // lowercase logins we follow (friends)
    this.watchingFriends = new Set(); // friends detected via IRC JOIN (watching stream, bold)
    this.chattingFriends = new Set(); // friends seen via PRIVMSG only (in chat, normal weight)
  }

  /**
   * Load chat history from localStorage, restoring Date objects
   */
  _loadChatHistory() {
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return parsed.map((entry) => ({
        ...entry,
        timestamp: new Date(entry.timestamp),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Persist current chat history to localStorage
   */
  _saveChatHistory() {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(this.chatHistory));
    } catch {
      // Storage full or unavailable — fail silently
    }
  }

  /**
   * Clear chat history from memory and localStorage
   */
  clearChatHistory() {
    this.chatHistory = [];
    this.chatMarkerPosition = 0;
    localStorage.removeItem(CHAT_STORAGE_KEY);
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "💬 Twitch Chat";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      authentication: {
        client_id: {
          type: "text",
          label: "Twitch Client ID",
          default: "",
          stored_as: "twitch_client_id",
        },
      },
      connection: {
        irc_url: {
          type: "text",
          label: "IRC WebSocket URL",
          default: "wss://irc-ws.chat.twitch.tv:443",
          stored_as: "twitch_irc_url",
        },
        reconnect_delay: {
          type: "number",
          label: "Reconnect Delay (ms)",
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
          stored_as: "twitch_reconnect_delay",
        },
      },
      identity: {
        nickname: {
          type: "text",
          label: "Nickname",
          default: "Vany",
          stored_as: "nick_name",
        },
        twitch_username: {
          type: "text",
          label: "Twitch Username",
          default: "vanyserezhkin",
          stored_as: "twitch_username",
        },
        channel: {
          type: "text",
          label: "Channel (default: own username)",
          default: "",
          required: false,
          stored_as: "twitch_channel",
        },
      },
      chat_history: {
        history_size: {
          type: "number",
          label: "Chat History Size (for LLM)",
          default: 50,
          min: 10,
          max: 200,
          step: 10,
        },
      },
    };
  }

  /**
   * Add re-login button to config panel after auto-generated fields
   */
  async initialize(container) {
    await super.initialize(container);

    const btn = document.createElement("button");
    btn.textContent = "🔑 Re-login with Twitch";
    btn.title = "Clears stored token and reloads — use after adding new OAuth scopes";
    btn.style.cssText = "margin-top:10px;padding:6px 12px;background:#9147ff;color:#fff;border:none;border-radius:4px;font-size:12px;cursor:pointer;width:100%";
    btn.addEventListener("click", () => {
      localStorage.removeItem("twitch_token");
      window.location.reload();
    });

    this.ui.configPanel.appendChild(btn);
  }

  /**
   * Set authentication token and user info.
   * Must be called before connect().
   * Channel is read from config; falls back to own username if not set.
   */
  async setAuth(token, username, userId = null) {
    this.token = token;
    this.username = username;
    this.userId = userId;
    const configChannel = this.getConfigValue("channel", "").trim();
    this.channel = configChannel || username;

    if (this.enabled && !this.connected) {
      this.log("🔑 Authentication set, connecting...");
      await this.connect();
    }
  }

  /**
   * Connect to Twitch IRC
   */
  async doConnect() {
    if (!this.token || !this.username) {
      this.log("⏳ Waiting for authentication...");
      return;
    }

    const ircUrl = this.getConfigValue(
      "irc_url",
      "wss://irc-ws.chat.twitch.tv:443",
    );

    this.log(`💬 Connecting to Twitch IRC at ${ircUrl}...`);
    this.log(`📺 Joining channel: #${this.channel} (as ${this.username})`);

    this.ws = new WebSocket(ircUrl);

    this.ws.onerror = (error) => {
      this.log(`❌ WebSocket error: ${error}`);
    };

    this.ws.onclose = () => {
      this.log("❌ WebSocket closed");
      this.updateStatus(false);
      this._scheduleReconnect();
    };

    this.ws.onopen = () => {
      // membership capability gives us JOIN/PART events for friend detection
      this.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
      this.ws.send(`PASS oauth:${this.token}`);
      this.ws.send(`NICK ${this.username}`);
      this.ws.send(`JOIN #${this.channel}`);

      this.log(`✅ Connected to #${this.channel} as ${this.username}`);
      this.updateStatus(true);

      // Kick off following list fetch asynchronously — don't block IRC
      this._fetchFollowing().catch((err) =>
        this.log(`⚠️ Following list fetch failed: ${err.message}`),
      );
    };

    this.ws.onmessage = (event) => {
      this._handleIrcMessage(event.data);
    };

    await this._waitForWebSocket(this.ws);
  }

  /**
   * Fetch the list of channels the authenticated user follows (their "friends").
   * Stores lowercase logins in this.followingSet.
   * Uses /helix/channels/followed (requires user:read:follows scope).
   */
  async _fetchFollowing() {
    if (!this.token || !this.username) return;

    const clientId = this.getConfigValue("client_id", "");
    if (!clientId) {
      this.log("⚠️ No Client ID configured, skipping following list fetch");
      return;
    }

    const headers = {
      Authorization: `Bearer ${this.token}`,
      "Client-Id": clientId,
    };

    // Resolve userId if not provided (e.g. reconnect without re-auth)
    let userId = this.userId;
    if (!userId) {
      const res = await fetch(
        `https://api.twitch.tv/helix/users?login=${encodeURIComponent(this.username)}`,
        { headers },
      );
      const data = await res.json();
      userId = data.data?.[0]?.id;
      if (!userId) {
        this.log("⚠️ Could not resolve own user ID for following list");
        return;
      }
      this.userId = userId;
    }

    // Paginate through all followed channels
    this.followingSet = new Set();
    let cursor = null;
    let total = 0;

    do {
      const url =
        `https://api.twitch.tv/helix/channels/followed?user_id=${userId}&first=100` +
        (cursor ? `&after=${cursor}` : "");
      const res = await fetch(url, { headers });
      const data = await res.json();
      for (const entry of data.data ?? []) {
        this.followingSet.add(entry.broadcaster_login.toLowerCase());
      }
      cursor = data.pagination?.cursor ?? null;
      total += data.data?.length ?? 0;
    } while (cursor);

    this.log(`👥 Loaded ${total} friends (following list)`);
  }

  /**
   * Disconnect from Twitch IRC
   */
  async doDisconnect() {
    this.log("🔌 Disconnecting from Twitch IRC...");
    this._cleanupReconnect();

    // Clear friend presence and notify mobile
    this.watchingFriends.clear();
    this.chattingFriends.clear();
    this._broadcastFriends(null);

    this.log("✅ Disconnected from Twitch IRC");
  }

  /**
   * Handle incoming IRC message.
   * Intercepts membership events (JOIN/PART) before PRIVMSG parsing.
   */
  _handleIrcMessage(data) {
    if (data.startsWith("PING")) {
      this.ws.send("PONG :tmi.twitch.tv");
      return;
    }

    if (this._handleMembershipEvent(data)) return;

    const parsed = parseIrcMessage(data);
    if (!parsed) return;

    const { username, message } = parsed;
    const tags = parseIrcTags(data);

    this._addToChatHistory(username, message);

    // Friend chatting detection: show in widget even if not JOIN-detected
    const userLower = username.toLowerCase();
    if (
      this.followingSet.size > 0 &&
      this.followingSet.has(userLower) &&
      !this.watchingFriends.has(userLower) &&
      !this.chattingFriends.has(userLower)
    ) {
      this.chattingFriends.add(userLower);
      this.log(`👥 Friend chatting: ${userLower}`);
      this._broadcastFriends(userLower); // flash on first appearance
    }

    this.moduleManager?.get("obs")?._sendCmd("chat_message", {
      user: username,
      text: message,
      user_id: tags?.["user-id"] ?? "",
      msg_id: tags?.id ?? "",
    });

    this._notifyMessageHandlers({
      username,
      message,
      tags,
      userId: tags?.["user-id"],
      messageId: tags?.id,
      rawData: data,
    });
  }

  /**
   * Parse and handle IRC membership events: JOIN, PART, 353 NAMES.
   * Returns true if the message was a membership event (and consumed).
   */
  _handleMembershipEvent(data) {
    // Strip tags prefix if present so regex matches cleanly
    let line = data;
    if (line.startsWith("@")) {
      const sp = line.indexOf(" ");
      if (sp !== -1) line = line.substring(sp + 1);
    }

    // :user!user@user.tmi.twitch.tv JOIN #channel
    const joinMatch = line.match(/^:([^!]+)![^\s]+ JOIN #/);
    if (joinMatch) {
      const user = joinMatch[1].toLowerCase();
      if (this.followingSet.size > 0 && this.followingSet.has(user)) {
        const isNew = !this.watchingFriends.has(user) && !this.chattingFriends.has(user);
        this.chattingFriends.delete(user); // upgrade: watching supersedes chatting
        this.watchingFriends.add(user);
        this.log(`👥 Friend watching: ${user}`);
        this._broadcastFriends(isNew ? user : null); // flash only on first appearance
      }
      return true;
    }

    // :user!user@user.tmi.twitch.tv PART #channel
    const partMatch = line.match(/^:([^!]+)![^\s]+ PART #/);
    if (partMatch) {
      const user = partMatch[1].toLowerCase();
      if (this.watchingFriends.has(user)) {
        this.watchingFriends.delete(user);
        // Keep in chattingFriends if they chatted — they're still present in chat
        this.log(`👥 Friend closed stream: ${user}`);
        this._broadcastFriends(null);
      }
      return true;
    }

    // 353 NAMES: initial presence list (up to 1000, small channels only)
    // Format: :server 353 nick = #channel :user1 user2 ...
    const namesMatch = line.match(/ 353 [^\s]+ [=*@] #[^\s]+ :(.+)/);
    if (namesMatch) {
      if (this.followingSet.size > 0) {
        let found = false;
        for (const raw of namesMatch[1].trim().split(" ")) {
          const user = raw.replace(/^[+@]/, "").toLowerCase();
          if (this.followingSet.has(user) && !this.watchingFriends.has(user)) {
            this.chattingFriends.delete(user);
            this.watchingFriends.add(user);
            found = true;
          }
        }
        if (found) {
          this.log(`👥 Friends already watching: ${[...this.watchingFriends].join(", ")}`);
          this._broadcastFriends(null);
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Broadcast friend presence to mobile via /obs bus.
   * watching = bold (IRC JOIN), chatting = normal (PRIVMSG only, not JOIN-detected).
   * @param {string|null} newUser - User appearing for first time (triggers flash), or null
   */
  _broadcastFriends(newUser) {
    const obs = this.moduleManager?.get("obs");
    if (!obs) return;
    if (newUser) {
      obs._sendCmd("friend_appeared", { user: newUser });
    }
    obs._sendCmd("friends_present", {
      watching: [...this.watchingFriends],
      chatting: [...this.chattingFriends],
    });
  }

  /**
   * Add message to chat history buffer
   */
  _addToChatHistory(username, message) {
    const historySize = parseInt(this.getConfigValue("history_size", "50"));

    this.chatHistory.push({
      timestamp: new Date(),
      username: username,
      message: message,
    });

    if (this.chatHistory.length > historySize) {
      this.chatHistory.shift();
      if (this.chatMarkerPosition > 0) {
        this.chatMarkerPosition--;
      }
    }

    this._saveChatHistory();
  }

  /**
   * Register a message handler
   * @param {Function} handler - Function(messageData) to handle messages
   * @param {number} priority - Higher priority handlers run first (default: 0)
   */
  registerMessageHandler(handler, priority = 0) {
    this.messageHandlers.push({ priority, handler });
    this.messageHandlers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Unregister a message handler
   */
  unregisterMessageHandler(handler) {
    this.messageHandlers = this.messageHandlers.filter(
      (h) => h.handler !== handler,
    );
  }

  /**
   * Notify all message handlers
   */
  _notifyMessageHandlers(messageData) {
    for (const { handler } of this.messageHandlers) {
      try {
        handler(messageData);
      } catch (error) {
        this.log(`💥 Message handler error: ${error.message}`);
      }
    }
  }

  /**
   * Send message to chat
   */
  send(message) {
    if (!this.isConnected() || !this.ws || !message) {
      this.log("💥 Not connected to Twitch!");
      return false;
    }

    try {
      const sanitized = message.toString().trim();
      if (sanitized.length === 0) {
        this.log("💥 Empty message!");
        return false;
      }

      this.ws.send(`PRIVMSG #${this.channel} :${sanitized}`);
      this.log(`📤 Sent: ${sanitized}`);
      return true;
    } catch (error) {
      this.log(`💥 Send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send action message (/me)
   */
  sendAction(message) {
    if (!this.isConnected() || !this.ws || !message) {
      this.log("💥 Not connected to Twitch!");
      return false;
    }

    try {
      const sanitized = message.toString().trim();
      if (sanitized.length === 0) {
        this.log("💥 Empty message!");
        return false;
      }

      this.ws.send(`PRIVMSG #${this.channel} :\x01ACTION ${sanitized}\x01`);
      this.log(`📤 Action: * ${sanitized}`);
      return true;
    } catch (error) {
      this.log(`💥 Action send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get chat history
   */
  getChatHistory() {
    return this.chatHistory;
  }

  /**
   * Get chat marker position
   */
  getChatMarkerPosition() {
    return this.chatMarkerPosition;
  }

  /**
   * Set chat marker position
   */
  setChatMarkerPosition(position) {
    this.chatMarkerPosition = position;
  }

  /**
   * Format chat history for LLM with marker
   */
  formatChatHistoryForLLM() {
    if (this.chatHistory.length === 0) {
      return "No messages yet.";
    }

    const lines = this.chatHistory.map((entry, index) => {
      const timestamp = entry.timestamp.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const line = `[${timestamp}] ${entry.username}: ${entry.message}`;

      if (
        index === this.chatMarkerPosition - 1 &&
        this.chatMarkerPosition < this.chatHistory.length
      ) {
        return line + "\n -> new messages:";
      }

      return line;
    });

    return lines.join("\n");
  }

  getChannel() { return this.channel; }
  getUsername() { return this.username; }
  getWebSocket() { return this.ws; }

  getContextContribution() {
    return {
      twitchChat: this,
      ws: this.ws,
      CHANNEL: this.channel,
      send_twitch: (msg) => this.send(msg),
      sendAction: (msg) => this.sendAction(msg),
    };
  }
}
