/**
 * LLM Module
 *
 * Integrates local Ollama LLM server for:
 * - Chat companion (monitoring chat and responding)
 * - Channel point reward responses
 * - Action-triggered generation
 *
 * Based on LLMConnector from connectors.js
 */

import { BaseModule } from '../base-module.js';

export class LLMModule extends BaseModule {
  constructor() {
    super();
    this.healthCheckTimer = null;
    this.lastHealthCheck = null;
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return '🤖 LLM (Ollama)';
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      connection: {
        base_url: {
          type: 'text',
          label: 'Ollama Base URL',
          default: 'http://localhost:11434',
          stored_as: 'llm_base_url',
        },
        health_check_interval: {
          type: 'number',
          label: 'Health Check Interval (ms)',
          default: 30000,
          min: 5000,
          max: 120000,
          step: 5000,
        },
      },
      model: {
        model_name: {
          type: 'select',
          label: 'Model',
          default: 'llama3.2',
          options: [], // Populated dynamically after connection
          stored_as: 'llm_model',
        },
        system_prompt: {
          type: 'textarea',
          label: 'System Prompt',
          default: 'You are a helpful Twitch chat companion. Respond naturally and conversationally.',
          stored_as: 'llm_system_prompt',
        },
      },
      generation: {
        temperature: {
          type: 'range',
          label: 'Temperature',
          default: 0.7,
          min: 0,
          max: 1,
          step: 0.1,
          stored_as: 'llm_temperature',
        },
        max_tokens: {
          type: 'number',
          label: 'Max Tokens',
          default: 512,
          min: 1,
          max: 4096,
          step: 1,
          stored_as: 'llm_max_tokens',
        },
        timeout: {
          type: 'number',
          label: 'Request Timeout (ms)',
          default: 30000,
          min: 5000,
          max: 120000,
          step: 5000,
        },
      },
      features: {
        chat_monitoring: {
          type: 'checkbox',
          label: 'Enable Chat Monitoring',
          default: false,
          stored_as: 'llm_chat_monitoring',
        },
      },
    };
  }

  /**
   * Connect to Ollama server
   */
  async doConnect() {
    const baseUrl = this.getConfigValue('base_url', 'http://localhost:11434');
    const healthCheckInterval = parseInt(this.getConfigValue('health_check_interval', '30000'));

    this.log(`🤖 Connecting to Ollama at ${baseUrl}...`);

    try {
      const healthy = await this.checkHealth();

      if (healthy) {
        this.log(`✅ Connected to Ollama at ${baseUrl}`);

        // Start periodic health checks
        if (healthCheckInterval > 0) {
          this._startHealthChecks(healthCheckInterval);
        }

        // Fetch and populate available models
        await this.populateModels();

        return true;
      } else {
        throw new Error(`Ollama server not responding at ${baseUrl}`);
      }
    } catch (error) {
      this.log(`❌ Failed to connect to Ollama: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from Ollama server
   */
  async doDisconnect() {
    this.log(`🔌 Disconnecting from Ollama...`);
    this._stopHealthChecks();
    this.log(`✅ Disconnected from Ollama`);
  }

  /**
   * Check if Ollama server is healthy
   */
  async checkHealth() {
    const baseUrl = this.getConfigValue('base_url', 'http://localhost:11434');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.lastHealthCheck = Date.now();

      const wasConnected = this.connected;
      const isHealthy = response.ok;

      if (isHealthy !== wasConnected) {
        this.updateStatus(isHealthy);

        if (isHealthy) {
          this.log(`✅ Ollama server is back online`);
        } else {
          this.log(`⚠️ Ollama server stopped responding`);
        }
      }

      return isHealthy;
    } catch (error) {
      const wasConnected = this.connected;

      if (wasConnected) {
        this.updateStatus(false);
        this.log(`⚠️ Health check failed: ${error.message}`);
      }

      return false;
    }
  }

  /**
   * Fetch available models and populate select dropdown
   */
  async populateModels() {
    const baseUrl = this.getConfigValue('base_url', 'http://localhost:11434');

    try {
      this.log(`🔍 Fetching available models from Ollama...`);

      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const models = data.models || [];

      if (models.length === 0) {
        this.log(`⚠️ No models found on Ollama server`);
        return;
      }

      // Update the model select dropdown in config panel
      const modelSelect = this.ui.configPanel?.querySelector('select[stored_as="llm_model"]');
      if (modelSelect) {
        const currentModel = this.getConfigValue('model_name', 'llama3.2');

        // Clear existing options
        modelSelect.innerHTML = '';

        // Add model options
        let hasCurrentModel = false;
        models.forEach(model => {
          const option = document.createElement('option');
          option.value = model.name;
          option.textContent = model.name;

          if (model.name === currentModel) {
            option.selected = true;
            hasCurrentModel = true;
          }

          modelSelect.appendChild(option);
        });

        // If current model not in list, add it as first option
        if (!hasCurrentModel && currentModel) {
          const option = document.createElement('option');
          option.value = currentModel;
          option.textContent = `${currentModel} (not found)`;
          option.selected = true;
          modelSelect.insertBefore(option, modelSelect.firstChild);
        }

        this.log(`✅ Loaded ${models.length} models: ${models.map(m => m.name).join(', ')}`);
      }
    } catch (error) {
      this.log(`💥 Failed to fetch models: ${error.message}`);
    }
  }

  /**
   * Generate text using Ollama chat API
   */
  async chat(messages, options = {}) {
    if (!this.isConnected()) {
      throw new Error('Not connected to Ollama server');
    }

    const baseUrl = this.getConfigValue('base_url', 'http://localhost:11434');
    const model = this.getConfigValue('model_name', 'llama3.2');
    const temperature = parseFloat(this.getConfigValue('temperature', '0.7'));
    const maxTokens = parseInt(this.getConfigValue('max_tokens', '512'));
    const timeout = parseInt(this.getConfigValue('timeout', '30000'));

    const {
      model: overrideModel,
      temperature: overrideTemp,
      maxTokens: overrideMaxTokens,
    } = options;

    const requestBody = {
      model: overrideModel || model,
      messages,
      temperature: overrideTemp !== undefined ? overrideTemp : temperature,
      max_tokens: overrideMaxTokens !== undefined ? overrideMaxTokens : maxTokens,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
      this.log(`💥 Chat failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start periodic health checks
   */
  _startHealthChecks(interval) {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      this.checkHealth();
    }, interval);
  }

  /**
   * Stop periodic health checks
   */
  _stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Get time since last successful health check
   */
  getLastHealthCheckAge() {
    if (!this.lastHealthCheck) return null;
    return Date.now() - this.lastHealthCheck;
  }

  /**
   * Provide context for actions
   */
  getContextContribution() {
    if (!this.isConnected()) {
      return { llm: null };
    }

    return {
      llm: {
        chat: this.chat.bind(this),
        isConnected: () => this.isConnected(),
        systemPrompt: this.getConfigValue('system_prompt', ''),
        connected: this.connected,
      },
    };
  }
}
