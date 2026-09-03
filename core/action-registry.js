/**
 * Action Registry
 *
 * Centralized registry for managing chat actions and channel point reward actions.
 *
 * Features:
 * - Register actions with metadata
 * - Execute actions with unified context
 * - Pattern matching for chat actions
 * - Reward ID mapping for redemptions
 * - Error handling and logging
 *
 * Usage:
 *   const registry = new ActionRegistry();
 *   registry.setChatActions(CHAT_ACTIONS);
 *   registry.setRewardActions(rewardConfigs);
 *
 *   // Execute chat action
 *   await registry.executeChatAction(message, messageData, context);
 *
 *   // Execute reward action
 *   await registry.executeRewardAction(rewardId, user, input, context);
 */

export class ActionRegistry {
  constructor() {
    this.chatActions = []; // Array of [action, ...patterns]
    this.rewardActions = new Map(); // reward_id -> action closure
    this.log = console.log;
  }

  /**
   * Set logging function
   */
  setLogger(logFn) {
    this.log = logFn;
  }

  /**
   * Set chat actions from config
   * @param {Array} chatActions - Array of [actionClosure, ...patterns]
   */
  setChatActions(chatActions) {
    this.chatActions = chatActions;

    // Count what can actually FIRE, and name what cannot. Logging the raw
    // array length confirmed rules that checkChatActions silently skips, so a
    // rule that lost its regex in an edit reported itself as registered and
    // then never fired — with no other diagnostic than re-reading the source.
    const invalid = chatActions.filter((rule) => !Array.isArray(rule) || rule.length < 2);
    for (const rule of invalid) {
      this.log(`❌ Chat action rule has no patterns and can never fire: ${JSON.stringify(rule)}`);
    }
    this.log(
      `📋 Registered ${chatActions.length - invalid.length} chat action rules` +
        (invalid.length ? ` (${invalid.length} INVALID, see above)` : ""),
    );
  }

  /**
   * Set reward actions from reward configs
   * @param {Object} rewardConfigs - Map of reward_id -> reward config with action
   */
  setRewardActions(rewardConfigs) {
    this.rewardActions.clear();

    for (const [rewardId, config] of Object.entries(rewardConfigs)) {
      if (config.action && typeof config.action === 'function') {
        this.rewardActions.set(rewardId, config.action);
      } else {
        // Fail loud. A reward whose action is not a function is silently absent
        // from the registry, and executeRewardAction then reports it as UNOWNED
        // — "not ours" — which is a lie about OUR OWN misconfigured reward, and
        // leaves the redemption in unfulfilled limbo with the viewer's points
        // spent. README documented exactly this broken form (action: "key", a
        // string) for a long time, so it is a shape that gets written.
        this.log(
          `❌ Reward "${rewardId}" has no callable action (got ${typeof config.action}) — ` +
            `it will NOT be handled. The action must be a closure, e.g. action: voice().`,
        );
      }
    }

    this.log(`🎯 Registered ${this.rewardActions.size} reward actions`);
  }

  /**
   * Register a single reward action
   */
  registerRewardAction(rewardId, actionClosure) {
    if (typeof actionClosure !== 'function') {
      this.log(`❌ registerRewardAction("${rewardId}") ignored: not a function`);
      return;
    }
    this.rewardActions.set(rewardId, actionClosure);
  }

  /**
   * Check if message matches any chat action rules
   * Returns {action, message} if match, null otherwise
   */
  checkChatActions(message) {
    for (const rule of this.chatActions) {
      // Already reported by setChatActions — skip quietly here rather than
      // logging once per incoming chat message.
      if (!Array.isArray(rule) || rule.length < 2) continue;

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

  /**
   * Execute chat action with context
   * @param {string} message - Chat message text
   * @param {Object} messageData - Message metadata (userId, messageId, username, tags)
   * @param {Object} context - Execution context from modules
   * @returns {Promise<boolean>} - Success status
   */
  async executeChatAction(message, messageData, context) {
    // Check if message matches any rules
    const result = this.checkChatActions(message);
    if (!result) {
      return false; // No action matched
    }

    const { action: actionClosure, message: extractedMessage } = result;

    if (!actionClosure || typeof actionClosure !== 'function') {
      this.log('❌ Invalid chat action closure');
      return false;
    }

    try {
      // Augment the ORIGINAL context, not a shallow copy. Actions record state
      // by writing onto the context they are handed — hate() and love() both do
      // `context.love_timer = Date.now()` — and index.js calls
      // syncStateFromContext(context) on the ORIGINAL afterwards. A copy meant
      // every primitive write was thrown away on the chat path, so love
      // protection redeemed via chat never took effect. (throttle survived only
      // because it is an object whose properties are shared by reference, which
      // is exactly what made the loss hard to notice.)
      context.userId = messageData.userId;
      context.messageId = messageData.messageId;

      // Execute action
      await actionClosure(context, messageData.username, extractedMessage);

      return true;
    } catch (error) {
      this.log(`💥 Chat action execution failed: ${error.message}`);
      console.error('Chat action error:', error);
      return false;
    }
  }

  /**
   * Execute reward action with context.
   *
   * THREE outcomes, not two. "Not ours" and "ours but failed" used to share the
   * `false` return, and index.js PATCHes `false` to CANCELED — but EventSub
   * delivers EVERY redemption on the channel (the v1 subscription condition is
   * `broadcaster_user_id` alone; it cannot filter per reward), so any reward the
   * streamer created by hand was cancelled and refunded by us the moment a
   * viewer redeemed it, with no way to fulfil it manually. The severe case was
   * an empty registry: `initializeRewards()` failure is swallowed as a warning
   * in index.js, and every redemption on the channel — ours included — would be
   * auto-cancelled for the whole session.
   *
   * @param {string} rewardId - Reward ID
   * @param {string} userName - User who redeemed
   * @param {string} userInput - User input (if required)
   * @param {Object} context - Execution context from modules
   * @returns {Promise<"FULFILLED"|"CANCELED"|"UNOWNED">} - UNOWNED means this
   *   reward is not ours: the caller must leave the redemption untouched so the
   *   streamer can still act on it.
   */
  async executeRewardAction(rewardId, userName, userInput, context) {
    const actionClosure = this.rewardActions.get(rewardId);

    // lore-ok[75e53c36]: the conflation is fixed at the REGISTRATION side, in
    // setRewardActions and registerRewardAction above — a reward of ours whose
    // action is not callable is now named in an error log as it is dropped,
    // instead of arriving here indistinguishable from a stranger's reward. It
    // still reaches this branch (the Map genuinely does not hold it) and is
    // still left alone, which is right: cancelling would refund and destroy a
    // redemption over OUR misconfiguration. README.md's `action: "reward_key"`
    // string form, which is what made this shape common, is corrected too.
    if (!actionClosure || typeof actionClosure !== 'function') {
      this.log(`⏭️ Reward ${rewardId} is not ours — leaving redemption alone`);
      return "UNOWNED";
    }

    try {
      // Execute action
      const result = await actionClosure(context, userName, userInput);

      // Only a literal `false` means failure; undefined is success by contract
      return result === false ? "CANCELED" : "FULFILLED";
    } catch (error) {
      this.log(`💥 Reward action execution failed: ${error.message}`);
      console.error('Reward action error:', error);
      return "CANCELED";
    }
  }

  /**
   * Get all registered chat actions
   */
  getChatActions() {
    return this.chatActions;
  }

  /**
   * Get all registered reward actions
   */
  getRewardActions() {
    return this.rewardActions;
  }

  /**
   * Clear all actions
   */
  clear() {
    this.chatActions = [];
    this.rewardActions.clear();
    this.log('🗑️ Action registry cleared');
  }
}
