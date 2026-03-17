// ============================
// ACTION SYSTEM
// ============================
// All action factories are initializers that take configuration parameters
// and return closures with signature: (context, user, message) => result
// Actions can be synchronous or asynchronous (return Promise)
//
// Pattern:
//   export function actionName(configParam1, configParam2, ...) {
//     return (context, user, message) => {
//       // use configParam1, configParam2 to configure behavior
//       // access context for dependencies
//       // return result (false for failure, void/true for success)
//     };
//   }
//
// context contains:
//   - Module references: llm, minecraft, musicQueue, twitchChat, obs, echowire, eventSub, twitchStream
//   - Legacy helpers: ws, CHANNEL, send_twitch, sendAction, sendMessageMinaret, sendCommandMinaret, currentSong
//   - Global state: currentUserId, throttle, love_timer
//   - Utilities: log, mp3, speak, request
//
// user: username string
// message: message/input string

import {
  getMinecraftCommands,
  getMinecraftUsername,
  TIMING,
  getBroadcasterUsername,
} from "./config.js";

import { detectLanguage } from "./utils.js";

// ============================
// MINECRAFT ACTIONS
// ============================

/**
 * Hate action initializer: creates configured hate action
 * @param {string} damageCommand - Minecraft command for damage/heal
 * @param {string} lightningCommand - Minecraft command for lightning strike
 * @param {string} warningMessage - Message to display when love protection is active
 * @param {string} soundEffect - Sound effect to play when protected
 * @param {number} cooldownMs - Cooldown duration in milliseconds
 * @returns {Function} - closure(context, user, message) => void
 */
export function hate(
  damageCommand = null,
  lightningCommand = null,
  warningMessage = "§c Beware !!! They are hating you!!",
  soundEffect = "ahhh",
  cooldownMs = TIMING.HATE_COOLDOWN_MS,
) {
  // @MCP-FUNCTIONS-PARAMS {"user": "author, must be your username", "message": "Message that will be shown to the minecraft player"}
  return (context, user, message) => {
    const {
      sendCommandMinaret,
      sendMessageMinaret,
      throttle,
      love_timer,
      mp3,
      log,
    } = context;

    // Get commands dynamically from localStorage
    const commands = getMinecraftCommands();
    const actualDamageCommand = damageCommand || commands.HEAL;
    const actualLightningCommand = lightningCommand || commands.LIGHTNING;

    // Initialize throttle for user if not exists
    if (throttle[user] === undefined) {
      throttle[user] = Date.now() - TIMING.HATE_INITIAL_OFFSET_MS;
    }

    const timeSinceLastCommand = Date.now() - throttle[user];

    // Check throttle (except for broadcaster)
    if (
      timeSinceLastCommand < cooldownMs &&
      user !== getBroadcasterUsername()
    ) {
      log(
        `⏱️ Throttled: ${user} must wait ${Math.ceil((cooldownMs - timeSinceLastCommand) / 1000)}s`,
      );
      return;
    }

    // Update throttle timestamp
    throttle[user] = Date.now();

    // Check love protection: heal if protected, strike if not
    if (Date.now() - love_timer < TIMING.LOVE_PROTECTION_DURATION_MS) {
      // Protected: heal instead of damage
      sendCommandMinaret(actualDamageCommand);
      sendMessageMinaret(warningMessage);
      mp3(soundEffect);
    } else {
      // Not protected: strike with lightning and start protection cooldown
      setTimeout(() => sendCommandMinaret(actualLightningCommand), 1000);
      context.love_timer = Date.now();
    }
  };
}

/**
 * Love action initializer: creates configured love action
 * @param {string} minecraftMessage - Message to send to Minecraft server
 * @param {string} chatAction - Action message to send to chat
 * @returns {Function} - closure(context, user, message) => void
 */
export function love(
  minecraftMessage = "§a Dance Dance Dance! They love you!!!",
  chatAction = "dances with joy! 💃✨",
) {
  return (context, user, message) => {
    const { sendMessageMinaret, sendAction } = context;

    sendMessageMinaret(minecraftMessage);
    sendAction(chatAction);

    // Update love protection timer
    context.love_timer = Date.now();
  };
}

/**
 * Minaret use-item action initializer
 * @param {number} itemSlot - Inventory slot number to use
 * @returns {Function} - closure(context, user, message) => void
 */
export function minaret_use(itemSlot) {
  return (context, user, message) => {
    const { minecraft, log } = context;

    if (!minecraft || !minecraft.isConnected()) {
      if (log) log(`❌ minaret_use: Minecraft not connected`);
      return;
    }

    const playerName = getMinecraftUsername();
    minecraft.ws.send(JSON.stringify({ use: playerName, slot: itemSlot }));
    if (log) log(`🎮 minaret_use slot=${itemSlot} player=${playerName}`);
  };
}

/**
 * Apply Minaret effect action initializer
 * @param {string} effectName - Effect name (used as minaret:<effectName>)
 * @returns {Function} - closure(context, user, message) => void
 */
export function apply_effect(effectName) {
  return (context, user, message) => {
    const { minecraft, log } = context;

    if (!minecraft || !minecraft.isConnected()) {
      if (log) log(`❌ apply_effect: Minecraft not connected`);
      return;
    }

    const playerName = getMinecraftUsername();
    const command = `effect give ${playerName} minaret:${effectName} 9999 0 true`;
    minecraft.ws.send(JSON.stringify({ command }));
    if (log) log(`🎮 apply_effect ${effectName} → ${playerName}`);
  };
}

// ============================
// MUSIC ACTIONS
// ============================

/**
 * Music action initializer: creates configured music queue action
 * Smart queueing: if queue is empty and music is playing freely, play immediately.
 * Otherwise, add to queue.
 * @param {RegExp} urlPattern - Regex pattern for valid music URLs
 * @param {string} errorMessage - Message to send when URL is invalid
 * @returns {Function} - closure(context, user, message) => boolean
 */
export function music(
  urlPattern = /^https:\/\/music\.yandex\.(ru|com)\/(album\/\d+\/)?track\/\d+/,
  errorMessage = "Invalid song URL. Please use Yandex Music track URL.",
) {
  return (context, user, message) => {
    const { musicQueue, apiWhisper, send_twitch, log } = context;

    const url = message.trim();

    // Validate URL
    if (!url.match(urlPattern)) {
      log(`❌ Invalid music URL from ${user}: ${url}`);
      apiWhisper(user, errorMessage);
      return false;
    }

    // Normalize to .ru domain
    const normalizedUrl = url.replace(/yandex\.com/, "yandex.ru");

    // Check if music queue is available
    if (!musicQueue) {
      log(`❌ Music queue not available`);
      apiWhisper(user, "Music queue is not available");
      return false;
    }

    // Smart add: play immediately if queue empty, otherwise queue it
    const result = musicQueue.smartAdd(normalizedUrl);

    if (result.queued) {
      // Song was added to queue
      send_twitch(`🎵 Song queued! Position: ${result.position + 1}`);
      log(
        `✅ Song queued by ${user} at position ${result.position}: ${normalizedUrl}`,
      );
    } else {
      // Song is playing immediately — no chat message needed, music_start will announce it
      log(`✅ Song playing immediately for ${user}: ${normalizedUrl}`);
    }

    return true;
  };
}

/**
 * Vote skip action initializer: creates configured vote skip action
 * @param {number} threshold - Number of votes needed to skip
 * @returns {Function} - closure(context, user, message) => void
 */
export function vote_skip(threshold = 3) {
  return (context, user, message) => {
    const { musicQueue, ws, CHANNEL, log, send_twitch } = context;

    // Use MusicQueue's voteSkip method
    if (!musicQueue) {
      log(`❌ Music queue not available`);
      if (send_twitch) send_twitch("❌ Music queue unavailable");
      return;
    }

    const result = musicQueue.voteSkip();

    if (result.error) {
      // Cannot skip (fallback URL or nothing playing)
      log(`❌ Vote skip failed: ${result.error}`);
      if (send_twitch) send_twitch(`❌ ${result.error}`);
      return;
    }

    if (result.skipped) {
      // Skip threshold reached
      log(`⏭️ Skip threshold reached! Song skipped by vote.`);
      if (ws && CHANNEL) {
        ws.send(`PRIVMSG #${CHANNEL} :/me ⏭️ Song skipped!`);
      }
    } else {
      // Vote cast, need more votes
      const votesNeeded = result.votesRemaining;
      if (ws && CHANNEL) {
        ws.send(
          `PRIVMSG #${CHANNEL} :/me 🗳️ Skip votes needed: ${votesNeeded}`,
        );
      }
      log(`🗳️ Skip vote cast by ${user}. Votes remaining: ${votesNeeded}`);
    }
  };
}

/**
 * Playing action initializer: creates configured now-playing display action
 * @param {string} messageFormat - Format string for now-playing message (use {song} placeholder)
 * @returns {Function} - closure(context, user, message) => void
 */
export function playing(messageFormat = "🎹 Now playing: {song}") {
  return (context, user, message) => {
    const { currentSong, ws, CHANNEL, log } = context;

    const formattedMessage = messageFormat.replace("{song}", currentSong);
    ws.send(`PRIVMSG #${CHANNEL} :/me ${formattedMessage}`);
    log(`ℹ️ Song info requested by ${user}: ${currentSong}`);
  };
}

// ============================
// VOICE/SPEECH ACTIONS
// ============================

/** STUB DO NOT TOUCH */
export function fireball() {
  return (context, user, message) => {
    voice({
      type: "default",
      language: "en-US",
      rate: 1.0,
      pitch: 0.5,
      volume: 1.0,
      voiceName: null,
    })(context, user, "FIREBALL has been CAST");
  };
}

/**
 * Voice action initializer: creates configured TTS action with automatic language detection
 * Automatically detects Russian (Cyrillic) vs English (Latin) text and selects appropriate voice
 *
 * @param {Object} voiceConfig - Voice configuration object
 * @param {string} voiceConfig.type - Voice identifier (e.g., "man", "woman", "robot", "child")
 * @param {string} voiceConfig.language - Fallback BCP 47 language code (default: "en-US")
 * @param {number} voiceConfig.rate - Speech rate (0.1-10, default 1.0)
 * @param {number} voiceConfig.pitch - Speech pitch (0-2, default 1.0)
 * @param {number} voiceConfig.volume - Speech volume (0-1, default 1.0)
 * @param {string|null} voiceConfig.voiceName - Specific voice name to use (optional, disables auto-detection)
 * @returns {Function} - closure(context, user, message) => void
 */
export function voice(voiceConfig = {}) {
  // Default configuration
  const config = {
    type: "default",
    language: "en-US",
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    voiceName: null,
    ...voiceConfig,
  };

  return (context, user, message) => {
    const { sendMessageMinaret, log } = context;

    const text = message.trim();

    if (!text) {
      if (log) log(`⚠️ Empty voice command from ${user}`);
      return;
    }

    // Detect language from text (Cyrillic vs Latin)
    const detectedLang = detectLanguage(text);
    const languageMap = {
      ru: "ru-RU",
      en: "en-US",
      unknown: config.language,
    };
    const targetLanguage = config.voiceName
      ? config.language
      : languageMap[detectedLang];

    // Create and configure speech synthesis
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.language = targetLanguage;
    utterance.rate = config.rate;
    utterance.pitch = config.pitch;
    utterance.volume = config.volume;

    // Select voice based on configuration
    const voices = speechSynthesis.getVoices();

    if (config.voiceName) {
      // Use specific voice name if provided
      const voice = voices.find((v) => v.name === config.voiceName);
      if (voice) {
        utterance.voice = voice;
        if (log) log(`🎤 Using specific voice: ${config.voiceName}`);
      } else {
        if (log) log(`⚠️ Voice "${config.voiceName}" not found, using default`);
      }
    } else if (config.type !== "default") {
      // Match voice by type and language
      const voice = voices.find(
        (v) =>
          v.lang.startsWith(targetLanguage.split("-")[0]) &&
          v.name.toLowerCase().includes(config.type.toLowerCase()),
      );

      if (voice) {
        utterance.voice = voice;
        if (log)
          log(
            `🎤 Using ${config.type} voice: ${voice.name} (detected: ${detectedLang})`,
          );
      } else {
        // Fallback to any voice matching language
        const fallbackVoice = voices.find((v) => v.lang === targetLanguage);
        if (fallbackVoice) {
          utterance.voice = fallbackVoice;
          if (log)
            log(
              `🎤 Using fallback voice for ${targetLanguage}: ${fallbackVoice.name} (detected: ${detectedLang})`,
            );
        }
      }
    } else {
      // Use default voice for language
      const voice = voices.find((v) => v.lang === targetLanguage);
      if (voice) {
        utterance.voice = voice;
        if (log)
          log(
            `🎤 Using voice for ${targetLanguage}: ${voice.name} (detected: ${detectedLang})`,
          );
      }
    }

    // Speak
    speechSynthesis.speak(utterance);

    // Forward to Minecraft (only if function exists)
    if (sendMessageMinaret) {
      sendMessageMinaret(`!voice ${text}`);
    }

    if (log)
      log(`🎤 Voice by ${user} [${detectedLang}->${targetLanguage}]: ${text}`);
  };
}

// ============================
// MODERATION ACTIONS
// ============================

/**
 * Execute moderation action via Twitch API
 * Shared helper to reduce code duplication
 * @param {Object} context - Action context
 * @param {string} endpoint - API endpoint path
 * @param {Object} options - Fetch options
 * @param {string|null} successMsg - Success log message (null to skip logging)
 * @param {string|null} errorPrefix - Error message prefix (null to skip logging)
 * @returns {Promise<boolean>} - Success status
 */
async function executeModerationAPI(
  context,
  endpoint,
  options,
  successMsg,
  errorPrefix,
) {
  const { currentUserId, request, log } = context;

  try {
    await request(`https://api.twitch.tv/helix${endpoint}`, options);
    if (successMsg) log(successMsg);
    return true;
  } catch (error) {
    if (errorPrefix) log(`${errorPrefix}: ${error.message}`);
    return false;
  }
}

/**
 * Mute action initializer: creates timeout action with specified duration
 * @param {number} seconds - Timeout duration in seconds
 * @param {string|null} reason - Custom reason for timeout (optional)
 * @returns {Function} - closure(context, user, message) => Promise<void>
 */
export function mute(seconds, reason = null) {
  const timeoutReason =
    reason || `Automated timeout (${seconds}s): message violated rules`;

  return async (context, user, message) => {
    const { currentUserId, userId, log } = context;

    if (!currentUserId || !userId) {
      log("❌ Cannot mute: missing user IDs");
      return;
    }

    await executeModerationAPI(
      context,
      `/moderation/bans?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            user_id: userId,
            duration: seconds,
            reason: timeoutReason,
          },
        }),
      },
      `⏱️ MUTED user ${user} for ${seconds}s: "${message}"`,
      "❌ Mute action failed",
    );
  };
}

/**
 * Ban action initializer: creates permanent ban action
 * @param {string} reason - Custom reason for ban (optional)
 * @returns {Function} - closure(context, user, message) => Promise<void>
 */
export function ban(reason = "Automated ban: message violated rules") {
  return async (context, user, message) => {
    const { currentUserId, userId, log } = context;

    if (!currentUserId || !userId) {
      log("❌ Cannot ban: missing user IDs");
      return;
    }

    await executeModerationAPI(
      context,
      `/moderation/bans?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            user_id: userId,
            reason: reason,
          },
        }),
      },
      `🔨 BANNED user ${user}: "${message}"`,
      "❌ Ban action failed",
    );
  };
}

/**
 * Delete message action initializer: creates message deletion action
 * @param {boolean} silent - If true, don't log deletion (optional)
 * @returns {Function} - closure(context, user, message) => Promise<void>
 */
export function delete_message(silent = false) {
  return async (context, user, message) => {
    const { currentUserId, messageId, log } = context;

    if (!currentUserId || !messageId) {
      if (!silent) log("❌ Cannot delete message: missing IDs");
      return;
    }

    await executeModerationAPI(
      context,
      `/moderation/chat?broadcaster_id=${currentUserId}&moderator_id=${currentUserId}&message_id=${messageId}`,
      { method: "DELETE" },
      silent ? null : `🗑️ DELETED message from ${user}: "${message}"`,
      silent ? null : "❌ Delete action failed",
    );
  };
}

// Alias for better naming consistency
export const delete_ = delete_message;

// ============================
// OBS ACTIONS
// ============================

/**
 * OBS scene switch + source refresh action
 * @param {string} scene - OBS scene name to switch to
 * @param {string} source - Input source name to refresh (browser source)
 * @returns {Function} - closure(context, user, message) => void
 */
export function obs_scene(scene, source) {
  return async (context, user, message) => {
    const { obs, log } = context;
    if (!obs || !obs.isConnected()) {
      if (log) log(`❌ obs_scene: OBS not connected`);
      return;
    }
    obs._sendRequest("SetCurrentProgramScene", { sceneName: scene });
    if (log) log(`👓 Scene → "${scene}", refreshing source "${source}"`);
    try {
      await obs.refreshSource(source);
    } catch (err) {
      if (log) log(`❌ refreshSource failed: ${err.message}`);
    }
  };
}

// ============================
// LLM ACTIONS
// ============================

/**
 * Neuro action initializer: creates LLM chat integration action
 * Sends user message to LLM, receives response, and posts it to Twitch chat
 *
 * @param {Object} neuroConfig - Configuration object
 * @param {number} neuroConfig.maxTokens - Maximum tokens in LLM response (default: 256)
 * @param {number} neuroConfig.temperature - LLM temperature (default: 0.7)
 * @param {string} neuroConfig.fallbackMessage - Message when LLM unavailable
 * @returns {Function} - closure(context, user, message) => Promise<boolean>
 */
export function neuro(neuroConfig = {}) {
  const config = {
    maxTokens: 128,
    temperature: 0.7,
    fallbackMessage: "🤖 Neuro is currently offline",
    ...neuroConfig,
  };

  return async (context, user, message) => {
    const { llm, send_twitch, log } = context;

    const text = message.trim();

    if (!text) {
      if (log) log(`⚠️ Empty neuro request from ${user}`);
      if (send_twitch) send_twitch("❌ Please provide a message for Neuro");
      return false;
    }

    // Check LLM availability
    if (!llm || !llm.isConnected()) {
      if (log) log(`❌ Neuro unavailable for ${user}: LLM not connected`);
      if (send_twitch) send_twitch(config.fallbackMessage);
      return false;
    }

    try {
      if (log) log(`🤖 Neuro processing request from ${user}: "${text}"`);

      // Build messages array for chat API
      const messages = [];

      // Add system prompt if available
      if (llm.systemPrompt && llm.systemPrompt.trim()) {
        messages.push({
          role: "system",
          content: llm.systemPrompt,
        });
      }

      // Add user message
      messages.push({
        role: "user",
        content: text,
      });

      // Call LLM
      const response = await llm.chat(messages, {
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });

      if (!response || !response.trim()) {
        if (log) log(`⚠️ Neuro returned empty response for ${user}`);
        if (send_twitch) send_twitch("🤖 Neuro has nothing to say");
        return false;
      }

      // Send response to chat
      if (send_twitch) send_twitch(`🤖 ${response.trim()}`);
      if (log) log(`✅ Neuro responded to ${user}: "${response.trim()}"`);

      return true;
    } catch (error) {
      if (log) log(`💥 Neuro failed for ${user}: ${error.message}`);
      if (send_twitch) send_twitch("🤖 Neuro encountered an error");
      return false;
    }
  };
}
