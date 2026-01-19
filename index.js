/**
 * Teammater - Modular Architecture Version
 *
 * Main application using the new module system.
 * This replaces the monolithic index.js with a clean modular approach.
 */

import { ModuleManager } from "./core/module-manager.js";
import { ActionRegistry } from "./core/action-registry.js";
import { ContextBuilder } from "./core/context-builder.js";

// Import modules
import { LLMModule } from "./modules/llm/module.js";
import { MusicQueueModule } from "./modules/music-queue/module.js";
import { MinecraftModule } from "./modules/minecraft/module.js";
import { TwitchChatModule } from "./modules/twitch-chat/module.js";
import { TwitchEventSubModule } from "./modules/twitch-eventsub/module.js";
import { TwitchStreamModule } from "./modules/twitch-stream/module.js";
import { OBSModule } from "./modules/obs/module.js";

// Import configuration
import {
  CHAT_ACTIONS,
  DEFAULT_PRESETS,
  getDefaultRewards,
  TWITCH_CLIENT_ID_KEY,
  TWITCH_SCOPES,
} from "./config.js";

// Import actions for test button
import { voice } from "./actions.js";

// ============================
// GLOBAL STATE
// ============================

// Mark this tab as master for UserScript
window.i_am_a_master = true;

let moduleManager = null;
let actionRegistry = null;
let contextBuilder = null;

let currentUserId = null;
let CHANNEL = null;
let throttle = {};
let love_timer = Date.now();
let customRewards = {};
let llmProcessing = false;

// DOM cache
const DOM = {};

// ============================
// INITIALIZATION
// ============================

async function initialize() {
  // Cache DOM elements
  cacheDOMElements();

  // Initialize stored elements
  initializeStoredElements();

  // Create module manager
  moduleManager = new ModuleManager();
  moduleManager.setLogger(log);

  // Create action registry
  actionRegistry = new ActionRegistry();
  actionRegistry.setLogger(log);

  // Create context builder
  contextBuilder = new ContextBuilder(moduleManager);

  // Register modules
  registerModules();

  // Initialize modules (render UI)
  const container = document.getElementById("modules-container");
  await moduleManager.initializeAll(container);

  // Setup authentication
  await setupAuthentication();

  // Setup UI event listeners
  setupUIListeners();

  log("∞ Teammater initialized (modular)");
}

/**
 * Cache all DOM element references
 */
function cacheDOMElements() {
  DOM.output = document.getElementById("output");
  DOM.audio = document.getElementById("myAudio");
  DOM.loudCheckbox = document.getElementById("loudCheckbox");
}

/**
 * Initialize stored elements system
 */
function initializeStoredElements() {
  const elements = document.querySelectorAll("[stored_as]");

  elements.forEach((el) => {
    const key = el.getAttribute("stored_as");
    const defaultValue = el.getAttribute("stored_default");

    let storedValue = localStorage.getItem(key);

    // If no stored value and default is provided, write default
    if (storedValue === null && defaultValue !== null) {
      storedValue = defaultValue;
      localStorage.setItem(key, defaultValue);
      log(`💾 Initialized ${key} = ${defaultValue} (default)`);
    }

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

    // Setup auto-save on change
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

/**
 * Register all modules
 */
function registerModules() {
  // External connectors
  moduleManager.register("llm", new LLMModule());
  moduleManager.register("music-queue", new MusicQueueModule());
  moduleManager.register("minecraft", new MinecraftModule());
  moduleManager.register("obs", new OBSModule());

  // Twitch integration
  moduleManager.register("twitch-chat", new TwitchChatModule());
  moduleManager.register("twitch-eventsub", new TwitchEventSubModule());
  moduleManager.register("twitch-stream", new TwitchStreamModule());

  log("📦 Registered 7 modules");
}

// ============================
// AUTHENTICATION
// ============================

async function setupAuthentication() {
  const CLIENT_ID = localStorage.getItem(TWITCH_CLIENT_ID_KEY) || "";

  if (!CLIENT_ID) {
    log("❌ Twitch Client ID is not set!");
    log("📝 Please enter your Client ID in the input field");
    return;
  }

  // Extract token from URL or localStorage
  const existingToken = localStorage.getItem("twitch_token") || extractToken();

  if (!existingToken) {
    authenticate(CLIENT_ID);
    return;
  }

  // Fetch user info
  const username = await fetchUsername(existingToken);
  if (!username) {
    log("❌ Authentication failed");
    authenticate(CLIENT_ID);
    return;
  }

  // Set channel (URL param or own channel)
  const urlParams = new URLSearchParams(window.location.search);
  CHANNEL = urlParams.get("channel") || username;

  log(`🎯 Authenticated as: ${username}`);
  log(`📺 Target channel: #${CHANNEL}`);

  // Setup context builder with helpers
  setupContextBuilder();

  // Connect modules
  await connectModules(existingToken, username);

  // Setup action registry
  setupActions();
}

function extractToken() {
  const hash = window.location.hash;
  if (hash.includes("access_token")) {
    const params = new URLSearchParams(hash.substr(1));
    const token = params.get("access_token");
    if (token) {
      localStorage.setItem("twitch_token", token);
      window.location.hash = "";
      return token;
    }
  }
  return null;
}

function authenticate(CLIENT_ID) {
  const REDIRECT_URI = window.location.origin;
  const authURL = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=${TWITCH_SCOPES.join("+")}`;
  window.location.href = authURL;
}

async function fetchUsername(token) {
  try {
    const response = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": localStorage.getItem(TWITCH_CLIENT_ID_KEY),
      },
    });

    const data = await response.json();
    const user = data.data[0];
    currentUserId = user.id;
    return user.login;
  } catch (error) {
    log(`❌ Failed to fetch user: ${error.message}`);
    return null;
  }
}

// ============================
// MODULE CONNECTION
// ============================

async function connectModules(token, username) {
  // Connect Music Queue (always enabled)
  const musicModule = moduleManager.get("music-queue");
  if (musicModule) {
    await musicModule.connect().catch((err) => {
      log(`⚠️ Music Queue connection failed: ${err.message}`);
    });

    // Setup song start callback
    musicModule.setOnSongStart((name) => {
      const chatModule = moduleManager.get("twitch-chat");
      if (chatModule?.isConnected()) {
        chatModule.sendAction(`📀 ${name}`);
      }
    });
  }

  // Connect LLM (if enabled)
  const llmModule = moduleManager.get("llm");
  if (llmModule?.isEnabled()) {
    await llmModule.connect().catch((err) => {
      log(`⚠️ LLM connection failed: ${err.message}`);
    });
  }

  // Connect Minecraft (if enabled)
  const minecraftModule = moduleManager.get("minecraft");
  if (minecraftModule?.isEnabled()) {
    await minecraftModule.connect().catch((err) => {
      log(`⚠️ Minecraft connection failed: ${err.message}`);
    });
  }

  // Connect Twitch Chat
  const chatModule = moduleManager.get("twitch-chat");
  if (chatModule) {
    await chatModule.setAuth(token, username, CHANNEL).catch((err) => {
      log(`⚠️ Twitch Chat connection failed: ${err.message}`);
    });

    // Register message handler for chat actions
    chatModule.registerMessageHandler(handleChatMessage);
  }

  // Connect Twitch EventSub (if moderator or own channel)
  const eventSubModule = moduleManager.get("twitch-eventsub");
  if (eventSubModule) {
    await eventSubModule.setUserId(currentUserId).catch((err) => {
      log(`⚠️ Twitch EventSub connection failed: ${err.message}`);
    });

    // Register redemption handler
    eventSubModule.registerRedemptionHandler(handleRedemption);
  }

  // Connect Twitch Stream
  const streamModule = moduleManager.get("twitch-stream");
  if (streamModule) {
    await streamModule.setUserId(currentUserId).catch((err) => {
      log(`⚠️ Twitch Stream connection failed: ${err.message}`);
    });
    streamModule.setPresets(DEFAULT_PRESETS);
  }

  // Initialize rewards
  await initializeRewards().catch((err) => {
    log(`⚠️ Rewards initialization failed: ${err.message}`);
  });

  log("✅ All modules connected");
}

// ============================
// CONTEXT BUILDER SETUP
// ============================

function setupContextBuilder() {
  // Set global state
  contextBuilder.setGlobalState({
    currentUserId,
    CHANNEL,
    throttle,
    love_timer,
  });

  // Set helper functions
  contextBuilder.setHelpers({
    log,
    mp3,
    speak,
    request: async (url, options = {}) => {
      const token = localStorage.getItem("twitch_token");
      const CLIENT_ID = localStorage.getItem(TWITCH_CLIENT_ID_KEY);

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
        throw new Error(
          `API request failed: ${response.status} - ${errorText}`,
        );
      }

      return response;
    },
  });
}

// ============================
// ACTION SYSTEM SETUP
// ============================

function setupActions() {
  // Set chat actions from config
  actionRegistry.setChatActions(CHAT_ACTIONS);

  // Reward actions will be set when rewards are created
  log("✅ Action registry configured");
}

// ============================
// MESSAGE HANDLING
// ============================

async function handleChatMessage(messageData) {
  const { username, message, userId, messageId } = messageData;

  // Display message in UI
  log(`💬 ${username}: ${message}`);

  // Play sound if loud mode is enabled
  if (DOM.loudCheckbox?.checked) {
    mp3("icq");
  }

  // Forward to Minecraft if connected
  const minecraftModule = moduleManager.get("minecraft");
  if (minecraftModule?.isConnected()) {
    minecraftModule.sendMessage(username, message);
  }

  // Check chat actions
  if (userId) {
    const context = contextBuilder.build();
    const matched = await actionRegistry.executeChatAction(
      message,
      messageData,
      context,
    );

    if (matched) {
      log(`⚡ Chat action executed for: ${message}`);

      // Sync state changes back
      contextBuilder.syncStateFromContext(context);
      return; // Don't process further
    }
  }

  // LLM monitoring (if enabled)
  await processLLMMonitoring();
}

async function processLLMMonitoring() {
  const llmModule = moduleManager.get("llm");
  const chatModule = moduleManager.get("twitch-chat");

  if (!llmModule?.isConnected() || !chatModule?.isConnected()) {
    return;
  }

  const chatMonitoring = localStorage.getItem("llm_chat_monitoring") === "true";
  if (!chatMonitoring || llmProcessing) {
    return;
  }

  const chatHistory = chatModule.getChatHistory();
  const chatMarkerPosition = chatModule.getChatMarkerPosition();

  // Check if there are new messages
  if (chatMarkerPosition >= chatHistory.length) {
    return;
  }

  llmProcessing = true;
  log("🤖 LLM processing chat batch...");

  try {
    const systemPrompt = localStorage.getItem("llm_system_prompt") || "";
    const chatLog = chatModule.formatChatHistoryForLLM();

    // Stage 1: Should respond?
    const shouldRespondMessages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Here is the chat history:\n\n${chatLog}\n\nShould you respond to this chat? Answer ONLY "yes" or "no" (nothing else).`,
      },
    ];

    const shouldRespondAnswer = await llmModule.chat(shouldRespondMessages, {
      maxTokens: 10,
      temperature: 0.3,
    });

    if (shouldRespondAnswer.trim().toLowerCase() !== "yes") {
      log("🤖 LLM decided not to respond");
      chatModule.setChatMarkerPosition(chatHistory.length);
      return;
    }

    // Stage 2: What to respond?
    const responseMessages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Here is the chat history:\n\n${chatLog}\n\nWhat should you say in response? Write ONLY your response text, without any timestamp, username, or prefix. Just the message itself.`,
      },
    ];

    const responseText = await llmModule.chat(responseMessages, {
      maxTokens: 256,
      temperature: 0.7,
    });

    if (responseText?.trim()) {
      const cleanResponse = responseText
        .trim()
        .replace(/^\[\d{2}:\d{2}:\d{2}\]\s+\w+:\s*/, "");
      log(`🤖 LLM response: "${cleanResponse}"`);
      chatModule.send(cleanResponse);
    }

    chatModule.setChatMarkerPosition(chatHistory.length);
  } catch (error) {
    log(`💥 LLM processing error: ${error.message}`);
  } finally {
    llmProcessing = false;
  }
}

// ============================
// REWARD HANDLING
// ============================

async function initializeRewards() {
  const eventSubModule = moduleManager.get("twitch-eventsub");
  if (!eventSubModule?.isConnected()) {
    return;
  }

  log("🎯 Initializing Channel Point Rewards...");

  // Get existing rewards
  const existingRewards = await getCustomRewards();

  // Get reward configs with current nickname
  const rewards = getDefaultRewards();

  // Create missing rewards
  for (const [key, config] of Object.entries(rewards)) {
    const exists = existingRewards.find((r) => r.title === config.title);
    if (!exists) {
      log(`➕ Creating missing reward: ${config.title}`);
      await createCustomReward(key, config);
    } else {
      customRewards[exists.id] = { ...exists, action: config.action, key: key };
      log(`✅ Found existing reward: ${exists.title}`);
    }
  }

  // Register reward actions in action registry
  actionRegistry.setRewardActions(customRewards);

  // Update EventSub module with rewards
  eventSubModule.setCustomRewards(customRewards);

  log("🎯 Rewards initialization complete!");
}

async function getCustomRewards() {
  if (!currentUserId) return [];

  try {
    const response = await contextBuilder.helpers.request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${currentUserId}`,
    );
    const data = await response.json();
    return data.data;
  } catch (error) {
    log(`❌ Error getting rewards: ${error.message}`);
    return [];
  }
}

async function createCustomReward(rewardKey, rewardConfig) {
  if (!currentUserId) return null;

  const actionClosure = rewardConfig.action;
  const { action, ...apiConfig } = rewardConfig;

  try {
    const response = await contextBuilder.helpers.request(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${currentUserId}`,
      {
        method: "POST",
        body: JSON.stringify(apiConfig),
      },
    );

    const data = await response.json();
    const reward = data.data[0];
    customRewards[reward.id] = {
      ...reward,
      action: actionClosure,
      key: rewardKey,
    };
    log(`✅ Created reward: "${reward.title}" (ID: ${reward.id})`);
    return reward;
  } catch (error) {
    log(`❌ Error creating reward: ${error.message}`);
    return null;
  }
}

async function handleRedemption(redemption) {
  const rewardId = redemption.reward.id;
  const userName = redemption.user_name;
  const userInput = redemption.user_input || "";

  log(`🎯 Redemption: ${redemption.reward.title} by ${userName}`);

  // Build context
  const context = contextBuilder.build();

  // Execute action
  const success = await actionRegistry.executeRewardAction(
    rewardId,
    userName,
    userInput,
    context,
  );

  // Sync state changes
  contextBuilder.syncStateFromContext(context);

  // Update redemption status
  const eventSubModule = moduleManager.get("twitch-eventsub");
  if (eventSubModule) {
    await eventSubModule.updateRedemptionStatus(
      rewardId,
      redemption.id,
      success ? "FULFILLED" : "CANCELED",
    );
  }
}

// ============================
// UI LISTENERS
// ============================

function setupUIListeners() {
  // Expose voice action to window for HTML onclick
  window.voice = voice;
  window.mp3 = mp3;

  // Page unload handler (flush music queue)
  window.addEventListener("beforeunload", () => {
    const musicModule = moduleManager.get("music-queue");
    if (musicModule?.queue) {
      musicModule.queue.flush();
    }
  });
}

// ============================
// UTILITY FUNCTIONS
// ============================

function log(msg) {
  const div = document.createElement("div");
  div.textContent = msg;
  DOM.output.appendChild(div);
  DOM.output.scrollTop = DOM.output.scrollHeight;
  console.log(msg);
}

function mp3(name) {
  DOM.audio.src = `mp3/${name}.mp3`;
  DOM.audio.play().catch((err) => {
    speak("ACHTUNG");
    console.error("Playback failed:", err);
  });
}

function speak(str) {
  const x = new SpeechSynthesisUtterance(str);
  x.language = "en-US";
  x.rate = 1;
  x.pitch = 1;
  x.voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
  speechSynthesis.speak(x);
}

// ============================
// START APPLICATION
// ============================

// Check for ?wipe parameter
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has("wipe")) {
  localStorage.clear();
  console.log("✅ localStorage wiped");
  urlParams.delete("wipe");
  const newUrl =
    window.location.pathname +
    (urlParams.toString() ? "?" + urlParams.toString() : "");
  window.history.replaceState({}, "", newUrl);
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}
