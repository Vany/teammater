// ============================
// CONFIGURATION
// ============================

// Import configuration from config.js
import {
  CHAT_ACTIONS,
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
  CHAT_HISTORY_SIZE,
} from "./config.js";

// Import utilities from utils.js
import { request, PersistentDeck, parseIrcTags, parseIrcMessage } from "./utils.js";

// Import external connectors
import { MusicQueue, MinecraftConnector, LLMConnector } from "./connectors.js";

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
let llm = null;

// Chat history for LLM monitoring
let chatHistory = []; // Array of {timestamp: Date, username: string, message: string}
let chatMarkerPosition = 0; // Index in chatHistory where marker sits (everything after is "new")
let llmProcessing = false; // Flag indicating LLM is currently processing a batch

// DOM element cache (populated on initialization)
const DOM = {
  output: null,
  twitchStatus: null,
  minaretStatus: null,
  minaretCheckbox: null,
  llmStatus: null,
  llmCheckbox: null,
  llmConfigToggle: null,
  llmConfigPanel: null,
  llmModelSelect: null,
  llmSystemPromptInput: null,
  llmChatMonitoringCheckbox: null,
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
  DOM.minaretCheckbox = document.getElementById("minaretCheckbox");
  DOM.llmStatus = document.getElementById("llmStatus");
  DOM.llmCheckbox = document.getElementById("llmCheckbox");
  DOM.llmConfigToggle = document.getElementById("llmConfigToggle");
  DOM.llmConfigPanel = document.getElementById("llmConfigPanel");
  DOM.llmModelSelect = document.getElementById("llmModelSelect");
  DOM.llmSystemPromptInput = document.querySelector('[stored_as="llm_system_prompt"]');
  DOM.llmChatMonitoringCheckbox = document.getElementById("llmChatMonitoringCheckbox");
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
 * 
 * Note: Preset selector (#presetSelector) is excluded and handled manually after options are populated
 */
function initializeStoredElements() {
  const elements = document.querySelectorAll("[stored_as]");

  elements.forEach((el) => {
    const key = el.getAttribute("stored_as");
    
    // Skip preset selector - needs manual restoration after options are populated
    if (el.id === "presetSelector") {
      // Still set up change listener for future saves
      el.addEventListener("change", () => {
        localStorage.setItem(key, el.value);
        log(`💾 Stored ${key} = ${el.value}`);
      });
      return;
    }
    
    const storedValue = localStorage.getItem(key);

    // Restore from storage
    if (storedValue !== null) {
      if (el.type === "checkbox") {
        el.checked = storedValue === "true";
      } else if (
        el.tagName === "SELECT" ||
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA"
      ) {
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
// CHAT ACTIONS SYSTEM
// ============================

// Check if message matches chat action rules
// Returns {action, message} if a rule matches, null otherwise
// Extracts text from regex capture groups for commands like !voice <text>
function checkChatActions(message) {
  for (const rule of CHAT_ACTIONS) {
    if (rule.length < 2) continue; // Invalid rule

    const actionClosure = rule[0];
    const patterns = rule.slice(1);

    let extractedMessage = message; // Default to full message

    // Check if ALL patterns match (AND logic)
    const allMatch = patterns.every((pattern) => {
      const match = message.match(pattern);
      if (match) {
        // If pattern has capture groups, extract the first captured text
        if (match.length > 1 && match[1]) {
          extractedMessage = match[1].trim();
        }
        return true;
      }
      return false;
    });

    if (allMatch) {
      return { action: actionClosure, message: extractedMessage };
    }
  }
  return null; // No rules matched
}

// Execute chat action closure with full context
async function executeChatAction(
  actionClosure,
  userId,
  messageId,
  user,
  message,
) {
  if (!actionClosure || typeof actionClosure !== "function") {
    log("❌ Invalid chat action closure");
    return false;
  }

  // Build full context object for chat action (includes llm, ws, minecraft, etc.)
  const context = buildCommandContext();
  
  // Add moderation-specific fields
  context.userId = userId;
  context.messageId = messageId;

  try {
    await actionClosure(context, user, message);
    return true;
  } catch (error) {
    log(`❌ Chat action execution failed: ${error.message}`);
    console.error("Chat action error:", error);
    return false;
  }
}

// ============================
// LLM CHAT MONITORING SYSTEM
// ============================

/**
 * Add message to chat history buffer (keeps last CHAT_HISTORY_SIZE messages)
 * @param {string} username - Username who sent the message
 * @param {string} message - Message content
 */
function addToChatHistory(username, message) {
  chatHistory.push({
    timestamp: new Date(),
    username: username,
    message: message,
  });

  // Keep buffer at CHAT_HISTORY_SIZE, remove oldest if exceeded
  if (chatHistory.length > CHAT_HISTORY_SIZE) {
    const removed = chatHistory.shift();
    
    // Adjust marker position since we removed from the start
    if (chatMarkerPosition > 0) {
      chatMarkerPosition--;
    }
  }
}

/**
 * Format chat history for LLM with marker separating old/new messages
 * @returns {string} - Formatted chat history with timestamp and username
 */
function formatChatHistoryForLLM() {
  if (chatHistory.length === 0) {
    return "No messages yet.";
  }

  const lines = chatHistory.map((entry, index) => {
    const timestamp = entry.timestamp.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const line = `[${timestamp}] ${entry.username}: ${entry.message}`;
    
    // Add marker after messages that were already processed
    if (index === chatMarkerPosition - 1 && chatMarkerPosition < chatHistory.length) {
      return line + "\n -> new messages";
    }
    
    return line;
  });

  return lines.join("\n");
}

/**
 * Process accumulated chat messages with LLM (two-stage decision)
 * Stage 1: Ask if LLM wants to respond (yes/no)
 * Stage 2: If yes, ask what to respond with full context
 */
async function processChatWithLLM() {
  // Check if chat monitoring is enabled
  if (!DOM.llmChatMonitoringCheckbox?.checked) {
    return;
  }

  // Check if LLM is available and not already processing
  if (!llm || !llm.isConnected() || llmProcessing) {
    return;
  }

  // Check if there are new messages to process (messages after marker)
  const hasNewMessages = chatMarkerPosition < chatHistory.length;
  if (!hasNewMessages) {
    return;
  }

  // Mark as processing
  llmProcessing = true;
  log("🤖 LLM processing chat batch...");

  try {
    // Get system prompt from UI
    const systemPrompt = DOM.llmSystemPromptInput?.value || 
      "You are a helpful Twitch chat companion. Respond naturally and conversationally.";

    // Format chat history with marker
    const chatLog = formatChatHistoryForLLM();

    // STAGE 1: Ask if LLM wants to respond
    const shouldRespondMessages = [
      { role: "system", content: systemPrompt },
      { 
        role: "user", 
        content: `Here is the chat history:\n\n${chatLog}\n\nShould you respond to this chat? Answer ONLY "yes" or "no" (nothing else).`
      },
    ];

    log("🤖 Stage 1: Asking LLM if it should respond...");
    const shouldRespondAnswer = await llm.chat(shouldRespondMessages, {
      maxTokens: 10,
      temperature: 0.3, // Lower temperature for yes/no decision
    });

    const trimmedAnswer = shouldRespondAnswer.trim().toLowerCase();
    log(`🤖 Stage 1 answer: "${trimmedAnswer}"`);

    // Check if LLM wants to respond
    if (trimmedAnswer !== "yes") {
      log("🤖 LLM decided not to respond");
      // Move marker to end of buffer (mark all as processed)
      chatMarkerPosition = chatHistory.length;
      return;
    }

    // STAGE 2: Ask what to respond
    const responseMessages = [
      { role: "system", content: systemPrompt },
      { 
        role: "user", 
        content: `Here is the chat history:\n\n${chatLog}\n\nWhat should you say in response? Write ONLY your response text, without any timestamp, username, or prefix. Just the message itself.`
      },
    ];

    log("🤖 Stage 2: Asking LLM what to respond...");
    const responseText = await llm.chat(responseMessages, {
      maxTokens: 256,
      temperature: 0.7,
    });

    if (responseText && responseText.trim().length > 0) {
      // Strip any timestamp/username prefix that LLM might have added
      // Pattern: [HH:MM:SS] username: 
      const cleanResponse = responseText.trim().replace(/^\[\d{2}:\d{2}:\d{2}\]\s+\w+:\s*/, '');
      
      log(`🤖 LLM response: "${cleanResponse}"`);
      
      // Send response to Twitch chat (no prefix, like human)
      send_twitch(cleanResponse);
      
      // Add LLM's own response to chat history
      addToChatHistory(CHANNEL, cleanResponse);
    } else {
      log("🤖 LLM returned empty response");
    }

    // Move marker to end of buffer (mark all as processed)
    chatMarkerPosition = chatHistory.length;

  } catch (error) {
    log(`💥 LLM processing error: ${error.message}`);
    console.error("LLM processing error:", error);
  } finally {
    // Mark as not processing
    llmProcessing = false;
    log("🤖 LLM processing complete");
    
    // Check if more messages arrived during processing
    if (chatMarkerPosition < chatHistory.length) {
      log("🤖 New messages arrived, scheduling next batch...");
      // Schedule next processing after short delay
      setTimeout(() => processChatWithLLM(), 1000);
    }
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
    log(
      "📝 Please enter your Client ID in the input field at the bottom of the panel",
    );
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

function updateLLMStatus(connected) {
  if (connected) {
    DOM.llmStatus.classList.add("connected");
  } else {
    DOM.llmStatus.classList.remove("connected");
  }
}

/**
 * Initialize Minecraft connector if not already initialized
 * Called conditionally based on moderator permissions and checkbox state
 */
function initializeMinecraftConnector() {
  if (minecraft) {
    log("ℹ️ Minecraft connector already initialized");
    return;
  }

  // Check if checkbox is enabled
  if (!DOM.minaretCheckbox?.checked) {
    log("⚠️ Minaret connector disabled via checkbox");
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

/**
 * Initialize LLM connector if not already initialized
 * Respects checkbox state and reads configuration from stored_as fields
 */
function initializeLLMConnector() {
  // Skip if already initialized
  if (llm) {
    log("ℹ️ LLM connector already initialized");
    return;
  }

  // Check if checkbox is enabled
  if (!DOM.llmCheckbox?.checked) {
    log("⚠️ LLM connector disabled via checkbox");
    return;
  }

  // Read configuration from stored_as fields
  const baseUrl =
    localStorage.getItem("llm_base_url") || "http://localhost:11434";
  const model = localStorage.getItem("llm_model") || "llama3.2";
  const systemPrompt = localStorage.getItem("llm_system_prompt") || "";
  const temperature = parseFloat(
    localStorage.getItem("llm_temperature") || "0.7",
  );
  const maxTokens = parseInt(localStorage.getItem("llm_max_tokens") || "512");

  llm = new LLMConnector({
    baseUrl,
    model,
    temperature,
    maxTokens,
    timeout: 30000,
    healthCheckInterval: 30000,
    log: log,
    onStatusChange: updateLLMStatus,
  });

  // Store system prompt for later use (not passed to constructor)
  llm.systemPrompt = systemPrompt;

  llm.connect();
  log("🤖 LLM connector initialized");

  // Fetch and populate model list after connection
  setTimeout(() => populateLLMModels(), 1000);
}

/**
 * Fetch available models from Ollama and populate the model select
 * Called after LLM connection is established
 */
async function populateLLMModels() {
  if (!llm || !llm.isConnected()) {
    log("⚠️ Cannot fetch models: LLM not connected");
    return;
  }

  try {
    log("🔍 Fetching available models from Ollama...");
    const models = await llm.listModels();

    if (!models || models.length === 0) {
      log("⚠️ No models found on Ollama server");
      DOM.llmModelSelect.innerHTML =
        '<option value="">No models available</option>';
      return;
    }

    // Get currently selected model from localStorage
    const currentModel = localStorage.getItem("llm_model") || "llama3.2";

    // Clear and populate select with models
    DOM.llmModelSelect.innerHTML = "";

    let hasCurrentModel = false;
    models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.name;
      option.textContent = model.name;

      if (model.name === currentModel) {
        option.selected = true;
        hasCurrentModel = true;
      }

      DOM.llmModelSelect.appendChild(option);
    });

    // If current model not in list, add it as first option (fallback)
    if (!hasCurrentModel && currentModel) {
      const option = document.createElement("option");
      option.value = currentModel;
      option.textContent = `${currentModel} (not found)`;
      option.selected = true;
      DOM.llmModelSelect.insertBefore(option, DOM.llmModelSelect.firstChild);
    }

    log(
      `✅ Loaded ${models.length} models: ${models.map((m) => m.name).join(", ")}`,
    );
  } catch (error) {
    log(`💥 Failed to fetch models: ${error.message}`);
    DOM.llmModelSelect.innerHTML =
      '<option value="">Error loading models</option>';
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
      initializeLLMConnector(); // LLM doesn't need moderator permissions
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
      // Initialize LLM even without moderator rights (doesn't require permissions)
      initializeLLMConnector();
    }

    // Apply saved preset now that all connectors are initialized
    const savedPreset = DOM.presetSelector.value;
    if (savedPreset) {
      log(`🎯 Applying saved preset: ${savedPreset}`);
      applyStreamPreset(savedPreset);
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

    // Parse PRIVMSG with proper tag handling
    console.log("🔍 parseIrcMessage function exists:", typeof parseIrcMessage);
    console.log("🔍 Raw event.data length:", event.data.length);
    console.log("🔍 Raw event.data (first 200 chars):", event.data.substring(0, 200));
    console.log("🔍 Raw event.data (last 20 chars):", JSON.stringify(event.data.substring(event.data.length - 20)));
    
    const parsed = parseIrcMessage(event.data);
    console.log("🔍 parseIrcMessage output:", parsed);
    
    if (parsed) {
      const user = parsed.username;
      const msg = parsed.message;
      
      console.log("📨 Parsed message:", { user, msg });

      // Add message to chat history for LLM monitoring
      addToChatHistory(user, msg);
      
      // Trigger LLM processing if enabled, connected, and not already busy
      if (DOM.llmChatMonitoringCheckbox?.checked && !llmProcessing && llm?.isConnected()) {
        processChatWithLLM().catch(error => {
          log(`💥 LLM processing trigger failed: ${error.message}`);
        });
      }

      // Parse IRC tags for moderation data
      const tags = parseIrcTags(event.data);
      const userId = tags?.["user-id"];
      const messageId = tags?.id;

      // Check chat action rules (moderation + interactive actions)
      if (userId && CHAT_ACTIONS.length > 0) {
        const result = checkChatActions(msg);
        if (result) {
          log(`⚡ CHAT ACTION MATCHED! Executing action...`);
          await executeChatAction(result.action, userId, messageId, user, result.message);
          return; // Stop processing this message
        }
      }

      // Normal message processing - forward all to Minecraft
      if (msg.startsWith("!")) {
        console.log("🎮 Routing command to Minecraft:", msg, "connector:", minecraft ? "exists" : "null");
        minecraft?.sendMessage(user, log(msg));
      } else {
        if (DOM.loudCheckbox?.checked) {
          mp3("icq");
        }
        console.log("🎮 Routing message to Minecraft:", msg, "connector:", minecraft ? "exists" : "null");
        minecraft?.sendMessage(user, log(msg));
      }
    } else {
      console.log("⚠️ Failed to parse IRC message:", event.data);
      log(event.data); // do not understand the source
    }
  };
}

/// MAIN ///
// Build context for reward redemption actions
function buildCommandContext() {
  // Debug: check global llm state
  console.log("🔍 buildCommandContext - global llm:", llm ? "exists" : "null");
  if (llm) {
    console.log("🔍 buildCommandContext - llm.connected:", llm.connected);
    console.log("🔍 buildCommandContext - llm.isConnected():", llm.isConnected());
  }

  return {
    // WebSocket connections
    ws,
    minarert: minecraft?.getWebSocket() || null,

    // External connectors
    llm,

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

async function handleRewardRedemption(redemption) {
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
    // Execute action closure with context (await if async)
    const context = buildCommandContext();
    const result = await actionClosure(context, userName, userInput);

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

  // Restore saved preset UI state on page load
  // Actual application happens when Twitch connects (ws.onopen)
  // Must happen AFTER initializePresets() so options exist
  const savedPreset = localStorage.getItem("stream_preset");
  if (savedPreset) {
    log(`🔄 Restoring saved preset UI: ${savedPreset}`);
    DOM.presetSelector.value = savedPreset;
    updatePresetInfo(savedPreset);
  }

  // Minaret connector checkbox event listener
  DOM.minaretCheckbox?.addEventListener("change", function (e) {
    if (e.target.checked) {
      log("✅ Minaret connector enabled");
      initializeMinecraftConnector();
    } else {
      log("⚠️ Minaret connector disabled");
      if (minecraft) {
        minecraft.disconnect();
        minecraft = null;
        log("🔌 Minaret connector disconnected");
      }
    }
  });

  // LLM connector checkbox event listener
  DOM.llmCheckbox?.addEventListener("change", function (e) {
    if (e.target.checked) {
      log("✅ LLM connector enabled");
      initializeLLMConnector();
    } else {
      log("⚠️ LLM connector disabled");
      if (llm) {
        llm.disconnect();
        llm = null;
        log("🔌 LLM connector disconnected");
      }
    }
  });

  // LLM chat monitoring checkbox event listener
  DOM.llmChatMonitoringCheckbox?.addEventListener("change", function (e) {
    if (e.target.checked) {
      log("✅ LLM chat monitoring enabled");
      // Immediately process any accumulated messages
      if (llm && llm.isConnected() && chatMarkerPosition < chatHistory.length) {
        log("🤖 Processing accumulated messages...");
        processChatWithLLM().catch(error => {
          log(`💥 LLM processing failed: ${error.message}`);
        });
      }
    } else {
      log("⚠️ LLM chat monitoring disabled");
    }
  });

  // LLM configuration panel toggle
  DOM.llmConfigToggle?.addEventListener("click", function () {
    const wasExpanded = DOM.llmConfigPanel.classList.contains("expanded");
    DOM.llmConfigPanel.classList.toggle("expanded");

    // Fetch models when opening panel (if not already expanded and LLM is connected)
    if (!wasExpanded && llm && llm.isConnected()) {
      populateLLMModels();
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
  llmExists: llm !== null,
  llmConnected: llm?.isConnected() || false,
  minaretConnected: minecraft?.isConnected() || false,
});

// Direct access to connectors for debugging
window.getLLM = () => llm;
window.getMinecraft = () => minecraft;
window.getMusicQueue = () => musicQueue;

// Future exports should follow this pattern:
// window.actionName = actionName;
// window.utilityFunction = utilityFunction;
