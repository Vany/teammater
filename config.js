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

export const WEBSOCKET_URLS = {
  TWITCH_IRC: "wss://irc-ws.chat.twitch.tv:443",
  TWITCH_EVENTSUB: "wss://eventsub.wss.twitch.tv/ws",
  MINARET_SERVER: "ws://localhost:8765",
};

export const TWITCH_API_BASE = "https://api.twitch.tv/helix";

// ============================
// MUSIC CONFIGURATION
// ============================

export const MUSIC_URL_PATTERN =
  /^https:\/\/music\.yandex\.(ru|com)\/(album\/\d+\/)?track\/\d+/;
export const EMPTY_MUSIC_URL = "https://music.yandex.ru/";
export const INITIAL_SONG_NAME = "Silence by silencer";
export const VOTE_SKIP_THRESHOLD = 3;

// ============================
// AUDIO CONFIGURATION
// ============================

export const AUDIO_DIRECTORY = "mp3/";
export const VALID_SOUND_EFFECTS = ["boo", "creeper", "tentacle", "woop"];

export const SPEECH_SETTINGS = {
  LANGUAGE: "en-US",
  RATE: 1,
  PITCH: 1,
  VOLUME: 0.2, // Used in test function
};

// ============================
// MINECRAFT INTEGRATION CONFIGURATION
// ============================

export const MINECRAFT_PLAYER_NAME = "vany_serezhkin";

export const MINECRAFT_COMMANDS = {
  HEAL: "effect give vany_serezhkin minecraft:instant_health 3 255 true",
  LIGHTNING:
    "execute at vany_serezhkin run summon minecraft:lightning_bolt ~ ~ ~",
};

// ============================
// TIMING & THRESHOLDS CONFIGURATION
// ============================

export const TIMING = {
  HATE_COOLDOWN_MS: 60_000,
  HATE_INITIAL_OFFSET_MS: 61_000,
  LOVE_PROTECTION_DURATION_MS: 60_000,
  RECONNECT_DELAY_MS: 5000,
};

// ============================
// LLM CHAT MONITORING CONFIGURATION
// ============================

// Number of messages to keep in chat history buffer for LLM context
export const CHAT_HISTORY_SIZE = 50;

// ============================
// USER CONFIGURATION
// ============================

// Broadcaster username (exempt from hate command throttling)
export const BROADCASTER_USERNAME = "vanyserezhkin";

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
export const DEFAULT_PINNED_MESSAGE =
  "🐽🧱✨🌊 Сбооорочка !! https://www.feed-the-beast.com/modpacks/129-ftb-skies-2";

// ============================
// CHANNEL POINT REWARDS CONFIGURATION
// ============================

export const DEFAULT_REWARDS = {
  hate: {
    title: "⚡ Hate Vany",
    cost: 300,
    prompt: "Strike the streamer with lightning!",
    background_color: "#77AAFF",
    is_enabled: true,
    is_global_cooldown_enabled: true,
    global_cooldown_seconds: 30,
    action: hate(), // Initialize with default parameters
  },
  love: {
    title: "💚 Love Vany",
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
