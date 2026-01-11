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
 *   await registry.executeChatAction(message, context);
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
    this.log(`📋 Registered ${chatActions.length} chat action rules`);
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
      }
    }

    this.log(`🎯 Registered ${this.rewardActions.size} reward actions`);
  }

  /**
   * Register a single reward action
   */
  registerRewardAction(rewardId, actionClosure) {
    this.rewardActions.set(rewardId, actionClosure);
  }

  /**
   * Check if message matches any chat action rules
   * Returns {action, message} if match, null otherwise
   */
  checkChatActions(message) {
    for (const rule of this.chatActions) {
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
      // Add message-specific data to context
      const fullContext = {
        ...context,
        userId: messageData.userId,
        messageId: messageData.messageId,
      };

      // Execute action
      await actionClosure(fullContext, messageData.username, extractedMessage);

      return true;
    } catch (error) {
      this.log(`💥 Chat action execution failed: ${error.message}`);
      console.error('Chat action error:', error);
      return false;
    }
  }

  /**
   * Execute reward action with context
   * @param {string} rewardId - Reward ID
   * @param {string} userName - User who redeemed
   * @param {string} userInput - User input (if required)
   * @param {Object} context - Execution context from modules
   * @returns {Promise<boolean>} - Success status (true = FULFILLED, false = CANCELED)
   */
  async executeRewardAction(rewardId, userName, userInput, context) {
    const actionClosure = this.rewardActions.get(rewardId);

    if (!actionClosure || typeof actionClosure !== 'function') {
      this.log(`❌ No action found for reward: ${rewardId}`);
      return false;
    }

    try {
      // Execute action
      const result = await actionClosure(context, userName, userInput);

      // Check if action explicitly returned false (indicates failure)
      const failed = result === false;

      return !failed;
    } catch (error) {
      this.log(`💥 Reward action execution failed: ${error.message}`);
      console.error('Reward action error:', error);
      return false;
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
