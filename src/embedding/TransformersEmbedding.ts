import { pipeline, env } from '@huggingface/transformers';
import type { EmbeddingGenerator } from './types.js';

export interface TransformersEmbeddingConfig {
  model: string;
  device?: 'wasm' | 'webgpu';
  cache?: boolean;
  quantized?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  progressCallback?: (progress: any) => void;
}

export class TransformersEmbedding implements EmbeddingGenerator {
  private pipeline: any = null;
  private config: Required<TransformersEmbeddingConfig>;
  private dimensions: number = 0;
  private initialized: boolean = false;

  constructor(config: TransformersEmbeddingConfig) {
    this.config = {
      device: 'wasm',
      cache: true,
      quantized: true,
      maxRetries: 3,
      retryDelay: 1000,
      progressCallback: () => {}, 
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.cache) {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
    }

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      try {
        this.pipeline = await this.loadPipeline(this.config.device);
        const testEmbedding = await this.generateEmbedding('test');
        this.dimensions = testEmbedding.length;
        this.initialized = true;
        return;
      } catch (error) {
        lastError = error as Error;
        attempt++;
        if (this.config.device === 'webgpu' && attempt === 1) {
          console.warn('WebGPU failed, fallback to WASM');
          this.config.device = 'wasm';
          continue;
        }
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }
    throw new Error(`Failed to init model: ${lastError?.message}`);
  }

  private async loadPipeline(device: 'wasm' | 'webgpu'): Promise<any> {
    const options: any = {
      quantized: this.config.quantized,
      progress_callback: this.config.progressCallback,
    };
    if (device === 'webgpu') options.device = 'webgpu';
    
    return await pipeline('feature-extraction', this.config.model, options);
  }

  async embed(text: string): Promise<Float32Array> {
    this.ensureInitialized();
    return await this.generateEmbedding(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.ensureInitialized();
    if (texts.length === 0) return [];
    const embeddings: Float32Array[] = [];
    for (const text of texts) {
      embeddings.push(await this.generateEmbedding(text));
    }
    return embeddings;
  }

  async embedImage(_image: ImageData | Blob): Promise<Float32Array> {
    throw new Error("Not implemented in this fix script"); 
  }

  getDimensions(): number {
    if (!this.initialized) throw new Error('Not initialized');
    return this.dimensions;
  }

  async dispose(): Promise<void> {
    this.pipeline = null;
    this.initialized = false;
    this.dimensions = 0;
  }

  private async generateEmbedding(text: string): Promise<Float32Array> {
    if (!this.pipeline) throw new Error('Pipeline not initialized');
    const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
    return this.extractEmbedding(output);
  }

  private extractEmbedding(output: any): Float32Array {
    if (output instanceof Float32Array) return output;
    if (output.data instanceof Float32Array) return output.data;
    if (Array.isArray(output.data)) return new Float32Array(output.data);
    if (output.tolist) return new Float32Array(output.tolist()[0] || output.tolist());
    throw new Error('Unexpected output format');
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error('Not initialized');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
