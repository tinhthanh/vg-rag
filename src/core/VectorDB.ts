import { IndexedDBStorage } from '../storage/IndexedDBStorage';
import { IndexManager } from '../index/IndexManager';
import { TransformersEmbedding } from '../embedding/TransformersEmbedding';
import { PerformanceOptimizer } from '../performance/PerformanceOptimizer';
import type { VectorDBConfig, InsertData, ExportData, ExportOptions, ImportOptions } from './types';
import type { SearchQuery, SearchResult } from '../index/types';
import type { StorageManager, VectorRecord } from '../storage/types';
import type { EmbeddingGenerator } from '../embedding/types';
import { VectorDBError, DimensionMismatchError, InputValidator } from '../errors';

/**
 * VectorDB - Main API for browser-based vector database operations
 */
export class VectorDB {
  private initialized = false;
  private storage: StorageManager | null = null;
  private indexManager: IndexManager | null = null;
  private embeddingGenerator: EmbeddingGenerator | null = null;
  private performanceOptimizer: PerformanceOptimizer;

  constructor(private config: VectorDBConfig) {
    // Validate config (simplified)
    if (!config.storage?.dbName) throw new Error("dbName required");
    this.performanceOptimizer = new PerformanceOptimizer(config.performance);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize storage
      const storage = new IndexedDBStorage(this.config.storage);
      await storage.initialize();
      this.storage = storage;

      // Initialize optimizer
      await this.performanceOptimizer.initialize(this.storage);

      // Initialize index
      this.indexManager = new IndexManager({
        dimensions: this.config.index.dimensions,
        metric: this.config.index.metric,
        storage: this.storage,
      });
      await this.indexManager.initialize();
      this.performanceOptimizer.markIndexLoaded();

      // Initialize embedding with PROGRESS CALLBACK FIX
      this.embeddingGenerator = new TransformersEmbedding({
        model: this.config.embedding.model,
        device: this.config.embedding.device,
        cache: this.config.embedding.cache ?? true,
        quantized: this.config.embedding.quantized,
        progressCallback: this.config.embedding.progressCallback,
      });
      
      await this.embeddingGenerator.initialize();
      this.performanceOptimizer.markModelsLoaded();

      // Check dimensions
      const modelDim = this.embeddingGenerator.getDimensions();
      if (modelDim !== this.config.index.dimensions) {
        throw new DimensionMismatchError(this.config.index.dimensions, modelDim);
      }

      this.initialized = true;
    } catch (error) {
      await this.dispose();
      throw error instanceof VectorDBError ? error : new VectorDBError('Failed to initialize VectorDB', 'INIT_ERROR', { error });
    }
  }

  async insert(data: InsertData): Promise<string> {
    this.ensureInitialized();
    
    const sanitizedMetadata = InputValidator.validateAndSanitizeMetadata(data.metadata);
    const vector = await this.prepareVector(data);
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 9);

    const record: VectorRecord = {
      id,
      vector,
      metadata: { ...sanitizedMetadata, content: data.text, timestamp: Date.now() },
      timestamp: Date.now(),
    };

    if (this.performanceOptimizer.batchOptimizer) {
        await this.performanceOptimizer.batchOptimizer.put(record);
    } else {
        await this.storage!.put(record);
    }

    // Cache & Index
    const size = record.vector.byteLength + JSON.stringify(record.metadata).length * 2;
    this.performanceOptimizer.vectorCache.set(id, record, size);
    await this.indexManager!.add(record);

    return id;
  }

  async insertBatch(data: InsertData[]): Promise<string[]> {
    this.ensureInitialized();
    const records: VectorRecord[] = [];
    const ids: string[] = [];

    for(const item of data) {
        const sanitizedMetadata = InputValidator.validateAndSanitizeMetadata(item.metadata);
        const vector = await this.prepareVector(item);
        const id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
        
        const record = {
            id, vector, 
            metadata: {...sanitizedMetadata, content: item.text, timestamp: Date.now()}, 
            timestamp: Date.now()
        };
        
        records.push(record);
        ids.push(id);

        const size = record.vector.byteLength + JSON.stringify(record.metadata).length * 2;
        this.performanceOptimizer.vectorCache.set(id, record, size);
    }

    await this.storage!.putBatch(records);
    await this.indexManager!.addBatch(records);
    return ids;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    this.ensureInitialized();
    InputValidator.validateSearchQuery(query.k);

    let queryVector: Float32Array;
    
    if (query.vector) {
        queryVector = query.vector;
    } else if (query.text) {
        const cached = this.performanceOptimizer.getCachedEmbedding(query.text);
        if (cached) {
            queryVector = cached;
        } else {
            queryVector = await this.embeddingGenerator!.embed(query.text);
            this.performanceOptimizer.cacheEmbedding(query.text, queryVector);
        }
    } else {
        throw new Error("Query must have text or vector");
    }

    InputValidator.validateVector(queryVector, this.config.index.dimensions);
    
    const results = await this.indexManager!.search(queryVector, query.k, query.filter);

    // Enrich results with vectors if requested
    if (query.includeVectors) {
        for (const result of results) {
            const record = await this.performanceOptimizer.getVector(result.id, this.storage!);
            if (record) result.vector = record.vector;
        }
    }

    return results;
  }

  async delete(id: string): Promise<boolean> {
    this.ensureInitialized();
    let deleted = false;

    if (this.performanceOptimizer.batchOptimizer) {
        deleted = await this.performanceOptimizer.batchOptimizer.delete(id);
    } else {
        deleted = await this.storage!.delete(id);
    }

    if (deleted) {
        this.performanceOptimizer.vectorCache.delete(id);
        await this.indexManager!.remove(id);
    }
    return deleted;
  }

  async update(id: string, data: Partial<InsertData>): Promise<boolean> {
    this.ensureInitialized();
    const existing = await this.storage!.get(id);
    if (!existing) return false;

    let vector = existing.vector;
    if (data.vector || data.text) {
        vector = await this.prepareVector(data as InsertData);
    }

    const updatedRecord: VectorRecord = {
        id,
        vector,
        metadata: { 
            ...existing.metadata, 
            ...(data.metadata || {}), 
            content: data.text || existing.metadata.content,
            timestamp: Date.now()
        },
        timestamp: Date.now()
    };

    await this.storage!.put(updatedRecord);
    await this.indexManager!.remove(id);
    await this.indexManager!.add(updatedRecord);
    
    return true;
  }

  async clear(): Promise<void> {
    this.ensureInitialized();
    if (this.performanceOptimizer.batchOptimizer) {
        await this.performanceOptimizer.batchOptimizer.flush();
    }
    await this.storage!.clear();
    await this.indexManager!.clear();
    this.performanceOptimizer.clearCaches();
  }

  async size(): Promise<number> {
    this.ensureInitialized();
    return await this.storage!.count();
  }

  // Full Export Implementation
  async export(options: ExportOptions = {}): Promise<ExportData> {
    this.ensureInitialized();
    const { includeIndex = true, onProgress } = options;

    if (this.performanceOptimizer.batchOptimizer) {
        await this.performanceOptimizer.batchOptimizer.flush();
    }

    const count = await this.storage!.count();
    const allRecords: VectorRecord[] = [];
    let loaded = 0;

    await this.performanceOptimizer.progressiveLoader.streamProcess(
        this.storage!,
        async (record) => {
            allRecords.push(record);
            loaded++;
            if (onProgress && loaded % 100 === 0) onProgress(loaded, count);
        }
    );

    if (onProgress) onProgress(count, count);

    let serializedIndex = '';
    if (includeIndex) {
        serializedIndex = await this.indexManager!.serialize();
    }

    return {
        version: '1.0.0',
        config: this.config,
        vectors: allRecords.map(r => ({
            id: r.id,
            vector: Array.from(r.vector),
            metadata: r.metadata,
            timestamp: r.timestamp
        })),
        index: serializedIndex,
        metadata: {
            exportedAt: Date.now(),
            vectorCount: count,
            dimensions: this.config.index.dimensions
        }
    };
  }

  // Full Import Implementation
  async import(data: ExportData, options: ImportOptions = {}): Promise<void> {
    this.ensureInitialized();
    const { validateSchema = true, onProgress, clearExisting = true } = options;

    if (validateSchema) {
        if (data.metadata.dimensions !== this.config.index.dimensions) {
            throw new DimensionMismatchError(this.config.index.dimensions, data.metadata.dimensions);
        }
    }

    if (clearExisting) await this.clear();

    const records: VectorRecord[] = data.vectors.map(v => ({
        id: v.id,
        vector: new Float32Array(v.vector),
        metadata: v.metadata,
        timestamp: v.timestamp || Date.now()
    }));

    await this.performanceOptimizer.progressiveLoader.importInBatches(
        this.storage!,
        records,
        onProgress
    );

    if (data.index) {
        try {
            await this.indexManager!.deserialize(data.index);
        } catch (e) {
            console.warn("Index restore failed, rebuilding...", e);
            // Rebuild logic simplified for brevity
            await this.indexManager!.clear();
            await this.indexManager!.addBatch(records);
        }
    } else {
        await this.indexManager!.addBatch(records);
    }
  }

  // Performance Proxy Methods
  getPerformanceStats() {
    return this.performanceOptimizer.getStats();
  }

  clearCaches() {
    this.performanceOptimizer.clearCaches();
  }

  async dispose(): Promise<void> {
    if (this.embeddingGenerator) await this.embeddingGenerator.dispose();
    if (this.performanceOptimizer) await this.performanceOptimizer.dispose();
    if (this.storage) {
        // Cast to access close if needed, though usually handled by optimizer or left open
        // (this.storage as any).close(); 
    }
    this.initialized = false;
  }

  private async prepareVector(data: InsertData): Promise<Float32Array> {
    if (data.vector) {
        InputValidator.validateVector(data.vector, this.config.index.dimensions);
        return data.vector;
    }
    if (data.text) {
        const cached = this.performanceOptimizer.getCachedEmbedding(data.text);
        if (cached) return cached;
        
        const vector = await this.embeddingGenerator!.embed(data.text);
        InputValidator.validateVector(vector, this.config.index.dimensions);
        this.performanceOptimizer.cacheEmbedding(data.text, vector);
        return vector;
    }
    throw new Error("No text or vector provided");
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new VectorDBError('Not initialized', 'NOT_INIT');
  }
}
