import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return null
          if (id.includes('react-markdown') || id.includes('remark-gfm') || id.includes('react-syntax-highlighter')) {
            return 'markdown'
          }
          if (id.includes('pdfjs-dist')) {
            return 'pdf'
          }
          if (id.includes('exceljs') || id.includes('mammoth')) {
            return 'attachments'
          }
          return null
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
