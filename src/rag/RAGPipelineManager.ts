/**
 * RAGPipelineManager - Orchestrates retrieval and generation for RAG workflows
 */

import type { VectorDB } from '../core/VectorDB';
import type { LLMProvider } from '../llm/types';
import type { EmbeddingGenerator } from '../embedding/types';
import type { SearchResult } from '../index/types';
import type { RAGPipeline, RAGOptions, RAGResult, RAGStreamChunk } from './types';
import { VectorDBError } from '../errors';

export interface RAGPipelineConfig {
  vectorDB: VectorDB;
  llmProvider: LLMProvider;
  embeddingGenerator: EmbeddingGenerator;
  defaultContextTemplate?: string;
  defaultMaxContextTokens?: number;
  defaultSystemPrompt?: string;
}

export interface ExtendedRAGOptions extends RAGOptions {
    systemPrompt?: string;
}

export class RAGPipelineManager implements RAGPipeline {
  private vectorDB: VectorDB;
  private llmProvider: LLMProvider;
  private embeddingGenerator: EmbeddingGenerator;
  private defaultContextTemplate: string;
  private defaultMaxContextTokens: number;
  private defaultSystemPrompt: string;

  constructor(config: RAGPipelineConfig) {
    this.vectorDB = config.vectorDB;
    this.llmProvider = config.llmProvider;
    this.embeddingGenerator = config.embeddingGenerator;
    // Sử dụng trực tiếp giá trị mặc định ở đây thay vì gọi hàm riêng
    this.defaultContextTemplate = config.defaultContextTemplate || `Tài liệu {index}:\n{content}`;
    this.defaultMaxContextTokens = config.defaultMaxContextTokens || 2000;
    this.defaultSystemPrompt = config.defaultSystemPrompt || 
      `Bạn là một trợ lý AI hữu ích. Hãy sử dụng thông tin được cung cấp trong phần "Ngữ cảnh" bên dưới để trả lời câu hỏi của người dùng.\nNếu ngữ cảnh không chứa thông tin để trả lời, hãy nói rằng bạn không biết, đừng cố bịa ra câu trả lời.\nHãy trả lời ngắn gọn, súc tích và bằng Tiếng Việt.`;
  }

  async query(query: string, options?: ExtendedRAGOptions): Promise<RAGResult> {
    try {
      const retrievalStart = Date.now();
      const sources = await this.retrieve(query, options);
      const retrievalTime = Date.now() - retrievalStart;

      const context = this.formatContext(sources, options);
      const truncatedContext = this.truncateContext(
        context,
        options?.maxContextTokens || this.defaultMaxContextTokens
      );

      const systemPrompt = options?.systemPrompt || this.defaultSystemPrompt;
      const prompt = this.buildPrompt(query, truncatedContext, systemPrompt);

      const generationStart = Date.now();
      const answer = await this.llmProvider.generate(prompt, options?.generateOptions);
      const generationTime = Date.now() - generationStart;

      const tokensGenerated = this.estimateTokenCount(answer);
      const contextLength = this.estimateTokenCount(truncatedContext);

      return {
        answer,
        sources: options?.includeSourcesInResponse !== false ? sources : [],
        metadata: {
          retrievalTime,
          generationTime,
          tokensGenerated,
          contextLength,
        },
      };
    } catch (error) {
      throw new VectorDBError('Failed to execute RAG query', 'RAG_QUERY_ERROR', { error, query });
    }
  }

  async *queryStream(query: string, options?: ExtendedRAGOptions): AsyncGenerator<RAGStreamChunk> {
    try {
      const retrievalStart = Date.now();
      const sources = await this.retrieve(query, options);
      const retrievalTime = Date.now() - retrievalStart;

      yield {
        type: 'retrieval',
        content: '',
        sources: options?.includeSourcesInResponse !== false ? sources : [],
        metadata: { retrievalTime },
      };

      const context = this.formatContext(sources, options);
      const truncatedContext = this.truncateContext(
        context,
        options?.maxContextTokens || this.defaultMaxContextTokens
      );

      const systemPrompt = options?.systemPrompt || this.defaultSystemPrompt;
      const prompt = this.buildPrompt(query, truncatedContext, systemPrompt);

      const generationStart = Date.now();
      
      for await (const chunk of this.llmProvider.generateStream(prompt, options?.generateOptions)) {
        yield {
          type: 'generation',
          content: chunk,
        };
      }

      const generationTime = Date.now() - generationStart;

      yield {
        type: 'complete',
        content: '',
        metadata: {
          retrievalTime,
          generationTime,
        },
      };
    } catch (error) {
      throw new VectorDBError('Failed to execute streaming RAG query', 'RAG_STREAM_ERROR', { error, query });
    }
  }

  private async retrieve(query: string, options?: RAGOptions): Promise<SearchResult[]> {
    const queryVector = await this.embeddingGenerator.embed(query);
    return await this.vectorDB.search({
      vector: queryVector,
      k: options?.topK || 5,
      filter: options?.filter,
      includeVectors: false,
    });
  }

  private formatContext(results: SearchResult[], options?: RAGOptions): string {
    if (results.length === 0) return 'Không tìm thấy thông tin liên quan.';
    const template = options?.contextTemplate || this.defaultContextTemplate;
    return results.map((result, index) => this.applyTemplate(template, result, index)).join('\n\n');
  }

  private applyTemplate(template: string, result: SearchResult, index: number): string {
    let formatted = template;
    formatted = formatted.replace(/\{index\}/g, String(index + 1));
    formatted = formatted.replace(/\{score\}/g, result.score.toFixed(4));
    formatted = formatted.replace(/\{content\}/g, result.metadata.content || '');
    formatted = formatted.replace(/\{title\}/g, result.metadata.title || '');
    formatted = formatted.replace(/\{url\}/g, result.metadata.url || '');
    formatted = formatted.replace(/\{id\}/g, result.id);
    formatted = formatted.replace(/\{metadata\.(\w+)\}/g, (_match, field) => {
      return result.metadata[field] !== undefined ? String(result.metadata[field]) : '';
    });
    return formatted;
  }

  private buildPrompt(query: string, context: string, systemPrompt: string): string {
    return `${systemPrompt}

Ngữ cảnh:
${context}

Câu hỏi: ${query}

Trả lời:`;
  }

  private truncateContext(context: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (context.length <= maxChars) return context;
    const truncated = context.substring(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutoff = Math.max(lastPeriod, lastNewline);
    if (cutoff > maxChars * 0.8) return truncated.substring(0, cutoff + 1) + '\n\n[Context truncated...]';
    return truncated + '...\n\n[Context truncated...]';
  }

  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  setContextTemplate(template: string): void {
    this.defaultContextTemplate = template;
  }

  setMaxContextTokens(maxTokens: number): void {
    this.defaultMaxContextTokens = maxTokens;
  }

  getConfig() {
    return {
      defaultContextTemplate: this.defaultContextTemplate,
      defaultMaxContextTokens: this.defaultMaxContextTokens,
    };
  }
}
