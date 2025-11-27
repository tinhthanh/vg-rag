/**
 * WebLLMProvider - WebGPU-accelerated LLM inference using WebLLM
 */

import type { LLMProvider, GenerateOptions } from './types';

// Dynamic import types for WebLLM
type MLCEngine = any;
type ChatCompletionMessageParam = any;
type ChatCompletion = any;
type ChatCompletionChunk = any;

export interface WebLLMProviderConfig {
  model: string;
  engineConfig?: {
    initProgressCallback?: (progress: { progress: number; text: string }) => void;
    logLevel?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  };
  chatConfig?: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
  };
}

export class WebLLMProvider implements LLMProvider {
  private engine: MLCEngine | null = null;
  private config: WebLLMProviderConfig;
  private initialized = false;
  private webGPUAvailable = false;

  constructor(config: WebLLMProviderConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Check WebGPU availability
      this.webGPUAvailable = await this.checkWebGPUAvailability();

      if (!this.webGPUAvailable) {
        throw new Error(
          'WebGPU is not available in this browser. WebLLM requires WebGPU support. ' +
          'Please use a browser with WebGPU enabled (Chrome 113+, Edge 113+) or use WllamaProvider as a fallback.'
        );
      }

      // Dynamic import of WebLLM to avoid bundling issues
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm');

      // Initialize MLCEngine with WebGPU device
      this.engine = await CreateMLCEngine(this.config.model, {
        initProgressCallback: this.config.engineConfig?.initProgressCallback,
        logLevel: (this.config.engineConfig?.logLevel === 'WARNING' ? 'WARN' : this.config.engineConfig?.logLevel) || 'ERROR',
      });

      this.initialized = true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('WebGPU') || errorMessage.includes('gpu')) {
        throw new Error(
          `WebGPU initialization failed: ${errorMessage}. ` +
          'Consider using WllamaProvider as a WASM-based fallback.'
        );
      }

      throw new Error(`Failed to initialize WebLLMProvider: ${errorMessage}`);
    }
  }

  private async checkWebGPUAvailability(): Promise<boolean> {
    try {
      if (!(navigator as any).gpu) {
        return false;
      }
      const adapter = await (navigator as any).gpu.requestAdapter();
      return adapter !== null;
    } catch (error) {
      return false;
    }
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    if (!this.initialized || !this.engine) {
      throw new Error('WebLLMProvider not initialized. Call initialize() first.');
    }

    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'user', content: prompt },
      ];

      const completion: ChatCompletion = await this.engine.chat.completions.create({
        messages,
        temperature: options?.temperature ?? this.config.chatConfig?.temperature ?? 0.7,
        top_p: options?.topP ?? this.config.chatConfig?.top_p ?? 0.9,
        max_tokens: options?.maxTokens ?? this.config.chatConfig?.max_tokens ?? 512,
        frequency_penalty: this.config.chatConfig?.frequency_penalty ?? 0,
        presence_penalty: this.config.chatConfig?.presence_penalty ?? 0,
        stop: options?.stopSequences,
      });

      const content = completion.choices[0]?.message?.content || '';
      return content;
    } catch (error) {
      throw new Error(
        `Failed to generate text: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async *generateStream(
    prompt: string,
    options?: GenerateOptions
  ): AsyncGenerator<string> {
    if (!this.initialized || !this.engine) {
      throw new Error('WebLLMProvider not initialized. Call initialize() first.');
    }

    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'user', content: prompt },
      ];

      const stream = await this.engine.chat.completions.create({
        messages,
        temperature: options?.temperature ?? this.config.chatConfig?.temperature ?? 0.7,
        top_p: options?.topP ?? this.config.chatConfig?.top_p ?? 0.9,
        max_tokens: options?.maxTokens ?? this.config.chatConfig?.max_tokens ?? 512,
        frequency_penalty: this.config.chatConfig?.frequency_penalty ?? 0,
        presence_penalty: this.config.chatConfig?.presence_penalty ?? 0,
        stop: options?.stopSequences,
        stream: true,
      });

      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to generate streaming text: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.engine) {
      try {
        await this.engine.unload();
      } catch (error) {
        console.warn('Error during WebLLM cleanup:', error);
      }
      this.engine = null;
      this.initialized = false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  static async isWebGPUAvailable(): Promise<boolean> {
    try {
      if (!(navigator as any).gpu) {
        return false;
      }
      const adapter = await (navigator as any).gpu.requestAdapter();
      return adapter !== null;
    } catch (error) {
      return false;
    }
  }

  getModelInfo(): { model: string; initialized: boolean; webGPUAvailable: boolean } {
    return {
      model: this.config.model,
      initialized: this.initialized,
      webGPUAvailable: this.webGPUAvailable,
    };
  }

  async getRuntimeStats(): Promise<string | null> {
    if (!this.engine) {
      return null;
    }
    try {
      return await this.engine.runtimeStatsText();
    } catch (error) {
      console.warn('Failed to get runtime stats:', error);
      return null;
    }
  }

  async resetChat(): Promise<void> {
    if (!this.engine) {
      throw new Error('WebLLMProvider not initialized');
    }
    try {
      await this.engine.resetChat();
    } catch (error) {
      throw new Error(
        `Failed to reset chat: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
