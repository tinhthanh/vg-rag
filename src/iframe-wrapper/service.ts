import { WindowMessenger, connect } from 'penpal';
import { 
  VectorDB, 
  RAGPipelineManager, 
  WebLLMProvider, 
  TransformersEmbedding 
} from '../index';

let db: VectorDB | null = null;
let ragPipeline: RAGPipelineManager | null = null;
let llmProvider: any = null;
let embeddingGenerator: any = null;

const methods = {
  async initialize(config: any) {
    const parent = await connection.promise;
    
    try {
      db = new VectorDB(config.dbConfig);
      await db.initialize();

      if (config.llmConfig) {
        // @ts-ignore
        if(parent.log) parent.log(`Init LLM: ${config.llmConfig.model}`);
        
        const webLLMConfig = {
          ...config.llmConfig,
          engineConfig: {
              ...config.llmConfig.engineConfig,
              initProgressCallback: (report: any) => {
                  // @ts-ignore
                  if (parent.onProgress) {
                      // @ts-ignore
                      parent.onProgress({ 
                          status: report.text, 
                          percent: report.progress * 100 
                      });
                  }
              }
          }
        };
        
        llmProvider = new WebLLMProvider(webLLMConfig);
        await llmProvider.initialize();
      }

      if (config.embeddingConfig) {
        // @ts-ignore
        if(parent.log) parent.log(`Init Embed: ${config.embeddingConfig.model}`);
        embeddingGenerator = new TransformersEmbedding(config.embeddingConfig);
        await embeddingGenerator.initialize();
      }

      if (db && llmProvider && embeddingGenerator) {
        ragPipeline = new RAGPipelineManager({
          vectorDB: db,
          llmProvider,
          embeddingGenerator
        });
      }

      return { success: true };
    } catch (error: any) {
      console.error(error);
      // @ts-ignore
      if(parent.log) parent.log("Init Error: " + error.message);
      throw error;
    }
  },

  async insertDocuments(documents: any[]) {
    if (!db) throw new Error('DB not ready');
    const ids = await db.insertBatch(documents);
    return { success: true, count: ids.length, ids };
  },

  async getAllDocuments() {
    if (!db) return [];
    try {
      const data = await db.export({ includeIndex: false });
      return data.vectors.map((v: any) => ({
        id: v.id,
        metadata: v.metadata,
      }));
    } catch (e) {
      console.error(e);
      return [];
    }
  },

  async deleteDocument(id: string) {
    if (!db) throw new Error('DB not ready');
    await db.delete(id);
    return { success: true };
  },

  async ragQuery(query: string, options: any = {}) {
    if (!ragPipeline) throw new Error('RAG Pipeline not ready');
    const parent = await connection.promise;

    try {
      const stream = ragPipeline.queryStream(query, options);
      let firstToken = true;

      for await (const chunk of stream) {
        if (chunk.type === 'retrieval') {
          // @ts-ignore
          if (parent.onEvent) await parent.onEvent({ type: 'retrieval', sources: chunk.sources });
        } else if (chunk.type === 'generation') {
          if (firstToken) {
              // @ts-ignore
              if (parent.onToken) await parent.onToken(""); 
              firstToken = false;
          }
          // @ts-ignore
          if (parent.onToken) await parent.onToken(chunk.content);
        }
      }
    } catch (e: any) {
        console.error(e);
        throw e;
    } finally {
        // @ts-ignore
        if (parent.onComplete) await parent.onComplete({ status: 'done' });
    }
    
    return { success: true };
  },

  async getStats() {
    return { docCount: db ? await db.size() : 0 };
  }
};

const messenger = new WindowMessenger({ remoteWindow: window.parent });
const connection = connect({ messenger, methods });
