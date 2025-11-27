import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  base: './', 
  plugins: [
    wasm(),
    topLevelAwait(),
    dts({
      include: ['src/**/*'],
      exclude: [
        'src/**/*.test.ts', 
        'src/**/*.spec.ts', 
        'src/**/*.integration.test.ts'
      ],
      rollupTypes: true,
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        // Main Sandbox
        sandbox: resolve(__dirname, 'sandbox.html'), 
        // The Iframe Service
        'vg-rag-service': resolve(__dirname, 'vg-rag-service.html'),
        // New Examples
        'semantic-search': resolve(__dirname, 'examples/semantic-search-demo.html'),
        'rag-chatbot': resolve(__dirname, 'examples/rag-chatbot-demo.html'),
        // Library Entry
        index: resolve(__dirname, 'src/index.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'index') return 'index.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    },
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'BrowserVectorDB',
      formats: ['es'],
      fileName: 'index',
    },
    target: 'esnext',
    sourcemap: true,
  },
  optimizeDeps: {
    include: ['@huggingface/transformers', 'voy-search', '@mlc-ai/web-llm', '@wllama/wllama', 'penpal'],
  },
  worker: {
    format: 'es',
  },
});
