/**
 * Twitch EventSub Module
 *
 * WebSocket connection for Twitch EventSub (channel point redemptions, etc.)
 *
 * Features:
 * - EventSub WebSocket connection
 * - Session management
 * - Subscription to channel point redemptions
 * - Redemption event handling
 * - Reward status updates (FULFILLED/CANCELED)
 *
 * Based on connectEventSub() from index.js
 */

import { BaseModule } from "../base-module.js";
import { request } from "../../utils.js";

export class TwitchEventSubModule extends BaseModule {
  constructor() {
    super();
    this.sessionId = null;
    this.currentUserId = null;
    this.customRewards = {}; // Map of reward_id -> reward_data
    this.redemptionHandlers = []; // Array of handler functions

    // Ready gate: settled from inside ws.onmessage, awaited by doConnect().
    // See _createReadyGate() for why the connection cannot be judged synchronously.
    this._readyResolve = null;
    this._readyReject = null;
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "🎯 Twitch EventSub";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      connection: {
        eventsub_url: {
          type: "text",
          label: "EventSub WebSocket URL",
          default: "wss://eventsub.wss.twitch.tv/ws",
          stored_as: "twitch_eventsub_url",
        },
        reconnect_delay: {
          type: "number",
          label: "Reconnect Delay (ms)",
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
        },
      },
      auto_shoutout: {
        enabled: {
          type: "checkbox",
          label: "Auto Shoutout on Raid",
          default: true,
          stored_as: "auto_shoutout_enabled",
        },
        min_raiders: {
          type: "number",
          label: "Minimum Raiders for Auto Shoutout",
          default: 5,
          min: 1,
          max: 10000,
          step: 1,
          stored_as: "auto_shoutout_min_raiders",
        },
      },
    };
  }

  /**
   * Initialize module with custom rewards list display
   */
  async initialize(container) {
    // Call parent initialization
    await super.initialize(container);

    // Add rewards list display after config panel
    this._createRewardsListDisplay();
  }

  /**
   * Create rewards list display section
   * @private
   */
  _createRewardsListDisplay() {
    const rewardsDiv = document.createElement("div");
    rewardsDiv.className = "rewards-list collapsed";
    rewardsDiv.style.marginTop = "10px";
    rewardsDiv.style.padding = "10px";
    rewardsDiv.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
    rewardsDiv.style.borderRadius = "4px";
    rewardsDiv.style.fontSize = "12px";

    const header = document.createElement("h4");
    header.textContent = "Channel Point Rewards";
    header.style.marginTop = "0";
    header.style.marginBottom = "10px";
    header.style.fontSize = "14px";

    rewardsDiv.appendChild(header);

    const listContainer = document.createElement("div");
    listContainer.className = "rewards-items";
    rewardsDiv.appendChild(listContainer);

    this.ui.rewardsList = rewardsDiv;
    this.ui.rewardsItems = listContainer;
    // Add to config panel instead of container
    this.ui.configPanel.appendChild(rewardsDiv);
  }

  /**
   * Set user ID (required for subscriptions)
   * Must be called before connect()
   * If module is enabled, will automatically connect
   */
  async setUserId(userId) {
    this.currentUserId = userId;

    // If module is enabled, connect now that we have user ID
    if (this.enabled && !this.connected) {
      this.log("🔑 User ID set, connecting...");
      await this.connect();
    }
  }

  /**
   * Set custom rewards map
   */
  setCustomRewards(rewards) {
    this.customRewards = rewards;
    this._updateRewardsList();
  }

  /**
   * Update rewards list display
   * @private
   */
  _updateRewardsList() {
    if (!this.ui.rewardsItems) return;

    const rewards = Object.values(this.customRewards);

    if (rewards.length === 0) {
      this.ui.rewardsItems.innerHTML =
        '<div style="color: #888;">No rewards found</div>';
      return;
    }

    this.ui.rewardsItems.innerHTML = rewards
      .map(
        (reward) => `
      <div class="reward-item" style="margin-bottom: 10px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 3px;">
        <div style="margin-bottom: 5px;">
          <strong>${reward.title}</strong>
        </div>
        <div style="color: #888; font-size: 11px;">
          Cost: ${reward.cost} points | Enabled: ${reward.is_enabled ? "✅" : "❌"}
        </div>
        <button
          class="reward-test-btn"
          data-reward-id="${reward.id}"
          style="margin-top: 5px; padding: 3px 8px; font-size: 11px; cursor: pointer; background: #9147ff; color: white; border: none; border-radius: 3px;"
        >
          TEST
        </button>
      </div>
    `,
      )
      .join("");

    // Add click handlers for test buttons
    this.ui.rewardsItems.querySelectorAll(".reward-test-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rewardId = btn.getAttribute("data-reward-id");
        this._testReward(rewardId);
      });
    });

    // Show the rewards list
    this.ui.rewardsList.classList.remove("collapsed");
  }

  /**
   * Test a reward (simulate redemption)
   * @private
   */
  async _testReward(rewardId) {
    const reward = this.customRewards[rewardId];
    if (!reward) {
      this.log(`❌ Reward not found: ${rewardId}`);
      return;
    }

    this.log(`🧪 Testing reward: ${reward.title}`);

    // Simulate redemption event
    const mockRedemption = {
      id: `test-${Date.now()}`,
      user_name: "TestUser",
      user_input: reward.is_user_input_required ? "Test input" : "",
      reward: reward,
    };

    // Call redemption handlers
    for (const handler of this.redemptionHandlers) {
      try {
        await handler(mockRedemption);
      } catch (error) {
        this.log(`❌ Test failed: ${error.message}`);
      }
    }
  }

  /**
   * Connect to EventSub.
   *
   * Resolves only once the session is live AND every subscription has been
   * accepted by Twitch. An open socket with no subscriptions receives nothing,
   * so reporting it as connected hides the only symptom the user would ever see.
   */
  async doConnect() {
    if (!this.currentUserId) {
      // Fail loud: connect() marks the module green as soon as this returns,
      // so a silent early return is indistinguishable from a live connection.
      throw new Error(
        "No Twitch user ID — authenticate before enabling EventSub",
      );
    }

    const eventsubUrl = this.getConfigValue(
      "eventsub_url",
      "wss://eventsub.wss.twitch.tv/ws",
    );

    // Re-arm auto-reconnect: _cleanupReconnect() cleared it on the last
    // disconnect and nothing else ever sets it back, so an uncheck/recheck
    // cycle would otherwise leave the module unable to recover from a drop.
    this.shouldReconnect = true;

    // Drop a socket left over from a previous attempt before overwriting the
    // reference — detach onclose first so its reconnect does not race ours.
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }

    this.log(`🎯 Connecting to EventSub at ${eventsubUrl}...`);

    const ready = this._createReadyGate();
    this.ws = new WebSocket(eventsubUrl);

    this.ws.onopen = () => {
      this.log("✅ EventSub socket open, waiting for session...");
    };

    this.ws.onerror = () => {
      this._failReady(new Error(`EventSub socket error (${eventsubUrl})`));
    };

    this.ws.onclose = () => {
      this.log("❌ EventSub disconnected");
      this.updateStatus(false);
      this.sessionId = null;
      // No-op once the gate has settled; only meaningful if we never got a session.
      this._failReady(new Error("EventSub socket closed before session ready"));

      // Auto-reconnect using shared helper
      this._scheduleReconnect();
    };

    this.ws.onmessage = async (event) => {
      // Nothing awaits onmessage, so an error thrown here reaches no caller.
      // Route it into the ready gate, which doConnect() is awaiting.
      try {
        await this._handleEventSubMessage(event.data);
      } catch (error) {
        this.log(`💥 EventSub: ${error.message}`);
        this._failReady(error);
      }
    };

    try {
      await ready;
    } catch (error) {
      // Verdict is negative. If the socket is still OPEN the session was fine
      // and a subscription was refused — a config problem (scope, token) that
      // a reconnect timer cannot fix, so drop the socket instead of leaving an
      // open, subscription-less connection behind a red indicator.
      // If it already closed, onclose has scheduled the retry: that one IS
      // transient, so leave it alone.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.shouldReconnect = false;
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      throw error;
    }
  }

  /**
   * Disconnect from EventSub
   */
  async doDisconnect() {
    this.log("🔌 Disconnecting from EventSub...");

    // Cleanup using shared helper
    this._cleanupReconnect();

    this.sessionId = null;
    this.log("✅ Disconnected from EventSub");
  }

  /**
   * Build the promise doConnect() awaits.
   *
   * The connection verdict is only known inside ws.onmessage — session_welcome
   * carries the session id, and only then can subscriptions be created. This
   * gate carries that verdict back out to doConnect().
   * @private
   */
  _createReadyGate(timeoutMs = 15000) {
    const gate = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("EventSub session/subscription timeout")),
        timeoutMs,
      );
      this._readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this._readyReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    // The socket can fail before doConnect() reaches `await ready`; this keeps
    // that window from producing an unhandled rejection. doConnect() still sees it.
    gate.catch(() => {});
    return gate;
  }

  /**
   * Reject the ready gate. No-op once it has settled, so late socket errors
   * on a healthy connection are logged but do not re-open a closed verdict.
   * @private
   */
  _failReady(error) {
    this._readyReject?.(error);
  }

  /**
   * Migrate to the socket Twitch hands us in `session_reconnect`.
   *
   * The old socket keeps delivering until the new one has greeted us, so this
   * loses nothing — that is the whole point of the message. Subscriptions carry
   * over to the new session, so we must NOT call _subscribeAll() here; doing so
   * would create a second set and double every notification.
   *
   * On failure we fall back to the ordinary path: close the old socket and let
   * onclose → _scheduleReconnect build a fresh session from scratch.
   * @private
   */
  async _migrateSocket(reconnectUrl) {
    this.log(`🔄 EventSub session_reconnect → migrating to new edge...`);
    const oldWs = this.ws;
    const newWs = new WebSocket(reconnectUrl);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("reconnect_url welcome timeout")),
          30000,
        );
        newWs.onerror = () => {
          clearTimeout(timer);
          reject(new Error("reconnect socket error"));
        };
        newWs.onmessage = async (event) => {
          const m = JSON.parse(event.data);
          if (m.metadata?.message_type === "session_welcome") {
            clearTimeout(timer);
            this.sessionId = m.payload.session.id;
            resolve();
            return;
          }
          // Notifications can arrive on the new socket before the swap below.
          await this._handleEventSubMessage(event.data);
        };
      });
    } catch (error) {
      this.log(`❌ EventSub migration failed: ${error.message} — falling back`);
      newWs.close();
      // Old socket is about to be closed by Twitch anyway; let onclose retry.
      return;
    }

    // Take over: detach the old socket's onclose FIRST so its death does not
    // trigger a reconnect that would race the session we just established.
    oldWs.onclose = null;
    oldWs.close();

    this.ws = newWs;
    newWs.onerror = () => {
      this._failReady(new Error("EventSub socket error (migrated)"));
    };
    newWs.onclose = () => {
      this.log("❌ EventSub disconnected");
      this.updateStatus(false);
      this.sessionId = null;
      this._scheduleReconnect();
    };
    newWs.onmessage = async (event) => {
      try {
        await this._handleEventSubMessage(event.data);
      } catch (error) {
        this.log(`💥 EventSub: ${error.message}`);
      }
    };

    this.log(`✅ EventSub migrated, session: ${this.sessionId}`);
  }

  /**
   * Handle EventSub message
   */
  async _handleEventSubMessage(data) {
    const msg = JSON.parse(data);
    const type = msg.metadata?.message_type;

    if (type === "session_welcome") {
      this.sessionId = msg.payload.session.id;
      this.log(`✅ EventSub session: ${this.sessionId}`);

      // No updateStatus(true) here — connect() sets it after doConnect()
      // resolves, which happens only if every subscription below succeeded.
      await this._subscribeAll();
      this._readyResolve();
      return;
    }

    if (type === "session_reconnect") {
      // Twitch is rotating edges and will close this socket shortly. Relying on
      // onclose → _scheduleReconnect instead means a multi-second dead window
      // plus a full resubscribe, and Twitch never replays notifications missed
      // while disconnected — a redemption in that window is lost, points spent,
      // nothing logged. Migrate to reconnect_url BEFORE the old socket dies.
      await this._migrateSocket(msg.payload.session.reconnect_url);
      return;
    }

    if (type === "revocation") {
      // Twitch dropped a subscription after it was created (token revoked,
      // scope removed, version retired). The socket stays open, so without
      // this the module looks healthy while receiving nothing.
      const sub = msg.payload.subscription;
      this.log(`💥 EventSub subscription revoked: ${sub.type} — ${sub.status}`);
      this.updateStatus(false);
      return;
    }

    if (type === "notification") {
      const subscriptionType = msg.payload.subscription.type;
      const event = msg.payload.event;

      if (subscriptionType === "channel.channel_points_custom_reward_redemption.add") {
        this.log(`🎯 Redemption: ${event.reward.title} by ${event.user_name}`);
        this._notifyRedemptionHandlers(event);
      } else if (subscriptionType === "channel.raid") {
        this.log(`🚨 Raid from ${event.from_broadcaster_user_login} with ${event.viewers} viewers`);
        this._handleRaid(event);
      } else if (subscriptionType === "stream.online") {
        this.log(`🟢 Stream online: ${event.broadcaster_user_login}`);
        document.dispatchEvent(new CustomEvent("stream:online", { detail: event }));
      }
    }
  }

  /**
   * Every subscription this module needs, in creation order.
   * `condition` is a function of the broadcaster id — raid keys on the
   * DESTINATION channel, the other two on the broadcaster itself.
   * @private
   */
  static SUBSCRIPTIONS = [
    {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: (id) => ({ broadcaster_user_id: id }),
      scope: "channel:read:redemptions",
    },
    {
      type: "channel.raid",
      version: "1",
      condition: (id) => ({ to_broadcaster_user_id: id }),
      scope: "none",
    },
    {
      type: "stream.online",
      version: "1",
      condition: (id) => ({ broadcaster_user_id: id }),
      scope: "none",
    },
  ];

  /**
   * Create every subscription, then report ALL failures together — one bad
   * scope must not mask the state of the others, and the caller needs the
   * full picture to know what the module will and will not receive.
   * @throws {Error} if any subscription was rejected
   * @private
   */
  async _subscribeAll() {
    const failures = [];

    for (const sub of TwitchEventSubModule.SUBSCRIPTIONS) {
      try {
        await request("https://api.twitch.tv/helix/eventsub/subscriptions", {
          method: "POST",
          body: JSON.stringify({
            type: sub.type,
            version: sub.version,
            condition: sub.condition(this.currentUserId),
            transport: { method: "websocket", session_id: this.sessionId },
          }),
        });

        this.log(`✅ Subscribed: ${sub.type}`);
      } catch (error) {
        // request() puts the Twitch response body in the message — that body
        // names the missing scope or the reason the subscription was refused.
        this.log(
          `❌ Subscribe failed: ${sub.type} (needs scope: ${sub.scope}) — ${error.message}`,
        );
        failures.push(`${sub.type}: ${error.message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`EventSub subscriptions failed — ${failures.join(" | ")}`);
    }
  }

  /**
   * Handle incoming raid — auto shoutout via Helix API if configured.
   * @param {object} event - channel.raid event payload
   */
  _handleRaid(event) {
    const raw = this.getConfigValue("enabled", "true");
    const enabled = raw === true || raw === "true";
    if (!enabled) return;

    const minRaiders = this.getConfigInt("min_raiders", 5);
    if (event.viewers < minRaiders) {
      this.log(`ℹ️ Raid from ${event.from_broadcaster_user_login}: ${event.viewers} viewers < threshold ${minRaiders}, skipping shoutout`);
      return;
    }

    const obsModule = this.moduleManager?.get("obs");
    if (!obsModule) {
      this.log(`❌ Auto shoutout: obs module not available`);
      return;
    }

    obsModule._twitchShoutout(event.from_broadcaster_user_login)
      .then(() => this.log(`📣 Shouted out ${event.from_broadcaster_user_login} (${event.viewers} raiders)`))
      .catch(e => this.log(`❌ Auto shoutout failed: ${e.message}`));
  }

  /**
   * Register a redemption handler
   * @param {Function} handler - Function(redemptionData) to handle redemptions
   */
  registerRedemptionHandler(handler) {
    this.redemptionHandlers.push(handler);
  }

  /**
   * Unregister a redemption handler
   */
  unregisterRedemptionHandler(handler) {
    this.redemptionHandlers = this.redemptionHandlers.filter(
      (h) => h !== handler,
    );
  }

  /**
   * Notify all redemption handlers
   */
  _notifyRedemptionHandlers(redemption) {
    for (const handler of this.redemptionHandlers) {
      try {
        handler(redemption);
      } catch (error) {
        this.log(`💥 Redemption handler error: ${error.message}`);
      }
    }
  }

  /**
   * Update redemption status (FULFILLED/CANCELED)
   */
  async updateRedemptionStatus(rewardId, redemptionId, status) {
    if (!this.currentUserId) {
      this.log("❌ No user ID available");
      return false;
    }

    try {
      await request(
        `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${this.currentUserId}&reward_id=${rewardId}&id=${redemptionId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: status }),
        },
      );

      this.log(
        `✅ Redemption ${status.toLowerCase()}: ${rewardId} ${redemptionId}`,
      );
      return true;
    } catch (error) {
      this.log(`❌ Error updating redemption: ${error.message}`);
      return false;
    }
  }

  /**
   * Provide context for actions
   * Returns module reference - actions access methods directly
   */
  getContextContribution() {
    return { eventSub: this };
  }
}
