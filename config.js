// ============================
// CHAT ACTIONS CONFIGURATION
// ============================

// Import all action functions (used in both CHAT_ACTIONS and DEFAULT_REWARDS)
import {
  mute,
  ban,
  delete_message,
  delete_,
  hate,
  love,
  music,
  voice,
  vote_skip,
  playing,
  neuro,
} from "./actions.js";

// Chat Actions Configuration
// React to messages in chat with automated actions
// Rules are arrays where:
// - First element is action closure: mute(seconds), ban(), delete(), voice(), neuro(), etc.
// - Following elements are regexes that ALL must match (AND logic)
// - Rules are combined with OR logic (any rule triggers action)
export const CHAT_ACTIONS = [
  [ban(), /viewers/i, /nezhna.+\.com/i], // Ban spam with "viewers" + nezhna*.com
  [mute(30), /zhopa/i, /spam/i], // Timeout for profanity spam
  [voice(), /^!voice\s+(.+)/i], // TTS command: !voice <text>
];

export const LLM_ACTIONS = {
  "mute → apply moderation mute for 10 minute": mute(10),
  "say → say outloud to attract attention of the owner": voice(),
};

// Get nickname from localStorage (default set via stored_default in HTML)
export function getNickName() {
  return localStorage.getItem("nick_name");
}

// Get Twitch username from localStorage (default set via stored_default in HTML)
export function getTwitchUsername() {
  return localStorage.getItem("twitch_username");
}

// Get Minecraft username from localStorage (default set via stored_default in HTML)
export function getMinecraftUsername() {
  return localStorage.getItem("minecraft_username");
}

// ============================
// API & NETWORK CONFIGURATION
// ============================

export const TWITCH_CLIENT_ID_KEY = "twitch_client_id";

export const TWITCH_SCOPES = [
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

// Default WebSocket URLs (can be overridden via localStorage)
// WebSocket URLs removed - modules read directly from localStorage via their config schemas

export const TWITCH_API_BASE = "https://api.twitch.tv/helix";

// ============================
// MUSIC CONFIGURATION
// ============================

// Music configuration removed - now handled by music-queue module config schema

// ============================
// AUDIO CONFIGURATION
// ============================

// Audio configuration removed - sound effects and TTS handled by actions.js

// ============================
// MINECRAFT INTEGRATION CONFIGURATION
// ============================

// Generate Minecraft commands based on current username from localStorage
export function getMinecraftCommands() {
  const username = getMinecraftUsername();
  return {
    HEAL: `effect give ${username} minecraft:instant_health 3 255 true`,
    LIGHTNING: `execute at ${username} run summon minecraft:lightning_bolt ~ ~ ~`,
  };
}

// ============================
// TIMING & THRESHOLDS CONFIGURATION
// ============================

export const TIMING = {
  HATE_COOLDOWN_MS: 60_000,
  HATE_INITIAL_OFFSET_MS: 61_000,
  LOVE_PROTECTION_DURATION_MS: 60_000,
  // RECONNECT_DELAY_MS and MINARET_RECONNECT_DELAY_MS removed - handled by module configs
};

// ============================
// LLM CHAT MONITORING CONFIGURATION
// ============================

// Chat history size removed - handled by twitch-chat module config schema

// ============================
// USER CONFIGURATION
// ============================

// Broadcaster username (exempt from hate command throttling)
export function getBroadcasterUsername() {
  return getTwitchUsername();
}

// ============================
// STREAM PRESETS CONFIGURATION
// ============================

export const DEFAULT_PRESETS = {
  loitering: {
    title: "подготовка к стриму. 🐽 ✨ ТУПИМ! 🧱 ",
    game_id: "509658",
    tags: ["Russian", "English", "Educational", "Clowns"],
    pinned_message:
      "🐽🧱✨🌊 Сбооорочка !! https://www.feed-the-beast.com/modpacks/129-ftb-skies-2",
    rewards_active: ["voice", "music", "vote_skip", "playing", "neuro"],
  },
  coding: {
    title:
      "🐽✨Программирование и отвага, всякая нейрофигня (russian vibecoding)",
    game_id: "1469308723",
    tags: ["English", "Programming", "Coding", "Educational"],
    pinned_message: "🐽🧱✨🌊 DO NOT FORGET TO CHAT WITH STREAMER! 🌊✨🧱🐽",
    rewards_active: ["voice", "music", "vote_skip", "playing", "neuro"],
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
  social: {
    title: "🐽🧱✨🌊 Трепимся со зррителями, 🌼⭐️😊 клеим новогоднюю ёлочку 🎄",
    game_id: "27471", // МАЙНКРАПХТ
    tags: ["English", "Gaming", "Chill"],
    pinned_message: "🐽🧱✨🌊 Сбооорочка в дискордике",
    rewards_active: ["voice", "music", "vote_skip", "playing"],
  },
  dooming: {
    title: "B O O M",
    game_id: "584", // МАЙНКРАПХТ
    tags: ["English", "Gaming", "Chill"],
    pinned_message:
      "RELAX AND ENJOY THE STREAM. Do not forget to talk with streamer",
    rewards_active: [], // All rewards paused
  },
  talking: {
    title: "🐽✨ Подкаст с чатом, болтаем о том о сём",
    game_id: "417752", // Talk Shows & Podcasts
    tags: ["Russian", "English", "Chill", "Chatting"],
    pinned_message: "🎙️ Подкаст! Пишите в чат, обсудим всё на свете",
    rewards_active: [], // Standard Twitch only, no custom rewards
  },
};

// Default pinned message when no preset is active
export const DEFAULT_PINNED_MESSAGE =
  "🐽🧱✨🌊 Сбооорочка !! https://www.feed-the-beast.com/modpacks/129-ftb-skies-2";

// ============================
// CHANNEL POINT REWARDS CONFIGURATION
// ============================

// Generate rewards with current nickname
export function getDefaultRewards() {
  const nickName = getNickName();
  return {
    hate: {
      title: `⚡ Hate ${nickName}`,
      cost: 300,
      prompt: "Strike the streamer with lightning!",
      background_color: "#77AAFF",
      is_enabled: true,
      is_global_cooldown_enabled: true,
      global_cooldown_seconds: 30,
      action: hate(), // Initialize with default parameters
    },
    love: {
      title: `💚 Love ${nickName}`,
      cost: 200,
      prompt: "Save the streamer from hate for a minute!",
      background_color: "#BBFF77",
      is_enabled: true,
      action: love(), // Initialize with default parameters
    },
    music: {
      title: "🎵 Music Request",
      cost: 150,
      prompt: "Request a music (Yandex Music URL)",
      background_color: "#FF6B6B",
      is_enabled: true,
      is_user_input_required: true,
      action: music(), // Initialize with default URL pattern and error message
    },
    vote_skip: {
      title: "🎵 Skip song",
      cost: 30,
      prompt: "Vote for skip current song",
      background_color: "#FF3B3B",
      is_enabled: true,
      action: vote_skip(3), // Initialize with vote threshold
    },
    playing: {
      title: "What is playing?",
      cost: 30,
      prompt: "Vote for skip current song",
      background_color: "#222255",
      is_enabled: true,
      action: playing(), // Initialize with default message format
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
      action: voice({
        type: "default",
        language: "en-US",
        rate: 1.0,
        pitch: 1.0,
      }),
    },
    neuro: {
      title: "🧠 Ask Neuro",
      cost: 100,
      prompt: "Ask a question and get AI-powered response",
      background_color: "#9B59B6",
      is_enabled: true,
      is_user_input_required: true,
      is_global_cooldown_enabled: true,
      global_cooldown_seconds: 45,
      action: neuro({
        maxTokens: 256,
        temperature: 0.7,
      }),
    },
  };
}

// DEFAULT_REWARDS removed - use getDefaultRewards() function instead
