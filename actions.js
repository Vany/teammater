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
// context contains: { ws, minarert, llm, currentUserId, CHANNEL, ...globals }
// user: username string
// message: message/input string

import { MINECRAFT_COMMANDS, TIMING, BROADCASTER_USERNAME } from "./config.js";

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
  damageCommand = MINECRAFT_COMMANDS.HEAL,
  lightningCommand = MINECRAFT_COMMANDS.LIGHTNING,
  warningMessage = "§c Beware !!! They are hating you!!",
  soundEffect = "ahhh",
  cooldownMs = TIMING.HATE_COOLDOWN_MS,
) {
  return (context, user, message) => {
    const {
      sendCommandMinaret,
      sendMessageMinaret,
      throttle,
      love_timer,
      mp3,
      log,
    } = context;

    // Initialize throttle for user if not exists
    if (throttle[user] === undefined) {
      throttle[user] = Date.now() - TIMING.HATE_INITIAL_OFFSET_MS;
    }

    const timeSinceLastCommand = Date.now() - throttle[user];

    // Check throttle (except for broadcaster)
    if (timeSinceLastCommand < cooldownMs && user !== BROADCASTER_USERNAME) {
      log(
        `⏱️ Throttled: ${user} must wait ${Math.ceil((cooldownMs - timeSinceLastCommand) / 1000)}s`,
      );
      return;
    }

    // Update throttle timestamp
    throttle[user] = Date.now();

    // Always execute damage command (typically heal)
    sendCommandMinaret(damageCommand);

    // Check love protection
    if (Date.now() - love_timer < TIMING.LOVE_PROTECTION_DURATION_MS) {
      sendMessageMinaret(warningMessage);
      mp3(soundEffect);
    } else {
      // Strike with lightning after 1s delay
      setTimeout(() => sendCommandMinaret(lightningCommand), 1000);
    }

    // Update love timer
    context.love_timer = Date.now();
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

// ============================
// MUSIC ACTIONS
// ============================

/**
 * Music action initializer: creates configured music queue action
 * @param {RegExp} urlPattern - Regex pattern for valid music URLs
 * @param {string} errorMessage - Message to send when URL is invalid
 * @returns {Function} - closure(context, user, message) => boolean
 */
export function music(
  urlPattern = /^https:\/\/music\.yandex\.(ru|com)\/(album\/\d+\/)?track\/\d+/,
  errorMessage = "Invalid song URL. Please use Yandex Music track URL.",
) {
  return (context, user, message) => {
    const { queueSong, apiWhisper, send_twitch, log } = context;

    const url = message.trim();

    // Validate URL
    if (!url.match(urlPattern)) {
      log(`❌ Invalid music URL from ${user}: ${url}`);
      apiWhisper(user, errorMessage);
      return false;
    }

    // Normalize to .ru domain
    const normalizedUrl = url.replace(/yandex\.com/, "yandex.ru");

    // Queue song
    const queuePosition = queueSong(normalizedUrl);
    send_twitch(`🎵 Song queued! Position: ${queuePosition}`);

    log(`✅ Song queued by ${user}: ${normalizedUrl}`);
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
    const { needVoteSkip, skipSong, ws, CHANNEL, log } = context;

    // Decrement vote counter
    context.needVoteSkip--;

    if (context.needVoteSkip < 1) {
      log(`⏭️ Skip threshold reached! Skipping song...`);
      skipSong();
      // Reset vote counter for next song
      context.needVoteSkip = threshold;
    } else {
      // Announce remaining votes needed
      const votesNeeded = context.needVoteSkip;
      ws.send(`PRIVMSG #${CHANNEL} :/me 🆘 Skip votes needed: ${votesNeeded}`);
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

    // Debug logging
    if (log) {
      log(`🔍 Debug - llm in context: ${llm ? "exists" : "null"}`);
      if (llm) {
        log(`🔍 Debug - llm.isConnected(): ${llm.isConnected()}`);
        log(`🔍 Debug - llm.connected: ${llm.connected}`);
      }
    }

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
