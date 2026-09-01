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

import { detectLanguage, pickVoice } from "./utils.js";

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
      minecraft,
      throttle,
      love_timer,
      mp3,
      log,
    } = context;

    // Every effect this reward has is a Minecraft command. With the module
    // unchecked or Minaret down, sendCommandMinaret logs and returns false,
    // this closure returned undefined, and ActionRegistry reads anything but a
    // literal `false` as success — so 300 points bought nothing, silently, and
    // the throttle below would still refuse the viewer's retry for 60s.
    // Checked BEFORE the throttle is stamped, for that reason.
    if (!minecraft?.isConnected()) {
      log(`❌ Hate from ${user} refused: Minecraft not connected`);
      return false;
    }

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
      // false, not undefined: ActionRegistry treats `undefined` as success and
      // PATCHes the redemption to FULFILLED. The Twitch-side cooldown is 30s
      // while this throttle is 60s, so there is a guaranteed 30s window where
      // the viewer is charged 300 points for nothing, with no feedback and no
      // refund path. Returning false cancels the redemption instead.
      return false;
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
    const { sendMessageMinaret, sendAction, minecraft, log } = context;

    // Same reward-fulfilled-on-failure trap as hate() above: the Minecraft
    // message is half of what 200 points buys, and a disconnected module made
    // it a no-op that still returned undefined = success.
    if (!minecraft?.isConnected()) {
      log(`❌ Love from ${user} refused: Minecraft not connected`);
      return false;
    }

    sendMessageMinaret(minecraftMessage);
    sendAction(chatAction);

    // Update love protection timer
    context.love_timer = Date.now();
    return true;
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
const YANDEX_RE = /^https:\/\/music\.yandex\.(ru|com)\/(album\/\d+\/)?track\/\d+/;
const YOUTUBE_RE = /^https:\/\/((www\.)?youtube\.com\/watch\?.*v=|youtu\.be\/)[\w-]+/;

export function music() {
  return (context, user, message) => {
    // send_twitch, not apiWhisper: nothing in the modular codebase ever
    // provides apiWhisper, so both error branches threw TypeError and the
    // viewer got silence instead of the feedback the reward promises.
    // Addressed by name in chat rather than whispered — there is no whisper
    // helper in the context, and inventing one is a feature, not a fix.
    const { musicQueue, send_twitch, log } = context;

    const raw = message.trim();
    const isYandex = YANDEX_RE.test(raw);
    const isYoutube = YOUTUBE_RE.test(raw);

    if (!isYandex && !isYoutube) {
      log(`❌ Invalid music URL from ${user}: ${raw}`);
      if (send_twitch)
        send_twitch(`@${user} Invalid URL. Use a Yandex Music track or YouTube video URL.`);
      return false;
    }

    // isConnected(), not just presence: buildContext() hands back every
    // registered module's reference regardless of connected/enabled state,
    // so `!musicQueue` alone was never false — unchecking the module in the
    // UI didn't stop a redeemed request from being accepted and played,
    // same isConnected() guard every other module-backed action already has.
    if (!musicQueue || !musicQueue.isConnected()) {
      log(`❌ Music queue not available`);
      if (send_twitch) send_twitch(`@${user} Music queue is not available`);
      return false;
    }

    // Normalize Yandex .com → .ru
    const url = isYandex ? raw.replace(/yandex\.com/, "yandex.ru") : raw;
    const result = musicQueue.smartAdd(url);

    if (result.queued) {
      log(`✅ Queued by ${user} at position ${result.position + 1}: ${url}`);
    } else {
      log(`✅ Playing immediately for ${user}: ${url}`);
    }

    return true;
  };
}

/**
 * Vote skip action initializer: creates configured vote skip action
 *
 * Takes NO threshold. It used to accept one and never read it — the closure
 * delegates to musicQueue.voteSkip(), whose count comes from the Music Queue
 * module's `vote_skip_threshold` config field. An argument here was a silent
 * no-op that the JSDoc actively advertised as the control surface, so
 * `vote_skip(5)` in config.js still skipped at 3. Change it in the module's
 * gear panel instead.
 * @returns {Function} - closure(context, user, message) => void
 */
export function vote_skip() {
  return (context, user, message) => {
    const { musicQueue, ws, CHANNEL, log, send_twitch } = context;

    // lore-ok[f0d22d52]: fixed — same isConnected() guard music() already
    // has (see above); this one only checked presence, so a disabled
    // Music Queue module still accepted a paid Skip Song redemption.
    // Use MusicQueue's voteSkip method
    if (!musicQueue || !musicQueue.isConnected()) {
      log(`❌ Music queue not available`);
      if (send_twitch) send_twitch("❌ Music queue unavailable");
      return false; // executeRewardAction only treats a literal `false` as
      // failure (anything else, including undefined, is FULFILLED) — a bare
      // `return` here marked a failed redemption FULFILLED, spending the
      // viewer's points for a vote that was never cast.
    }

    const result = musicQueue.voteSkip();

    if (result.error) {
      // Cannot skip (fallback URL or nothing playing)
      log(`❌ Vote skip failed: ${result.error}`);
      if (send_twitch) send_twitch(`❌ ${result.error}`);
      return false; // same reasoning as above
    }

    if (result.skipped) {
      // Skip threshold reached
      log(`⏭️ Skip threshold reached! Song skipped by vote.`);
      if (canSendToChat(ws, CHANNEL)) {
        ws.send(`PRIVMSG #${CHANNEL} :/me ⏭️ Song skipped!`);
      } else {
        log(`⚠️ Skip announced to nobody — chat socket not open`);
      }
    } else {
      // Vote cast, need more votes
      const votesNeeded = result.votesRemaining;
      if (canSendToChat(ws, CHANNEL)) {
        ws.send(
          `PRIVMSG #${CHANNEL} :/me 🗳️ Skip votes needed: ${votesNeeded}`,
        );
      } else {
        log(`⚠️ Vote count announced to nobody — chat socket not open`);
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

    // readyState, not truthiness — see canSendToChat(). The earlier version of
    // this guard assumed twitch-chat nulls this.ws while reconnecting; it does
    // not, so a CLOSED socket sailed through and ws.send threw InvalidStateError,
    // canceling the redemption anyway.
    if (!canSendToChat(ws, CHANNEL)) {
      log(`❌ Cannot report song for ${user}: chat socket not open`);
      return false;
    }

    const formattedMessage = messageFormat.replace("{song}", currentSong);
    ws.send(`PRIVMSG #${CHANNEL} :/me ${formattedMessage}`);
    log(`ℹ️ Song info requested by ${user}: ${currentSong}`);
    return true;
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

    // Create and configure speech synthesis.
    // `lang` is the ONLY property the API defines for this — an assignment to
    // `.language` (what this used to do) silently creates a dead expando and
    // leaves lang "", which is why Russian text was read out by an English
    // voice whenever the voice lookup below also came up empty.
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = targetLanguage;
    utterance.rate = config.rate;
    utterance.pitch = config.pitch;
    utterance.volume = config.volume;

    // Pick a voice explicitly where we can. Leaving `voice` unset is safe:
    // with `lang` set the engine resolves a matching voice on its own, which
    // is the path taken before getVoices() is populated (empty until the
    // engine's async `voiceschanged`, i.e. for every early utterance).
    if (config.voiceName) {
      // Specific voice name wins over language detection
      const voice = speechSynthesis
        .getVoices()
        .find((v) => v.name === config.voiceName);
      if (voice) {
        utterance.voice = voice;
        if (log) log(`🎤 Using specific voice: ${config.voiceName}`);
      } else {
        if (log) log(`⚠️ Voice "${config.voiceName}" not found, using default`);
      }
    } else {
      const hint = config.type === "default" ? null : config.type;
      const voice = pickVoice(targetLanguage, hint);
      if (voice) {
        utterance.voice = voice;
        if (log)
          log(
            `🎤 Using voice for ${targetLanguage}: ${voice.name} (detected: ${detectedLang})`,
          );
      } else if (log) {
        log(
          `🎤 No voice loaded for ${targetLanguage} yet — engine picks from lang (detected: ${detectedLang})`,
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
/**
 * Is this IRC socket actually able to send right now?
 *
 * `ws && CHANNEL` is NOT enough. twitch-chat's onclose does not null this.ws —
 * only an explicit disconnect does — so during a reconnect backoff the context
 * carries a CLOSED socket, the truthiness check passes, and ws.send() throws
 * InvalidStateError. For a reward action that means the redemption is CANCELED
 * after its side effects already ran (vote_skip has cast the vote by then).
 *
 * @param {WebSocket|null} ws
 * @param {string|null} channel
 * @returns {boolean}
 */
function canSendToChat(ws, channel) {
  return Boolean(ws) && Boolean(channel) && ws.readyState === WebSocket.OPEN;
}

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
 * Resolve the Twitch user id of a moderation target.
 *
 * Two call paths reach these actions and only one of them carries an id:
 *   - chat rules: executeChatAction injects context.userId from the IRC tags
 *   - LLM tools:  the model passes only a username, so context.userId is unset
 * Without this the LLM path silently bailed on every call, so moderation the
 * model believed it had performed never happened.
 *
 * lore-ok[49d6b16b]: fixed at the caller, in modules/llm/module.js
 * _runToolLoop — mute/ban/delete now REFUSE a tool call that omits `user`
 * instead of falling back to the last chatter. Guessing a target is the bug;
 * resolving a named one is this function's job and is correct. The guard
 * belongs where the guess was made, not here.
 *
 * @param {Object} context - action context (must provide request, log)
 * @param {string} user - username, used when context.userId is absent
 * @returns {Promise<string|null>} - user id, or null if it cannot be resolved
 */
async function resolveUserId(context, user) {
  const { userId, request, log } = context;
  // Twitch ids are numeric. Echowire injects the owner's speech with
  // userId "echowire-superuser" and the LLM panel uses "direct-input" —
  // sentinels, not ids. Passing one straight through made the broadcaster
  // guard below compare a string to a numeric id (never equal) and then POST
  // it to /moderation/bans as a user_id, so the streamer quoting scam text
  // ALOUD still triggered a doomed self-ban attempt. Resolve by name instead.
  if (userId && /^\d+$/.test(String(userId))) return userId;
  if (!user || user === "unknown") return null;


  try {
    const response = await request(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(user)}`,
    );
    const data = await response.json();
    const id = data?.data?.[0]?.id;
    if (!id) {
      log(`❌ Cannot resolve user '${user}': not found`);
      return null;
    }
    return id;
  } catch (error) {
    log(`❌ Cannot resolve user '${user}': ${error.message}`);
    return null;
  }
}

/**
 * Mute action initializer: creates timeout action with specified duration
 * @param {number} seconds - Timeout duration in seconds
 * @param {string|null} reason - Custom reason for timeout (optional)
 * @returns {Function} - closure(context, user, message) => Promise<boolean>
 */
export function mute(seconds, reason = null) {
  const timeoutReason =
    reason || `Automated timeout (${seconds}s): message violated rules`;

  return async (context, user, message) => {
    const { currentUserId, log } = context;

    // Always return a boolean: the LLM tool loop reports a bare `undefined` as
    // "Function has no result", which the model reads as success.
    if (!currentUserId) {
      log("❌ Cannot mute: no broadcaster id");
      return false;
    }

    const userId = await resolveUserId(context, user);
    if (!userId) {
      log(`❌ Cannot mute '${user}': unresolved user id`);
      return false;
    }

    // lore-ok[623bc07a]: the self-moderation guard lives HERE, not in
    // handleChatMessage. CHAT_ACTIONS match on message CONTENT, so the streamer
    // quoting a scam to warn viewers hit the ban rule and fired a self-ban at
    // Helix. Guarding the dispatcher instead also killed !voice for the
    // broadcaster; scoping it to the moderation actions fixes both.
    if (userId === currentUserId) {
      log(`⏭️ Skipping mute: '${user}' is the broadcaster`);
      return false;
    }

    return await executeModerationAPI(
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
    const { currentUserId, log } = context;

    // Boolean result for the same reason as mute() — see resolveUserId().
    if (!currentUserId) {
      log("❌ Cannot ban: no broadcaster id");
      return false;
    }

    const userId = await resolveUserId(context, user);
    if (!userId) {
      log(`❌ Cannot ban '${user}': unresolved user id`);
      return false;
    }

    // Never ban the broadcaster — see the note in mute().
    if (userId === currentUserId) {
      log(`⏭️ Skipping ban: '${user}' is the broadcaster`);
      return false;
    }

    return await executeModerationAPI(
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
    const { currentUserId, userId, messageId, log } = context;

    // messageId comes from IRC tags and CANNOT be recovered from a username,
    // so unlike mute/ban this action is chat-path only. Return false rather
    // than undefined so an LLM caller is told it failed instead of assuming
    // success from "Function has no result".
    if (!currentUserId || !messageId) {
      if (!silent) log("❌ Cannot delete message: missing IDs");
      return false;
    }

    // Never delete the broadcaster's own message — same reasoning as
    // mute()/ban(). Chat-only path, so userId here is always the real
    // numeric id from IRC tags (never a resolveUserId sentinel), so a plain
    // comparison is enough — no resolution step needed.
    if (userId === currentUserId) {
      if (!silent) log(`⏭️ Skipping delete: message is from the broadcaster`);
      return false;
    }

    return await executeModerationAPI(
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
 *
 * lore-ok[dcc37367]: fixed in the closure body below — _sendRequest/
 * _waitForReconnect are gone, replaced by obs.switchScene() over the /obs bus.
 *
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
    // switchScene(), not _sendRequest(): the OBS module is a thin client over
    // the server's /obs bus now, and _sendRequest/_waitForReconnect went with
    // the direct obs-websocket connection. Both calls threw TypeError, so the
    // voice commands and the "👓 Glasses + Refresh" button were dead.
    //
    // The obs-websocket 5.7.2 crash workaround (strlen(NULL) in the
    // CurrentProgramSceneChanged broadcast) is no longer this side's problem
    // either: the SERVER owns the OBS socket and its own reconnect, so the
    // browser has nothing to wait for.
    try {
      obs.switchScene(scene);
      if (log) log(`👓 Scene → "${scene}"`);
      // refreshSource still needs a direct multi-step OBS request loop that the
      // bus does not carry — it logs its own error and resolves. Kept in the
      // call chain so the gap stays visible rather than silently skipped.
      await obs.refreshSource(source);
    } catch (err) {
      if (log) log(`❌ obs_scene failed: ${err.message}`);
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

      // chatRaw, not chat: LLMModule.chat() did not survive the modular
      // refactor, so every redemption used to throw TypeError and answer the
      // viewer with "Neuro encountered an error". chatRaw returns the assembled
      // message OBJECT, so the text lives in .content — not the return value.
      const message = await llm.chatRaw(messages, {
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });
      const response = message?.content || "";

      if (!response.trim()) {
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
