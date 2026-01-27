/**
 * Base Module Class
 *
 * All Teammater modules extend this base class.
 * Provides common functionality for:
 * - UI rendering (status indicator, config panel, control modal)
 * - Connection lifecycle
 * - Config persistence via localStorage
 * - Event handling
 *
 * Subclasses must implement:
 * - getConfig() - Return module config schema
 * - async doConnect() - Establish connection
 * - async doDisconnect() - Close connection
 * - getContextContribution() - Return object to merge into action context
 */

export class BaseModule {
  constructor() {
    this.moduleId = null;
    this.connected = false;
    this.enabled = true; // Default enabled state
    this.log = console.log;
    this.moduleManager = null; // Reference to ModuleManager

    // UI elements (created during initialize)
    this.ui = {
      container: null, // Module container div
      statusIndicator: null, // Connection status dot
      configToggle: null, // Config panel toggle button
      configPanel: null, // Config panel container
      controlToggle: null, // Control modal toggle button (if hasControlPanel)
      controlModal: null, // Control modal (if hasControlPanel)
    };

    // WebSocket reconnect state (shared by WS modules)
    this.ws = null;
    this.shouldReconnect = true;
    this.reconnectTimer = null;
  }

  /**
   * Set module ID (called by ModuleManager)
   * @param {string} id - Unique module identifier
   */
  setModuleId(id) {
    this.moduleId = id;
  }

  /**
   * Set logger function
   * @param {Function} logFn - Logging function
   */
  setLogger(logFn) {
    this.log = logFn;
  }

  /**
   * Get module display name
   * Override in subclass to customize
   * @returns {string} - Display name
   */
  getDisplayName() {
    return this.moduleId || "Unknown Module";
  }

  /**
   * Get module configuration schema
   * Override in subclass
   * @returns {Object} - Config schema object
   */
  getConfig() {
    return {};
  }

  /**
   * Check if module has a control panel (modal)
   * Override in subclass if module needs a control modal
   * @returns {boolean}
   */
  hasControlPanel() {
    return false;
  }

  /**
   * Render control panel content
   * Override in subclass if hasControlPanel() returns true
   * @returns {HTMLElement|null}
   */
  renderControlPanel() {
    return null;
  }

  /**
   * Get context contribution for action execution
   * Override in subclass to provide module-specific context
   * @returns {Object} - Object to merge into action context
   */
  getContextContribution() {
    return {};
  }

  /**
   * Initialize module (render UI, setup event listeners)
   * @param {HTMLElement} container - Parent container for module UI
   */
  async initialize(container) {
    // Import UI builder
    const { UIBuilder } = await import("../core/ui-builder.js");
    const builder = new UIBuilder();

    // Create module container
    this.ui.container = builder.createModuleContainer(
      this.moduleId,
      this.getDisplayName(),
    );

    // Create status indicator
    this.ui.statusIndicator = builder.createStatusIndicator();
    this.ui.container
      .querySelector(".module-header")
      .prepend(this.ui.statusIndicator);

    // Create enable checkbox
    this.ui.enableCheckbox = builder.createEnableCheckbox(
      this.moduleId,
      this.enabled,
      (enabled) => {
        this.handleEnableChange(enabled);
      },
    );
    this.ui.container
      .querySelector(".module-header")
      .appendChild(this.ui.enableCheckbox);

    // Create control panel toggle button and modal if needed (add first)
    if (this.hasControlPanel()) {
      this.ui.controlToggle = builder.createControlToggle(() => {
        this.toggleControlModal();
      });
      this.ui.container
        .querySelector(".module-header")
        .appendChild(this.ui.controlToggle);

      // Create control modal
      this.ui.controlModal = builder.createControlModal(
        this.moduleId,
        this.getDisplayName(),
        this.renderControlPanel.bind(this),
      );
      document.body.appendChild(this.ui.controlModal);
    }

    // Create config panel toggle button (add after control toggle)
    this.ui.configToggle = builder.createConfigToggle(() => {
      this.toggleConfigPanel();
    });
    this.ui.container
      .querySelector(".module-header")
      .appendChild(this.ui.configToggle);

    // Create config panel from schema
    const config = this.getConfig();
    this.ui.configPanel = builder.createConfigPanel(config, this.moduleId);
    this.ui.container.appendChild(this.ui.configPanel);

    // Check if module should be enabled (from localStorage checkbox if exists)
    const enabledKey = `${this.moduleId}_enabled`;
    const storedEnabled = localStorage.getItem(enabledKey);
    if (storedEnabled !== null) {
      this.enabled = storedEnabled === "true";
    }

    // Append to container
    container.appendChild(this.ui.container);

    // Update initial status
    this.updateStatus(this.connected);
  }

  /**
   * Toggle config panel visibility
   */
  toggleConfigPanel() {
    if (!this.ui.configPanel) return;
    this.ui.configPanel.classList.toggle("collapsed");
  }

  /**
   * Toggle control modal visibility
   */
  toggleControlModal() {
    if (!this.ui.controlModal) return;

    const isHidden = this.ui.controlModal.style.display === "none";
    this.ui.controlModal.style.display = isHidden ? "flex" : "none";
  }

  /**
   * Update connection status (updates UI indicator)
   * @param {boolean} connected - Connection status
   */
  updateStatus(connected) {
    this.connected = connected;

    if (this.ui.statusIndicator) {
      if (connected) {
        this.ui.statusIndicator.classList.add("connected");
        this.ui.statusIndicator.classList.remove("disconnected");
      } else {
        this.ui.statusIndicator.classList.remove("connected");
        this.ui.statusIndicator.classList.add("disconnected");
      }
    }
  }

  /**
   * Connect to external service
   * Calls doConnect() which must be implemented by subclass
   */
  async connect() {
    if (this.connected) {
      this.log(`⚠️ Module ${this.moduleId} already connected`);
      return;
    }

    try {
      await this.doConnect();
      this.updateStatus(true);
    } catch (error) {
      this.updateStatus(false);
      throw error;
    }
  }

  /**
   * Disconnect from external service
   * Calls doDisconnect() which must be implemented by subclass
   */
  async disconnect() {
    if (!this.connected) {
      return;
    }

    try {
      await this.doDisconnect();
      this.updateStatus(false);
    } catch (error) {
      this.updateStatus(false);
      throw error;
    }
  }

  /**
   * Check if module is connected
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Check if module is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Set module enabled state
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    const enabledKey = `${this.moduleId}_enabled`;
    localStorage.setItem(enabledKey, enabled.toString());
  }

  /**
   * Handle enable checkbox change
   * @param {boolean} enabled
   */
  async handleEnableChange(enabled) {
    this.setEnabled(enabled);

    if (enabled) {
      this.log(`✅ ${this.getDisplayName()} enabled`);
      try {
        await this.connect();
      } catch (error) {
        this.log(`❌ Failed to connect: ${error.message}`);
      }
    } else {
      this.log(`⚠️ ${this.getDisplayName()} disabled`);
      try {
        await this.disconnect();
      } catch (error) {
        this.log(`❌ Failed to disconnect: ${error.message}`);
      }
    }
  }

  /**
   * Establish connection - OVERRIDE IN SUBCLASS
   */
  async doConnect() {
    throw new Error(`Module ${this.moduleId} must implement doConnect()`);
  }

  /**
   * Close connection - OVERRIDE IN SUBCLASS
   */
  async doDisconnect() {
    throw new Error(`Module ${this.moduleId} must implement doDisconnect()`);
  }

  /**
   * Wait for WebSocket connection to establish
   * Shared helper for WebSocket-based modules
   * @param {WebSocket} ws - WebSocket instance to wait for
   * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
   * @returns {Promise<void>} - Resolves on OPEN, rejects on CLOSED or timeout
   */
  _waitForWebSocket(ws, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, timeoutMs);

      const checkConnection = () => {
        if (ws.readyState === WebSocket.OPEN) {
          clearTimeout(timeout);
          resolve();
        } else if (
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING
        ) {
          clearTimeout(timeout);
          reject(new Error("Connection failed"));
        } else {
          setTimeout(checkConnection, 100);
        }
      };

      checkConnection();
    });
  }

  /**
   * Schedule WebSocket reconnection
   * Shared helper for WebSocket-based modules
   * @param {string} delayConfigKey - Config key for reconnect delay (without module prefix)
   * @param {number} defaultDelay - Default delay in milliseconds
   */
  _scheduleReconnect(delayConfigKey = "reconnect_delay", defaultDelay = 5000) {
    if (!this.shouldReconnect || !this.enabled) {
      return;
    }

    const reconnectDelay = parseInt(
      this.getConfigValue(delayConfigKey, defaultDelay.toString()),
    );

    this.log(`🔄 Reconnecting in ${reconnectDelay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.log(`💥 Reconnect failed: ${err.message}`);
      });
    }, reconnectDelay);
  }

  /**
   * Cleanup WebSocket reconnect state
   * Shared helper for WebSocket-based modules
   */
  _cleanupReconnect() {
    this.shouldReconnect = false;

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Get config value from localStorage
   * @param {string} key - Config key (without module prefix)
   * @param {*} defaultValue - Default value if not found
   * @returns {*} - Stored value or default
   */
  getConfigValue(key, defaultValue = null) {
    // Check if field has custom stored_as in config schema
    const storageKey = this._getStorageKey(key);
    const stored = localStorage.getItem(storageKey);
    return stored !== null ? stored : defaultValue;
  }

  /**
   * Set config value in localStorage
   * @param {string} key - Config key (without module prefix)
   * @param {*} value - Value to store
   */
  setConfigValue(key, value) {
    // Check if field has custom stored_as in config schema
    const storageKey = this._getStorageKey(key);
    localStorage.setItem(storageKey, value.toString());
  }

  /**
   * Get the localStorage key for a config field
   * Checks config schema for custom stored_as, falls back to moduleId_key
   * @private
   */
  _getStorageKey(key) {
    const config = this.getConfig();

    // Search all sections for the field
    for (const section of Object.values(config)) {
      if (section[key] && section[key].stored_as) {
        return section[key].stored_as;
      }
    }

    // No custom stored_as, use default pattern
    return `${this.moduleId}_${key}`;
  }
}
