// ============================
// CONFIGURATION
// ============================

// Twitch API Configuration
const CLIENT_ID = persistentValue("twitch_client_id");
const CHANNEL = "vanyserezhkin";
const REDIRECT_URI = window.location.origin;
const SCOPES = [
  "chat:read",
  "chat:edit",
  "channel:manage:broadcast",
  "moderator:manage:chat_settings",
  "user:manage:whispers",
  "channel:manage:redemptions",
  "channel:read:redemptions",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
];

// Ban Rules Configuration
// Rules are arrays where:
// - First element is action function: mute(seconds), ban(), or delete()
// - Following elements are regexes that ALL must match (AND logic)
// - Rules are combined with OR logic (any rule triggers action)
const BAN_RULES = [
  // Example rules (modify as needed):
  // [ban(), /very bad word/i],
  // [mute(600), /spam/i, /pattern/i],  // 10 minute timeout if both match
  // [delete(), /mild offense/i],
];

// Stream Presets Configuration
const DEFAULT_PRESETS = {
  loitering: {
    title: "подготовка к стриму. 🐽 ✨ ТУПИМ! 🧱 ",
    game_id: "509658",
    tags: ["Russian", "English", "Educational", "Clowns"],
    pinned_message:
      "🐽🧱✨🌊 Сбооорочка !! https://www.feed-the-beast.com/modpacks/129-ftb-skies-2",
    rewards_active: ["voice", "music", "vote_skip", "playing"],
  },
  coding: {
    title: "🐽✨controlrake rust project 🧱 some time hell on the earth",
    game_id: "1469308723",
    tags: ["English", "Programming", "Coding", "Educational"],
    pinned_message: "🐽🧱✨🌊 DO NOT FORGET TO CHAT WITH STREAMER! 🌊✨🧱🐽",
    rewards_active: ["voice", "music", "vote_skip", "playing"],
  },
  gaming: {
    title:
      "🧱🧱🧱 🐽 ✨ Stoneblock 4 ✨ Броня крепка и козы наши ностры 🧱 записываемся на ютубчик",
    game_id: "27471", // МАЙНКРАПХТ
    tags: ["English", "Gaming", "Chill"],
    pinned_message:
      "🐽🧱✨🌊 Сбооорочка !! https://feed-the-beast.com/modpacks/130-ftb-stoneblock-4",
    rewards_active: ["voice", "hate", "love"],
  },
  dooming: {
    title: "B O O M",
    game_id: "584", // МАЙНКРАПХТ
    tags: ["English", "Gaming", "Chill"],
    pinned_message:
      "RELAX AND ENJOY THE STREAM. Do not forget to talk with streamer",
    rewards_active: [], // All rewards paused
  },
};

// Default pinned message when no preset is active
const DEFAULT_PINNED_MESSAGE =
  "🐽🧱✨🌊 Сбооорочка !! https://www.feed-the-beast.com/modpacks/129-ftb-skies-2";

// Channel Point Rewards Configuration
const DEFAULT_REWARDS = {
  hate: {
    title: "⚡ Hate Vany",
    cost: 300,
    prompt: "Strike the streamer with lightning!",
    background_color: "#77AAFF",
    is_enabled: true,
    is_global_cooldown_enabled: true,
    global_cooldown_seconds: 30,
    action: "hate",
  },
  love: {
    title: "💚 Love Vany",
    cost: 200,
    prompt: "Save the streamer from hate for a minute!",
    background_color: "#BBFF77",
    is_enabled: true,
    action: "love",
  },
  music: {
    title: "🎵 Music Request",
    cost: 150,
    prompt: "Request a music (Yandex Music URL)",
    background_color: "#FF6B6B",
    is_enabled: true,
    is_user_input_required: true,
    action: "music",
  },
  vote_skip: {
    title: "🎵 Skip song",
    cost: 30,
    prompt: "Vote for skip current song",
    background_color: "#FF3B3B",
    is_enabled: true,
    action: "vote_skip",
  },
  playing: {
    title: "What is playing?",
    cost: 30,
    prompt: "Vote for skip current song",
    background_color: "#222255",
    is_enabled: true,
    action: "playing",
  },
  voice: {
    title: "🤖 Voice",
    cost: 50,
    prompt: "Stream pay not enough attention to chat, say it to him",
    background_color: "#0033FF",
    is_enabled: true,
    is_user_input_required: true,
    is_global_cooldown_enabled: true,
    global_cooldown_seconds: 60,
    action: "voice",
  },
};

// ============================
// GLOBAL VARIABLES
// ============================

window.i_am_a_master = true;

// State variables
var throttle = {};
var ws;
var love_timer = Date.now();
let minarert = null;
let isConnected = false;
let twitchConnected = false;
let currentUserId = null;
let pendingPinMessage = null; // Store message waiting to be pinned
let userIdCache = {}; // Cache username -> user_id mappings
let customRewards = {}; // Cache reward_id -> reward_data mappings
let eventSubSocket = null; // EventSub WebSocket connection
let sessionId = null; // EventSub session ID
let needVoteSkip = 3;
let currentSong = "Silence by silencer";
// ============================
// UTILITY FUNCTIONS
// ============================

function persistentValue(K) {
  let v = localStorage.getItem(K);
  if (!v) {
    v = prompt("Enetr param for " + K);
    if (v) localStorage.setItem(K, v);
  }
  return v;
}

function log(msg) {
  const div = document.createElement("div");
  div.textContent = msg;
  document.getElementById("output").appendChild(div);
  return div.innerHTML;
}

function mp3(name) {
  const audio = document.getElementById("myAudio");
  audio.src = "mp3/" + name + ".mp3";
  audio.play().catch((err) => {
    speak("ACHTUNG");
    console.error("Playback failed:", err);
  });
}

function speak(str) {
  let x = new SpeechSynthesisUtterance(str);
  x.language = "en-US";
  x.rate = 1;
  x.pitch = 1;
  x.voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
  speechSynthesis.speak(x);
}

// ============================
// BAN SYSTEM
// ============================

// Action function factories for BAN_RULES
function mute(seconds) {
  return { type: "timeout", duration: seconds };
}

function ban() {
  return { type: "ban" };
}

function delete_message() {
  return { type: "delete" };
}

// Alias for better naming
const delete_ = delete_message;

// Parse IRC tags from message
function parseIrcTags(rawMessage) {
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

// Check if message matches ban rules
function checkBanRules(message) {
  for (const rule of BAN_RULES) {
    if (rule.length < 2) continue; // Invalid rule

    const action = rule[0];
    const patterns = rule.slice(1);

    // Check if ALL patterns match (AND logic)
    const allMatch = patterns.every((pattern) => pattern.test(message));

    if (allMatch) {
      return action; // Return first matching rule's action
    }
  }

  return null; // No rules matched
}

// Execute moderation action via Twitch API
async function executeModerationAction(action, userId, messageId, username, message) {
  if (!currentUserId || !userId) {
    log("❌ Cannot execute moderation action: missing user IDs");
    return false;
  }

  try {
    switch (action.type) {
      case "ban":
        await request(
          `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}`,
          {
            method: "POST",
            body: JSON.stringify({
              data: {
                user_id: userId,
                reason: "Automated ban: message violated rules",
              },
            }),
          }
        );
        log(`🔨 BANNED user ${username}: "${message}"`);
        return true;

      case "timeout":
        await request(
          `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}`,
          {
            method: "POST",
            body: JSON.stringify({
              data: {
                user_id: userId,
                duration: action.duration,
                reason: `Automated timeout (${action.duration}s): message violated rules`,
              },
            }),
          }
        );
        log(`⏱️ MUTED user ${username} for ${action.duration}s: "${message}"`);
        return true;

      case "delete":
        if (!messageId) {
          log("❌ Cannot delete message: no message ID");
          return false;
        }
        await request(
          `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}&message_id=${messageId}`,
          {
            method: "DELETE",
          }
        );
        log(`🗑️ DELETED message from ${username}: "${message}"`);
        return true;

      default:
        log(`❌ Unknown moderation action type: ${action.type}`);
        return false;
    }
  } catch (error) {
    log(`❌ Moderation action failed: ${error.message}`);
    return false;
  }
}

// ============================
// API REQUEST FUNCTION
// ============================

async function request(url, options = {}) {
  const token = localStorage.getItem("twitch_token");

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

  try {
    const response = await fetch(url, mergedOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log(`❌ API Error ${response.status}: ${errorText}`);
      throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }

    return response;
  } catch (error) {
    log(`❌ Request failed: ${error.message}`);
    throw error;
  }
}

// ============================
// CLASSES
// ============================

class PersistentDeck {
  constructor(name) {
    this.key = name;
    this._load();
  }

  _load() {
    const raw = localStorage.getItem(this.key);
    this.data = raw ? JSON.parse(raw) : [];
  }

  _save() {
    localStorage.setItem(this.key, JSON.stringify(this.data));
  }

  push(item) {
    this.data.push(item);
    this._save();
  }

  pop() {
    const item = this.data.pop();
    this._save();
    return item;
  }

  unshift(item) {
    this.data.unshift(item);
    this._save();
  }

  shift() {
    const item = this.data.shift();
    this._save();
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
    this._save();
  }

  all() {
    return [...this.data];
  }

  size() {
    return this.data.length;
  }
}

// ============================
// STREAM MANAGEMENT
// ============================

function initializePresets() {
  const selector = document.getElementById("presetSelector");

  // Clear existing options except the first one
  while (selector.children.length > 1) {
    selector.removeChild(selector.lastChild);
  }

  // Add preset options
  Object.keys(DEFAULT_PRESETS).forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key.charAt(0).toUpperCase() + key.slice(1);
    selector.appendChild(option);
  });
}

function updatePresetInfo(presetKey) {
  const preset = DEFAULT_PRESETS[presetKey];
  const infoDiv = document.getElementById("presetInfo");

  if (preset) {
    document.getElementById("presetTitle").textContent = preset.title;
    document.getElementById("presetGame").textContent = preset.game_id;
    document.getElementById("presetTags").textContent = preset.tags.join(", ");
    document.getElementById("presetPin").textContent =
      preset.pinned_message || "No pinned message";
    infoDiv.classList.remove("preset-info-hidden");
  } else {
    infoDiv.classList.add("preset-info-hidden");
  }
}

async function applyStreamPreset(presetKey) {
  if (!currentUserId) {
    log("❌ No user ID available for stream update");
    return;
  }

  const preset = DEFAULT_PRESETS[presetKey];
  if (!preset) {
    log("❌ Preset not found: " + presetKey);
    return;
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${currentUserId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          game_id: preset.game_id,
          title: preset.title,
          tags: preset.tags,
        }),
      },
    );

    log(`✅ Stream updated with preset: ${presetKey}`);
    updateStreamStatus(true);

    // Apply reward configuration for this preset
    await applyRewardConfig(presetKey);

    // Send and pin preset message to chat
    if (preset.pinned_message) {
      log("📌 Sending and pinning preset message to chat:");
      //temp disabled
      //      sendPinnedMessage(preset.pinned_message);
    }
  } catch (error) {
    log(`❌ Error updating stream: ${error.message}`);
  }
}

async function getCurrentStreamInfo() {
  if (!currentUserId) {
    log("❌ No user ID available");
    return;
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${currentUserId}`,
    );

    const data = await response.json();
    const channel = data.data[0];
    log(
      `📺 Current: "${channel.title}" | Game: ${channel.game_name} | Tags: [${channel.tags.join(", ")}]`,
    );
    updateStreamStatus(true);
  } catch (error) {
    log(`❌ Error getting stream info: ${error.message}`);
    updateStreamStatus(false);
  }
}

function updateStreamStatus(connected) {
  const indicator = document.getElementById("streamStatus");
  if (connected) {
    indicator.classList.add("connected");
  } else {
    indicator.classList.remove("connected");
  }
}

// ============================
// CHAT SETTINGS MANAGEMENT
// ============================

async function getCurrentChatSettings() {
  if (!currentUserId) {
    log("❌ No user ID available for chat settings");
    return null;
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/chat/settings?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}`,
    );

    const data = await response.json();
    return data.data[0];
  } catch (error) {
    log(`❌ Error getting chat settings: ${error.message}`);
    return null;
  }
}

async function pinMessageById(messageId, messageText) {
  if (!currentUserId || !messageId) {
    log("❌ No user ID or message ID for pinning");
    return false;
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/chat/settings?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          pinned_chat_message_id: messageId,
        }),
      },
    );

    log(`📌 Successfully pinned: "${messageText}"`);
    return true;
  } catch (error) {
    log(`❌ Error pinning message: ${error.message}`);
    return false;
  }
}

// ============================
// AUTHENTICATION & USER MANAGEMENT
// ============================

function extractToken() {
  const hash = window.location.hash;
  if (hash.includes("access_token")) {
    const params = new URLSearchParams(hash.substr(1));
    const token = params.get("access_token");
    if (token) {
      localStorage.setItem("twitch_token", token);
      window.location.hash = ""; // clean up
      return token;
    }
  }
  return null;
}

function authenticate() {
  const authURL = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=${SCOPES.join("+")}`;
  window.location.href = authURL;
}

async function fetchUsername(token) {
  const response = await request("https://api.twitch.tv/helix/users");
  const data = await response.json();
  const user = data.data[0];
  currentUserId = user.id; // Store user ID for stream updates
  return user.login;
}

// Get user ID from username (required for API whispers)
async function getUserId(username) {
  const normalizedUsername = username.toLowerCase();

  // Check cache first
  if (userIdCache[normalizedUsername]) {
    return userIdCache[normalizedUsername];
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/users?login=${normalizedUsername}`,
    );
    const data = await response.json();

    if (data.data.length > 0) {
      const userId = data.data[0].id;
      userIdCache[normalizedUsername] = userId; // Cache it
      return userId;
    }
    return null;
  } catch (error) {
    log(`❌ Error getting user ID for ${username}: ${error.message}`);
    return null;
  }
}

// ============================
// MESSAGING FUNCTIONS
// ============================

function updateTwitchStatus(connected) {
  const indicator = document.getElementById("twitchStatus");
  twitchConnected = connected;
  if (connected) {
    indicator.classList.add("connected");
  } else {
    indicator.classList.remove("connected");
  }
}

function updateMinaretStatus(connected) {
  const indicator = document.getElementById("minaretStatus");
  if (connected) {
    indicator.classList.add("connected");
  } else {
    indicator.classList.remove("connected");
  }
}

async function sendPinnedMessage(message) {
  if (!twitchConnected || !ws || !message) {
    log("💥 Twitch not connected or empty message!", "error");
    return;
  }

  // Set pending pin message
  pendingPinMessage = message;

  // Send message via IRC
  try {
    const sanitized = message.toString().trim();
    if (sanitized.length === 0) {
      log("💥 Empty message after sanitization!", "error");
      return;
    }
    ws.send(`PRIVMSG #${CHANNEL} :${sanitized}`);
    log(`📤 Sent pinned message: ${sanitized}`);
  } catch (error) {
    log(`💥 Failed to send pinned message: ${error.message}`, "error");
    pendingPinMessage = null; // Clear on error
  }
}

async function checkAndSetDefaultPinnedMessage() {
  const settings = await getCurrentChatSettings();
  if (!settings) return;

  // If no pinned message, send and pin default to chat
  if (!settings.pinned_chat_message_id) {
    log("📌 No pinned message found, sending and pinning default");
    sendPinnedMessage(DEFAULT_PINNED_MESSAGE);
  } else {
    log("📌 Pinned message already exists");
  }
}

// Send private whisper via Twitch API (truly private)
async function apiWhisper(username, message) {
  if (!currentUserId || !username || !message) {
    log("❌ Missing user ID, username, or message for whisper");
    return false;
  }

  const targetUserId = await getUserId(username);
  if (!targetUserId) {
    log(`❌ Could not find user ID for: ${username}`);
    return false;
  }

  try {
    const response = await request("https://api.twitch.tv/helix/whispers", {
      method: "POST",
      body: JSON.stringify({
        from_user_id: currentUserId,
        to_user_id: targetUserId,
        message: message.toString().trim(),
      }),
    });

    log(`💬 Private whisper sent to ${username}: ${message}`);
    return true;
  } catch (error) {
    log(`❌ Whisper error: ${error.message}`);
    // Fallback to public mention
    whisper(username, message);
    return false;
  }
}

// Public mention fallback (when private whispers fail)
function whisper(user, message) {
  if (!twitchConnected || !ws || !user || !message) {
    log("💥 Twitch not connected, missing user, or empty message!", "error");
    return;
  }
  try {
    const sanitizedUser = user.toString().trim();
    const sanitizedMessage = message.toString().trim();

    if (sanitizedUser.length === 0 || sanitizedMessage.length === 0) {
      log("💥 Empty user or message after sanitization!", "error");
      return;
    }

    // Use public mention instead of deprecated IRC whispers
    const mentionMessage = `@${sanitizedUser} ${sanitizedMessage}`;
    ws.send(`PRIVMSG #${CHANNEL} :${mentionMessage}`);
    log(`📤 Mention to ${sanitizedUser}: ${sanitizedMessage}`);
  } catch (error) {
    log(`💥 Mention send failed: ${error.message}`, "error");
  }
}

// Send action message (/me) - appears grayed/italicized
function sendAction(message) {
  if (!twitchConnected || !ws || !message) {
    log("💥 Twitch not connected or empty message!", "error");
    return;
  }
  try {
    const sanitized = message.toString().trim();
    if (sanitized.length === 0) {
      log("💥 Empty message after sanitization!", "error");
      return;
    }
    // IRC ACTION format: PRIVMSG #channel :\x01ACTION message\x01
    ws.send(`PRIVMSG #${CHANNEL} :\x01ACTION ${sanitized}\x01`);
    log(`📤 Action: * ${sanitized}`);
  } catch (error) {
    log(`💥 Action send failed: ${error.message}`, "error");
  }
}

// Send colored announcement (requires moderator permissions)
async function sendAnnouncement(message, color = "purple") {
  if (!currentUserId || !message) {
    log("❌ No user ID or empty message for announcement");
    return false;
  }

  // Valid colors: blue, green, orange, purple, primary
  const validColors = ["blue", "green", "orange", "purple", "primary"];
  if (!validColors.includes(color)) {
    color = "purple"; // Default fallback
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}`,
      {
        method: "POST",
        body: JSON.stringify({
          message: message.toString().trim(),
          color: color,
        }),
      },
    );

    log(`📢 ${color.toUpperCase()} announcement sent: ${message}`);
    return true;
  } catch (error) {
    log(`❌ Announcement error: ${error.message}`);
    // Fallback to action message
    sendAction(`📢 ${message}`);
    return false;
  }
}

function send_twitch(message) {
  if (!twitchConnected || !ws || !message) {
    log("💥 Twitch not connected or empty message!", "error");
    return;
  }
  try {
    const sanitized = message.toString().trim();
    if (sanitized.length === 0) {
      log("💥 Empty message after sanitization!", "error");
      return;
    }
    ws.send(`PRIVMSG #${CHANNEL} :${sanitized}`);
    log(`📤 Twitch: ${sanitized}`);
  } catch (error) {
    log(`💥 Twitch send failed: ${error.message}`, "error");
  }
}

// ============================
// CHANNEL POINT REWARDS SYSTEM
// ============================

// Create a custom reward
async function createCustomReward(rewardKey) {
  if (!currentUserId) {
    log("❌ No user ID available for reward creation");
    return null;
  }

  const rewardConfig = DEFAULT_REWARDS[rewardKey];
  if (!rewardConfig) {
    log(`❌ Unknown reward key: ${rewardKey}`);
    return null;
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${currentUserId}`,
      {
        method: "POST",
        body: JSON.stringify(rewardConfig),
      },
    );

    const data = await response.json();
    const reward = data.data[0];
    customRewards[reward.id] = { ...reward, action: rewardConfig.action };
    log(`✅ Created reward: "${reward.title}" (ID: ${reward.id})`);
    return reward;
  } catch (error) {
    log(`❌ Error creating reward: ${error.message}`);
    return null;
  }
}

// Get all custom rewards
async function getCustomRewards() {
  if (!currentUserId) {
    log("❌ No user ID available for getting rewards");
    return [];
  }

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${currentUserId}`,
    );

    const data = await response.json();
    log(`📋 Found ${data.data.length} custom rewards`);
    return data.data;
  } catch (error) {
    log(`❌ Error getting rewards: ${error.message}`);
    return [];
  }
}

// Update redemption status (FULFILLED/CANCELED)
async function updateRedemptionStatus(rewardId, redemptionId, status) {
  if (!currentUserId) return;

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${currentUserId}&reward_id=${rewardId}&id=${redemptionId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: status }),
      },
    );

    log(`✅ Redemption ${status.toLowerCase()}: ${rewardId} ${redemptionId}`);
  } catch (error) {
    log(`❌ Error updating redemption: ${error.message}`);
  }
}

// Update reward visibility via API
async function updateRewardState(rewardId, isEnabled) {
  if (!currentUserId) {
    log("❌ No user ID available for reward state update");
    return false;
  }

  log(`🔄 Updating reward ${rewardId} to ${isEnabled ? 'ENABLED (visible)' : 'DISABLED (hidden)'}...`);

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${currentUserId}&id=${rewardId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ is_enabled: isEnabled }),
      },
    );

    const data = await response.json();
    log(`✅ Reward state updated: ${data.data[0]?.title} is_enabled=${isEnabled}`);
    return true;
  } catch (error) {
    log(`❌ Error updating reward state: ${error.message}`);
    return false;
  }
}

// Apply reward configuration based on preset
async function applyRewardConfig(presetKey) {
  const preset = presetKey ? DEFAULT_PRESETS[presetKey] : null;
  const activeRewards = preset ? preset.rewards_active : [];

  log(
    `🎯 Applying reward config for preset: ${presetKey || "default (all paused)"}`,
  );
  log(`🎯 Active rewards list: [${activeRewards.join(", ")}]`);

  // Get existing rewards to find their IDs
  const existingRewards = await getCustomRewards();
  log(`🎯 Found ${existingRewards.length} existing rewards to configure`);

  // Update each reward's pause state
  for (const reward of existingRewards) {
    // Find the reward key by matching title with DEFAULT_REWARDS
    const rewardKey = Object.keys(DEFAULT_REWARDS).find(
      (key) => DEFAULT_REWARDS[key].title === reward.title,
    );

    if (!rewardKey) {
      log(`⚠️ Unknown reward: ${reward.title}`);
      continue;
    }

    // Determine if this reward should be enabled (visible)
    const shouldBeEnabled = activeRewards.includes(rewardKey);

    // Update the reward state if it changed
    if (reward.is_enabled !== shouldBeEnabled) {
      const success = await updateRewardState(reward.id, shouldBeEnabled);
      if (success) {
        const state = shouldBeEnabled ? "✅ enabled" : "❌ disabled";
        log(`${state}: ${reward.title}`);
      }
    }
  }

  log("✅ Reward configuration applied");
}

// Initialize rewards system
async function initializeRewards() {
  log("🎯 Initializing Channel Point Rewards...");

  // Get existing rewards
  const existingRewards = await getCustomRewards();

  // Create missing default rewards
  for (const [key, config] of Object.entries(DEFAULT_REWARDS)) {
    const exists = existingRewards.find((r) => r.title === config.title);
    if (!exists) {
      log(`➕ Creating missing reward: ${config.title}`);
      await createCustomReward(key);
    } else {
      // Cache existing reward
      customRewards[exists.id] = { ...exists, action: config.action };
      log(`✅ Found existing reward: ${exists.title}`);
    }
  }

  log("🎯 Rewards initialization complete!");

  // Apply default state: all rewards paused when no preset is active
  await applyRewardConfig(null);

  // Automatically display rewards list after initialization
  await displayRewardsList();
}

// Automatically display rewards in the UI
async function displayRewardsList() {
  const rewards = await getCustomRewards();
  const rewardsList = document.getElementById("rewardsList");

  if (rewards.length === 0) {
    rewardsList.innerHTML = "<div class='no-rewards'>No rewards found</div>";
    log("📋 No rewards to display");
  } else {
    rewardsList.innerHTML = rewards
      .map(
        (r) =>
          `<div class='reward-item'>
                <strong>${r.title}</strong><br>
                Cost: ${r.cost} points | Enabled: ${r.is_enabled ? "✅" : "❌"}
            </div>`,
      )
      .join("");
    log(`📋 Displayed ${rewards.length} rewards in UI`);
  }
}

// ============================
// EVENTSUB WEBSOCKET
// ============================

// Simple EventSub implementation for real-time redemptions
function connectEventSub() {
  if (eventSubSocket || !currentUserId) return;

  log("🔌 Connecting to EventSub...");
  eventSubSocket = new WebSocket("wss://eventsub.wss.twitch.tv/ws");

  eventSubSocket.onopen = () => log("✅ EventSub connected");
  eventSubSocket.onclose = () => {
    log("❌ EventSub disconnected");
    eventSubSocket = null;
    sessionId = null;
    setTimeout(connectEventSub, 5000);
  };

  eventSubSocket.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    const type = msg.metadata?.message_type;

    if (type === "session_welcome") {
      sessionId = msg.payload.session.id;
      log(`✅ EventSub session: ${sessionId}`);

      // Subscribe to redemptions
      await request("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          type: "channel.channel_points_custom_reward_redemption.add",
          version: "1",
          condition: { broadcaster_user_id: currentUserId },
          transport: { method: "websocket", session_id: sessionId },
        }),
      });
      log("✅ Subscribed to redemption events");
    }

    if (type === "notification") {
      const redemption = msg.payload.event;
      log(
        `🎯 REAL REDEMPTION: ${redemption.reward.title} by ${redemption.user_name}`,
      );
      handleRewardRedemption(redemption);
    }
  };
}

// ============================
// TWITCH CHAT INTEGRATION
// ============================

async function startChat(token) {
  const username = await fetchUsername(token);

  ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.onerror = (error) => {
    log(`❌ WebSocket error: ${error}`);
  };
  ws.onclose = () => {
    log("❌ WebSocket closed. Reconnecting...");
    updateTwitchStatus(false);
    setTimeout(
      () => (ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443")),
      1000,
    );
  };
  ws.onopen = async () => {
    // Enable IRC tags to get message IDs
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send(`PASS oauth:${token}`);
    ws.send(`NICK ${username}`);
    ws.send(`JOIN #${CHANNEL}`);
    log(`✅ Connected to #${CHANNEL} as ${username}`);
    updateTwitchStatus(true);
    // await checkAndSetDefaultPinnedMessage();
    await initializeRewards(); // Initialize Channel Point Rewards
    connectEventSub(); // Connect EventSub for real-time redemptions
  };

  ws.onmessage = async (event) => {
    if (event.data.startsWith("PING")) {
      ws.send("PONG :tmi.twitch.tv");
      return;
    }

    // Handle our own messages with message IDs for pinning
    if (event.data.includes("@msg-id=") && pendingPinMessage) {
      const msgIdMatch = event.data.match(/@msg-id=([^;]+)/);
      if (msgIdMatch) {
        const messageId = msgIdMatch[1];
        log(`📌 Captured message ID: ${messageId}`);
        // Pin the message
        pinMessageById(messageId, pendingPinMessage);
        pendingPinMessage = null; // Clear pending
      }
    }

    const match = event.data.match(/:(.+) PRIVMSG #[^\s]+ :(.+)/);
    if (match) {
      const user = match[1].split("!")[0];
      const msg = match[2].trim();

      // Parse IRC tags for moderation data
      const tags = parseIrcTags(event.data);
      const userId = tags?.["user-id"];
      const messageId = tags?.id;

      // Check ban rules (skip if it's our own message or a broadcaster)
      if (userId && userId !== currentUserId && BAN_RULES.length > 0) {
        const action = checkBanRules(msg);
        if (action) {
          await executeModerationAction(action, userId, messageId, user, msg);
          return; // Stop processing this message
        }
      }

      // Normal message processing
      if (msg.startsWith("!")) handleCommand(user, msg);
      else {
        mp3("icq");
        sendMessageMinaret(user, msg);
      }
    } else {
      log(event.data); // do not understand the source
    }
  };
}

/// MAIN ///
function handleCommand(user, cmd) {
  let success = true;
  if (cmd.startsWith("!song")) {
    let song = cmd.slice(6).trim();
    console.log("♬  " + user + " => |" + song + "|");
    if (
      song.match(
        /^https:\/\/music\.yandex\.(ru|com)\/(album\/\d+\/)?track\/\d+/,
      )
    ) {
      song.replace(/yandex\.com/, "yandex.ru");
      send_twitch("Queue size is " + queueSong(song));
    } else {
      success = false;
      apiWhisper(user, "Invalid song URL");
    }
  } else if (cmd === "!love_vany") {
    sendMessageMinaret("§a Dance Dance Dance! They love you!!!");
    sendAction("dances with joy! 💃✨");
    love_timer = Date.now();
  } else if (cmd === "!hate_vany") {
    if (throttle[user] === undefined) throttle[user] = Date.now() - 61_000;
    let p = Date.now() - throttle[user];
    if (p < 60_000 && user !== "vanyserezhkin") {
      log("Throttled: ");
      return;
    }
    throttle[user] = Date.now();

    sendCommandMinaret(
      "effect give vany_serezhkin minecraft:instant_health 3 255 true",
    );
    if (Date.now() - love_timer < 60_000) {
      sendMessageMinaret("§c Beware !!! They are hating you!!");
      mp3("ahhh");
    } else
      setTimeout(
        () =>
          sendCommandMinaret(
            "execute at vany_serezhkin run summon minecraft:lightning_bolt ~ ~ ~",
          ),
        1000,
      );
    love_timer = Date.now();
  } else if (cmd.startsWith("!voice")) {
    let voice = cmd.slice(7).trim();
    let x = new SpeechSynthesisUtterance(voice);
    x.language = "en-US";
    x.rate = 1;
    x.pitch = 1;
    x.voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
    speechSynthesis.speak(x);
    console.log("🎤 Speaking:", voice);
    sendMessageMinaret(cmd);
  } else if (cmd.startsWith("!chat")) {
    let c = cmd.slice(6).trim();
    const audio = document.getElementById("myAudio");
    const validSounds = new Set(["boo", "creeper", "tentacle", "woop"]);
    if (validSounds.has(c)) mp3(c);
    else mp3("woop");
    console.log(audio.src);
    sendMessageMinaret(cmd);
  } else {
    sendMessageMinaret(cmd);
  }
  return success;
}

function handleRewardRedemption(redemption) {
  const rewardId = redemption.reward.id;
  const rewardTitle = redemption.reward.title;
  const userName = redemption.user_name;
  const userInput = redemption.user_input || "";

  log(`🎯 Reward redeemed: "${rewardTitle}" by ${userName}`);

  // Find the action for this reward
  const reward = customRewards[rewardId];
  if (!reward) {
    log(`❌ Unknown reward ID: ${rewardId}`);
    return;
  }

  const action = reward.action;
  let failed = false;

  switch (action) {
    case "hate":
      handleCommand(userName, "!hate_vany");
      break;

    case "love":
      handleCommand(userName, "!love_vany");
      break;

    case "music":
      failed = !handleCommand(userName, "!song " + userInput);
      break;

    case "voice":
      handleCommand(userName, "!voice " + userInput);
      break;

    case "vote_skip":
      if (needVoteSkip-- < 2) skipSong();
      else
        ws.send(`PRIVMSG #${CHANNEL} :/me 🆘Skip votes needed ${needVoteSkip}`);
      break;

    case "playing":
      ws.send(`PRIVMSG #${CHANNEL} :/me 🎹 ${currentSong}`);
      break;

    default:
      log(`❌ Unknown action: ${action}`);
      failed = true;
  }

  console.log("redemption", redemption);
  updateRedemptionStatus(
    redemption.reward.id,
    redemption.id,
    failed ? "CANCELED" : "FULFILLED",
  );
}

// ============================
// MUSIC QUEUE SYSTEM
// ============================

// TODO Constructor must make something sane

var songQueue = new PersistentDeck("toplay");
function queueSong(song) {
  if (songQueue.size() == 0) playSong(song);
  songQueue.push(song);

  registerReplyListener("music_done", (url) => {
    console.log("music done : " + url);
    if (url != "https://music.yandex.ru/") skipSong();
    else songQueue.shift();
    console.log(songQueue.all());
  });

  return songQueue.size() - 1;
}

function skipSong() {
  songQueue.shift();
  if (songQueue.size() > 0) playSong(songQueue.peekBottom());
  else playSong("https://music.yandex.ru/");
}

function playSong(url) {
  needVoteSkip = 3;
  console.log("Playing song: " + url);
  sendCommandToOtherTabs("song", url);
}

// ============================
// MINECRAFT SERVER INTEGRATION
// ============================

function connectMinaret() {
  try {
    let url = "ws://localhost:8765";
    minarert = new WebSocket(url);

    minarert.onopen = function () {
      isConnected = true;
      updateMinaretStatus(true);
      log("🔗 Connected to " + url);
    };

    minarert.onmessage = function (event) {
      log("📨 Received: " + event.data, "received");
    };

    minarert.onclose = function (event) {
      isConnected = false;
      updateMinaretStatus(false);
      if (event.code === 1006) {
        log(
          "❌ Connection failed - check credentials and server status",
          "error",
        );
      } else {
        log("❌ Connection closed (code: " + event.code + ")", "error");
      }
      setTimeout(connectMinaret, 5000); // Reconnect after 5 seconds
    };

    minarert.onerror = function (error) {
      log("💥 WebSocket error - authentication may have failed", "error");
    };
  } catch (error) {
    log("💥 Connection failed: " + error.message, "error");
  }
}

function sendMessageMinaret(user, msg) {
  msg = log(msg);

  if (!isConnected || !minarert) {
    log("💥 Not connected!", "error");
    return;
  }
  try {
    minarert.send(JSON.stringify({ message: msg, user: user, chat: "T" }));
  } catch (error) {
    log("💥 Send failed: " + error.message, "error");
  }
}

function sendCommandMinaret(msg) {
  if (!isConnected || !minarert || !msg) {
    log("💥 Not connected!", "error");
    return;
  }
  try {
    minarert.send('{"command": "' + msg + '"}');
    log("📤 Sent: " + msg + " sent");
  } catch (error) {
    log("💥 Send failed: " + error.message, "error");
  }
}

// ============================
// TEST FUNCTIONS
// ============================

function test() {
  let x = new SpeechSynthesisUtterance("Test passed");
  x.language = "en-US";
  x.rate = 1;
  x.pitch = 1;
  x.volume = 0.2;
  x.voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
  speechSynthesis.speak(x);
}

// ============================
// INITIALIZATION
// ============================

(async () => {
  const existingToken = localStorage.getItem("twitch_token") || extractToken();
  if (!existingToken) {
    authenticate();
  } else {
    await startChat(existingToken);
  }
  connectMinaret();
  log("∞ initialized");

  initializePresets();

  document
    .getElementById("presetSelector")
    .addEventListener("change", function (e) {
      updatePresetInfo(e.target.value);
      const selectedPreset = document.getElementById("presetSelector").value;
      if (selectedPreset) {
        applyStreamPreset(selectedPreset);
      }
    });

  // Rewards system event listeners
  // Removed manual buttons - rewards are now automatically initialized and displayed on connection

  registerReplyListener("song", (url) => {});
  registerReplyListener("music_start", (name) => {
    name.replace(/\n/, " by ");
    currentSong = name;
    ws.send(`PRIVMSG #${CHANNEL} :/me 📀 ${name}`);
  });

  skipSong();
})();
