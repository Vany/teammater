// ============================
// CONFIGURATION
// ============================

// Import configuration from config.js
import {
  BAN_RULES,
  DEFAULT_PRESETS,
  DEFAULT_REWARDS,
  DEFAULT_PINNED_MESSAGE,
  TWITCH_CLIENT_ID_KEY,
  TWITCH_SCOPES,
  WEBSOCKET_URLS,
  TWITCH_API_BASE,
  MUSIC_URL_PATTERN,
  EMPTY_MUSIC_URL,
  INITIAL_SONG_NAME,
  VOTE_SKIP_THRESHOLD,
  AUDIO_DIRECTORY,
  VALID_SOUND_EFFECTS,
  SPEECH_SETTINGS,
  MINECRAFT_PLAYER_NAME,
  MINECRAFT_COMMANDS,
  TIMING,
  BROADCASTER_USERNAME,
} from "./config.js";

// Import utilities from utils.js
import { request, PersistentDeck, parseIrcTags } from "./utils.js";

// Import external connectors
import { MusicQueue, MinecraftConnector } from "./connectors.js";

// Import actions for test button
import { voice } from "./actions.js";

// Twitch API Configuration
const CLIENT_ID = localStorage.getItem(TWITCH_CLIENT_ID_KEY) || "";
const REDIRECT_URI = window.location.origin;
const urlParams = new URLSearchParams(window.location.search);
let CHANNEL; // Set after authentication: URL parameter or authenticated user's channel
const SCOPES = TWITCH_SCOPES;

// ============================
// GLOBAL VARIABLES
// ============================

window.i_am_a_master = true;

// State variables
var throttle = {};
var ws;
var love_timer = Date.now();
let twitchConnected = false;
let currentUserId = null;
let pendingPinMessage = null; // Store message waiting to be pinned
let userIdCache = {}; // Cache username -> user_id mappings
let customRewards = {}; // Cache reward_id -> reward_data mappings
let eventSubSocket = null; // EventSub WebSocket connection
let sessionId = null; // EventSub session ID

// External connectors (initialized after DOM load)
let musicQueue = null;
let minecraft = null;

// DOM element cache (populated on initialization)
const DOM = {
  output: null,
  twitchStatus: null,
  minaretStatus: null,
  streamStatus: null,
  presetSelector: null,
  presetInfo: null,
  presetTitle: null,
  presetGame: null,
  presetTags: null,
  presetPin: null,
  rewardsList: null,
  audio: null,
  loudCheckbox: null,
};

/**
 * Cache all DOM element references
 * Called once on initialization
 */
function cacheDOMElements() {
  DOM.output = document.getElementById("output");
  DOM.twitchStatus = document.getElementById("twitchStatus");
  DOM.minaretStatus = document.getElementById("minaretStatus");
  DOM.streamStatus = document.getElementById("streamStatus");
  DOM.presetSelector = document.getElementById("presetSelector");
  DOM.presetInfo = document.getElementById("presetInfo");
  DOM.presetTitle = document.getElementById("presetTitle");
  DOM.presetGame = document.getElementById("presetGame");
  DOM.presetTags = document.getElementById("presetTags");
  DOM.presetPin = document.getElementById("presetPin");
  DOM.rewardsList = document.getElementById("rewardsList");
  DOM.audio = document.getElementById("myAudio");
  DOM.loudCheckbox = document.getElementById("loudCheckbox");
}

/**
 * Initialize stored elements system
 * All elements with stored_as="key" attribute are automatically persisted to localStorage
 * - On page load: restore value from localStorage[key]
 * - On change: save value to localStorage[key]
 * Supports: checkbox (checked state), input/textarea (value), select (value)
 */
function initializeStoredElements() {
  const elements = document.querySelectorAll("[stored_as]");

  elements.forEach((el) => {
    const key = el.getAttribute("stored_as");
    const storedValue = localStorage.getItem(key);

    // Restore from storage
    if (storedValue !== null) {
      if (el.type === "checkbox") {
        el.checked = storedValue === "true";
      } else if (el.tagName === "SELECT" || el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.value = storedValue;
      }
    }

    // Set up automatic write-through on change
    el.addEventListener("change", () => {
      if (el.type === "checkbox") {
        localStorage.setItem(key, el.checked);
        log(`💾 Stored ${key} = ${el.checked}`);
      } else {
        localStorage.setItem(key, el.value);
        log(`💾 Stored ${key} = ${el.value}`);
      }
    });
  });

  log(`✅ Initialized ${elements.length} stored elements`);
}
// ============================
// UTILITY FUNCTIONS
// ============================

function log(msg) {
  const div = document.createElement("div");
  div.textContent = msg;
  DOM.output.appendChild(div);
  return div.innerHTML;
}

function mp3(name) {
  DOM.audio.src = AUDIO_DIRECTORY + name + ".mp3";
  DOM.audio.play().catch((err) => {
    speak("ACHTUNG");
    console.error("Playback failed:", err);
  });
}

function speak(str) {
  let x = new SpeechSynthesisUtterance(str);
  x.language = SPEECH_SETTINGS.LANGUAGE;
  x.rate = SPEECH_SETTINGS.RATE;
  x.pitch = SPEECH_SETTINGS.PITCH;
  x.voice = speechSynthesis
    .getVoices()
    .find((v) => v.lang === SPEECH_SETTINGS.LANGUAGE);
  speechSynthesis.speak(x);
}

// ============================
// BAN SYSTEM
// ============================

// Check if message matches ban rules
// Returns the action closure if a rule matches, null otherwise
function checkBanRules(message) {
  for (const rule of BAN_RULES) {
    if (rule.length < 2) continue; // Invalid rule

    const actionClosure = rule[0];
    const patterns = rule.slice(1);

    // Check if ALL patterns match (AND logic)
    const allMatch = patterns.every((pattern) => {
      const matches = pattern.test(message);
      return matches;
    });

    if (allMatch) {
      log(`  ⚠️ ALL PATTERNS MATCHED! Returning action.`);
      return actionClosure; // Return first matching rule's action closure
    }
  }

  log(`  ℹ️ No rules matched`);
  return null; // No rules matched
}

// Execute moderation action closure with context
async function executeModerationAction(
  actionClosure,
  userId,
  messageId,
  user,
  message,
) {
  if (!actionClosure || typeof actionClosure !== "function") {
    log("❌ Invalid moderation action closure");
    return false;
  }

  // Build context object for moderation action
  const context = {
    currentUserId,
    userId,
    messageId,
    request,
    log,
  };

  try {
    await actionClosure(context, user, message);
    return true;
  } catch (error) {
    log(`❌ Moderation action execution failed: ${error.message}`);
    console.error("Moderation action error:", error);
    return false;
  }
}

// ============================
// CLASSES
// ============================

// ============================
// STREAM MANAGEMENT
// ============================

function initializePresets() {
  // Clear existing options except the first one
  while (DOM.presetSelector.children.length > 1) {
    DOM.presetSelector.removeChild(DOM.presetSelector.lastChild);
  }

  // Add preset options
  Object.keys(DEFAULT_PRESETS).forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key.charAt(0).toUpperCase() + key.slice(1);
    DOM.presetSelector.appendChild(option);
  });
}

function updatePresetInfo(presetKey) {
  const preset = DEFAULT_PRESETS[presetKey];

  if (preset) {
    DOM.presetTitle.textContent = preset.title;
    DOM.presetGame.textContent = preset.game_id;
    DOM.presetTags.textContent = preset.tags.join(", ");
    DOM.presetPin.textContent = preset.pinned_message || "No pinned message";
    DOM.presetInfo.classList.remove("preset-info-hidden");
  } else {
    DOM.presetInfo.classList.add("preset-info-hidden");
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
  if (connected) {
    DOM.streamStatus.classList.add("connected");
  } else {
    DOM.streamStatus.classList.remove("connected");
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
  if (!CLIENT_ID) {
    log("❌ Twitch Client ID is not set!");
    log("📝 Please enter your Client ID in the input field at the bottom of the panel");
    log("🔄 Then reload the page");
    return;
  }
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

/**
 * Check if authenticated user is a moderator in the target channel
 * @param {string} channelName - Channel login name to check
 * @returns {Promise<boolean>} - True if user is moderator or broadcaster
 */
async function checkModeratorStatus(channelName) {
  try {
    // Get channel user ID
    const channelUserId = await getUserId(channelName);
    if (!channelUserId) {
      log(`❌ Could not get user ID for channel: ${channelName}`);
      return false;
    }

    // If we're the broadcaster, we always have rights
    if (currentUserId === channelUserId) {
      log(`✅ You are the broadcaster of #${channelName}`);
      return true;
    }

    // Check if we're in the moderators list
    const response = await request(
      `https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${channelUserId}&user_id=${currentUserId}`,
    );
    const data = await response.json();

    const isModerator = data.data && data.data.length > 0;
    if (isModerator) {
      log(`✅ You are a moderator in #${channelName}`);
    } else {
      log(`⚠️ You are NOT a moderator in #${channelName}`);
    }

    return isModerator;
  } catch (error) {
    log(`❌ Error checking moderator status: ${error.message}`);
    return false;
  }
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
  twitchConnected = connected;
  if (connected) {
    DOM.twitchStatus.classList.add("connected");
  } else {
    DOM.twitchStatus.classList.remove("connected");
  }
}

function updateMinaretStatus(connected) {
  if (connected) {
    DOM.minaretStatus.classList.add("connected");
  } else {
    DOM.minaretStatus.classList.remove("connected");
  }
}

/**
 * Initialize Minecraft connector if not already initialized
 * Called conditionally based on moderator permissions
 */
function initializeMinecraftConnector() {
  if (minecraft) {
    log("ℹ️ Minecraft connector already initialized");
    return;
  }

  minecraft = new MinecraftConnector({
    url: WEBSOCKET_URLS.MINARET_SERVER,
    reconnectDelay: TIMING.RECONNECT_DELAY_MS,
    log: log,
    onStatusChange: updateMinaretStatus,
  });
  minecraft.connect();
  log("🎮 Minecraft connector initialized");
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

  // Extract action closure before sending to API (Twitch API doesn't accept functions)
  const actionClosure = rewardConfig.action;
  const { action, ...apiConfig } = rewardConfig;

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${currentUserId}`,
      {
        method: "POST",
        body: JSON.stringify(apiConfig),
      },
    );

    const data = await response.json();
    const reward = data.data[0];
    // Store reward with action closure reference
    customRewards[reward.id] = { ...reward, action: actionClosure };
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

  log(
    `🔄 Updating reward ${rewardId} to ${isEnabled ? "ENABLED (visible)" : "DISABLED (hidden)"}...`,
  );

  try {
    const response = await request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${currentUserId}&id=${rewardId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ is_enabled: isEnabled }),
      },
    );

    const data = await response.json();
    log(
      `✅ Reward state updated: ${data.data[0]?.title} is_enabled=${isEnabled}`,
    );
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
      // Cache existing reward with action closure reference
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

  if (rewards.length === 0) {
    DOM.rewardsList.innerHTML =
      "<div class='no-rewards'>No rewards found</div>";
    log("📋 No rewards to display");
  } else {
    DOM.rewardsList.innerHTML = rewards
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
  eventSubSocket = new WebSocket(WEBSOCKET_URLS.TWITCH_EVENTSUB);

  eventSubSocket.onopen = () => log("✅ EventSub connected");
  eventSubSocket.onclose = () => {
    log("❌ EventSub disconnected");
    eventSubSocket = null;
    sessionId = null;
    setTimeout(connectEventSub, TIMING.RECONNECT_DELAY_MS);
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

  // Set channel: URL parameter or authenticated user's own channel
  CHANNEL = urlParams.get("channel") || username;

  log(`🎯 Connecting to channel: #${CHANNEL} (authenticated as: ${username})`);

  ws = new WebSocket(WEBSOCKET_URLS.TWITCH_IRC);
  ws.onerror = (error) => {
    log(`❌ WebSocket error: ${error}`);
  };
  ws.onclose = () => {
    log("❌ WebSocket closed. Reconnecting...");
    updateTwitchStatus(false);
    setTimeout(
      () => (ws = new WebSocket(WEBSOCKET_URLS.TWITCH_IRC)),
      TIMING.RECONNECT_DELAY_MS,
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

    // Check if we should connect to EventSub and Minecraft
    const isOwnChannel = CHANNEL.toLowerCase() === username.toLowerCase();
    if (isOwnChannel) {
      // Own channel - always connect everything
      connectEventSub();
      initializeMinecraftConnector();
    } else {
      // Not own channel - check moderator status first
      const isModerator = await checkModeratorStatus(CHANNEL);
      if (isModerator) {
        connectEventSub();
        initializeMinecraftConnector();
      } else {
        log(
          `⚠️ Connected to non-default channel (#${CHANNEL}) without moderator rights`,
        );
        log(`ℹ️ Channel point reward listener disabled`);
        log(`ℹ️ Minecraft connector disabled`);
      }
    }
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
          log(`⚠️ BAN RULE MATCHED! Executing moderation action...`);
          await executeModerationAction(action, userId, messageId, user, msg);
          return; // Stop processing this message
        }
      }

      // Normal message processing - forward all to Minecraft
      if (msg.startsWith("!")) {
        minecraft?.sendMessage(user, log(msg));
      } else {
        if (DOM.loudCheckbox?.checked) {
          mp3("icq");
        }
        minecraft?.sendMessage(user, log(msg));
      }
    } else {
      log(event.data); // do not understand the source
    }
  };
}

/// MAIN ///
// Build context for reward redemption actions
function buildCommandContext() {
  return {
    // WebSocket connections
    ws,
    minarert: minecraft?.getWebSocket() || null,

    // State variables
    currentUserId,
    CHANNEL,
    throttle,
    love_timer,
    needVoteSkip: musicQueue?.needVoteSkip || VOTE_SKIP_THRESHOLD,
    currentSong: musicQueue?.getCurrentSong() || INITIAL_SONG_NAME,

    // Functions
    log,
    mp3,
    speak,
    send_twitch,
    sendAction,
    sendMessageMinaret: (user, msg) => minecraft?.sendMessage(user, log(msg)),
    sendCommandMinaret: (cmd) => minecraft?.sendCommand(cmd),
    apiWhisper,
    queueSong: (url) => musicQueue?.add(url),
    skipSong: () => musicQueue?.skip(),
  };
}

function handleRewardRedemption(redemption) {
  const rewardId = redemption.reward.id;
  const rewardTitle = redemption.reward.title;
  const userName = redemption.user_name;
  const userInput = redemption.user_input || "";

  log(`🎯 Reward redeemed: "${rewardTitle}" by ${userName}`);

  // Find the action closure for this reward
  const reward = customRewards[rewardId];
  if (!reward) {
    log(`❌ Unknown reward ID: ${rewardId}`);
    updateRedemptionStatus(rewardId, redemption.id, "CANCELED");
    return;
  }

  const actionClosure = reward.action;
  if (typeof actionClosure !== "function") {
    log(`❌ Invalid action for reward: ${rewardTitle}`);
    updateRedemptionStatus(rewardId, redemption.id, "CANCELED");
    return;
  }

  try {
    // Execute action closure with context
    const context = buildCommandContext();
    const result = actionClosure(context, userName, userInput);

    // Check if action explicitly returned false (indicates failure)
    const failed = result === false;

    // Update redemption status
    updateRedemptionStatus(
      rewardId,
      redemption.id,
      failed ? "CANCELED" : "FULFILLED",
    );

    // Update global state from modified context
    love_timer = context.love_timer;
    if (musicQueue) {
      musicQueue.needVoteSkip = context.needVoteSkip;
    }
  } catch (error) {
    log(`❌ Error executing action for "${rewardTitle}": ${error.message}`);
    console.error("Action execution error:", error);
    updateRedemptionStatus(rewardId, redemption.id, "CANCELED");
  }
}

// ============================
// INITIALIZATION
// ============================

(async () => {
  // Check for ?wipe parameter to clear all localStorage
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has("wipe")) {
    localStorage.clear();
    console.log("✅ localStorage wiped via ?wipe parameter");
    // Remove ?wipe from URL
    urlParams.delete("wipe");
    const newUrl =
      window.location.pathname +
      (urlParams.toString() ? "?" + urlParams.toString() : "");
    window.history.replaceState({}, "", newUrl);
  }

  // Cache DOM elements first
  cacheDOMElements();

  // Initialize stored elements system
  initializeStoredElements();

  // Setup page unload handler to flush music queue
  window.addEventListener("beforeunload", () => {
    if (musicQueue?.queue) {
      musicQueue.queue.flush();
    }
  });

  const existingToken = localStorage.getItem("twitch_token") || extractToken();
  if (!existingToken) {
    authenticate();
  } else {
    await startChat(existingToken);
  }

  // Initialize Music Queue (always enabled, not permission-dependent)
  musicQueue = new MusicQueue({
    emptyUrl: EMPTY_MUSIC_URL,
    voteSkipThreshold: VOTE_SKIP_THRESHOLD,
    log: log,
    onSongStart: (name) => {
      if (ws && CHANNEL) {
        ws.send(`PRIVMSG #${CHANNEL} :/me 📀 ${name}`);
      }
    },
  });

  // Start playing fallback URL
  musicQueue.skip();

  log("∞ initialized");

  initializePresets();

  DOM.presetSelector.addEventListener("change", function (e) {
    updatePresetInfo(e.target.value);
    const selectedPreset = DOM.presetSelector.value;
    if (selectedPreset) {
      applyStreamPreset(selectedPreset);
    }
  });

  // Rewards system event listeners
  // Removed manual buttons - rewards are now automatically initialized and displayed on connection
})();

// ============================
// GLOBAL EXPORTS FOR HTML
// ============================

// Export actions and utilities for HTML onclick handlers and console debugging
// Pattern: Expose action initializers and key functions to window object
// Actions are defensive - they check if context functions exist before calling
// This allows calling with minimal/empty context: voice()({}, "user", "message")
//
// Usage in HTML: onclick='voice()({}, "user", "message")'
// Usage in console: window.voice()({log: console.log}, "test", "Hello")

// Actions
window.voice = voice;

// Utilities
window.log = log;
window.mp3 = mp3;
window.speak = speak;

// Configuration management
window.clearClientId = () => {
  localStorage.removeItem("twitch_client_id");
  log("✅ Client ID cleared. Reload page to enter new one.");
};

window.clearToken = () => {
  localStorage.removeItem("twitch_token");
  log("✅ OAuth token cleared. Reload page to re-authenticate.");
};

window.clearAll = () => {
  localStorage.clear();
  log("✅ All localStorage cleared. Reload page.");
};

// TIP: You can also use ?wipe URL parameter to clear everything on page load
// Example: https://localhost:8443/?wipe

// State (read-only access for debugging)
window.getState = () => ({
  twitchConnected,
  currentUserId,
  CHANNEL,
  love_timer,
  throttle: { ...throttle },
  userIdCache: { ...userIdCache },
  customRewards: Object.keys(customRewards).length,
});

// Future exports should follow this pattern:
// window.actionName = actionName;
// window.utilityFunction = utilityFunction;
