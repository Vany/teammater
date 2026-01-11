/**
 * Context Builder
 *
 * Builds unified execution context for actions by combining:
 * - Module context contributions
 * - Helper functions
 * - Global state
 *
 * This replaces the buildCommandContext() function from index.js
 *
 * Usage:
 *   const builder = new ContextBuilder(moduleManager);
 *   builder.setGlobalState({ currentUserId, CHANNEL, ... });
 *   builder.setHelpers({ log, mp3, speak, ... });
 *   const context = builder.build();
 */

export class ContextBuilder {
  constructor(moduleManager) {
    this.moduleManager = moduleManager;
    this.globalState = {};
    this.helpers = {};
  }

  /**
   * Set global state variables
   * @param {Object} state - Global state (throttle, love_timer, etc.)
   */
  setGlobalState(state) {
    this.globalState = state;
  }

  /**
   * Set helper functions
   * @param {Object} helpers - Helper functions (log, mp3, speak, request, etc.)
   */
  setHelpers(helpers) {
    this.helpers = helpers;
  }

  /**
   * Build unified context for action execution
   * Combines:
   * - Module context contributions (ws, llm, minecraft, musicQueue, etc.)
   * - Helper functions (log, mp3, speak, etc.)
   * - Global state (currentUserId, CHANNEL, throttle, etc.)
   *
   * @param {Object} additionalContext - Additional context to merge (optional)
   * @returns {Object} - Complete execution context
   */
  build(additionalContext = {}) {
    // Start with base context
    const context = {
      ...additionalContext,
    };

    // Add module contributions
    const moduleContext = this.moduleManager.buildActionContext();
    Object.assign(context, moduleContext);

    // Add global state
    Object.assign(context, this.globalState);

    // Add helper functions
    Object.assign(context, this.helpers);

    // Add legacy compatibility helpers
    this._addLegacyHelpers(context);

    return context;
  }

  /**
   * Add legacy compatibility helpers for old actions
   * This ensures existing actions.js code continues to work
   */
  _addLegacyHelpers(context) {
    // Ensure backwards compatibility with old context structure

    // Music queue compatibility
    if (context.musicQueue) {
      context.needVoteSkip = context.musicQueue.needVoteSkip;
      context.currentSong = context.musicQueue.currentSong || 'Unknown Track';
    }

    // Ensure all expected fields exist (prevents crashes in actions)
    context.throttle = context.throttle || {};
    context.love_timer = context.love_timer || Date.now();
    context.currentUserId = context.currentUserId || null;
    context.CHANNEL = context.CHANNEL || null;
  }

  /**
   * Update global state value
   * @param {string} key - State key
   * @param {*} value - New value
   */
  updateState(key, value) {
    this.globalState[key] = value;
  }

  /**
   * Get current global state
   */
  getState() {
    return { ...this.globalState };
  }

  /**
   * Extract state changes from context after action execution
   * Updates global state with changes made during action
   * @param {Object} context - Context object after action execution
   */
  syncStateFromContext(context) {
    // Sync mutable state back to global state
    if (context.throttle) {
      this.globalState.throttle = context.throttle;
    }

    if (context.love_timer !== undefined) {
      this.globalState.love_timer = context.love_timer;
    }

    // Sync music queue state
    if (context.musicQueue && context.needVoteSkip !== undefined) {
      // Update in module if needed
      if (context.musicQueue.needVoteSkip !== context.needVoteSkip) {
        context.musicQueue.needVoteSkip = context.needVoteSkip;
      }
    }
  }
}
