/**
 * Module Manager
 *
 * Central registry and lifecycle manager for all Teammater modules.
 * Handles module initialization, connection, and UI registration.
 *
 * Usage:
 *   const manager = new ModuleManager();
 *   manager.register('llm', new LLMModule(config));
 *   await manager.initializeAll();
 *   await manager.connectAll();
 */

export class ModuleManager {
  constructor() {
    this.modules = new Map(); // module_id -> module instance
    this.initialized = false;
    this.log = console.log;
  }

  /**
   * Set logging function
   * @param {Function} logFn - Logging function
   */
  setLogger(logFn) {
    this.log = logFn;
  }

  /**
   * Register a module
   * @param {string} id - Unique module identifier (e.g., 'llm', 'twitch-chat')
   * @param {BaseModule} module - Module instance extending BaseModule
   */
  register(id, module) {
    if (this.modules.has(id)) {
      this.log(`⚠️ Module ${id} already registered, replacing...`);
    }

    module.setModuleId(id);
    module.setLogger(this.log);
    module.moduleManager = this; // Give module access to ModuleManager
    this.modules.set(id, module);
    this.log(`📦 Registered module: ${id}`);
  }

  /**
   * Unregister a module
   * @param {string} id - Module identifier
   */
  unregister(id) {
    const module = this.modules.get(id);
    if (module) {
      module.disconnect();
      this.modules.delete(id);
      this.log(`🗑️ Unregistered module: ${id}`);
    }
  }

  /**
   * Get module by ID
   * @param {string} id - Module identifier
   * @returns {BaseModule|null} - Module instance or null
   */
  get(id) {
    return this.modules.get(id) || null;
  }

  /**
   * Get all registered modules
   * @returns {Array<{id: string, module: BaseModule}>} - Array of {id, module} objects
   */
  getAll() {
    return Array.from(this.modules.entries()).map(([id, module]) => ({
      id,
      module,
    }));
  }

  /**
   * Initialize all modules (render UI, setup event listeners)
   * @param {HTMLElement} container - Container element for module UI
   */
  async initializeAll(container) {
    this.log(`🚀 Initializing ${this.modules.size} modules...`);

    for (const [id, module] of this.modules.entries()) {
      try {
        await module.initialize(container);
        this.log(`✅ Initialized module: ${id}`);
      } catch (error) {
        this.log(`💥 Failed to initialize module ${id}: ${error.message}`);
        console.error(`Module ${id} initialization error:`, error);
      }
    }

    this.initialized = true;
    this.log(`✅ All modules initialized`);
  }

  /**
   * Connect all modules (establish external connections)
   * @param {Object} options - Connection options
   * @param {boolean} options.respectEnabled - Only connect enabled modules (default: true)
   */
  async connectAll(options = {}) {
    const { respectEnabled = true } = options;

    if (!this.initialized) {
      this.log(`⚠️ Modules not initialized, call initializeAll() first`);
      return;
    }

    this.log(`🔌 Connecting modules...`);

    for (const [id, module] of this.modules.entries()) {
      // Skip if module is disabled and we respect enabled state
      if (respectEnabled && !module.isEnabled()) {
        this.log(`⏭️ Skipping disabled module: ${id}`);
        continue;
      }

      try {
        await module.connect();
        this.log(`✅ Connected module: ${id}`);
      } catch (error) {
        this.log(`💥 Failed to connect module ${id}: ${error.message}`);
        console.error(`Module ${id} connection error:`, error);
      }
    }

    this.log(`✅ Module connection complete`);
  }

  /**
   * Disconnect all modules
   */
  async disconnectAll() {
    this.log(`🔌 Disconnecting all modules...`);

    for (const [id, module] of this.modules.entries()) {
      try {
        await module.disconnect();
        this.log(`✅ Disconnected module: ${id}`);
      } catch (error) {
        this.log(`💥 Failed to disconnect module ${id}: ${error.message}`);
      }
    }

    this.log(`✅ All modules disconnected`);
  }

  /**
   * Get all connected modules
   * @returns {Array<{id: string, module: BaseModule}>} - Connected modules
   */
  getConnectedModules() {
    return this.getAll().filter(({ module }) => module.isConnected());
  }

  /**
   * Get all enabled modules
   * @returns {Array<{id: string, module: BaseModule}>} - Enabled modules
   */
  getEnabledModules() {
    return this.getAll().filter(({ module }) => module.isEnabled());
  }

  /**
   * Build execution context for actions from all connected modules
   * @param {Object} baseContext - Base context to extend
   * @returns {Object} - Context object with all module connectors and helpers
   */
  buildActionContext(baseContext = {}) {
    const context = { ...baseContext };

    // Add each connected module to context
    for (const [id, module] of this.modules.entries()) {
      if (module.isConnected()) {
        // Add module's context contribution
        const moduleContext = module.getContextContribution();
        Object.assign(context, moduleContext);
      }
    }

    return context;
  }

  /**
   * Destroy all modules and cleanup
   */
  async destroy() {
    await this.disconnectAll();
    this.modules.clear();
    this.initialized = false;
    this.log(`🗑️ Module manager destroyed`);
  }
}
