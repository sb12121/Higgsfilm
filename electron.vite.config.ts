import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

function copyQwenAlignmentAssets() {
  return {
    name: 'copy-qwen-alignment-assets',
    closeBundle() {
      const outputDirectory = resolve(__dirname, 'out', 'scripts')
      mkdirSync(outputDirectory, { recursive: true })
      copyFileSync(resolve(__dirname, 'scripts', 'qwen-align.py'), resolve(outputDirectory, 'qwen-align.py'))
      copyFileSync(
        resolve(__dirname, 'scripts', 'requirements-qwen-align.txt'),
        resolve(outputDirectory, 'requirements-qwen-align.txt'),
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyQwenAlignmentAssets()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          inspector: resolve(__dirname, 'src/preload/inspector.ts'),
          voiceInspector: resolve(__dirname, 'src/preload/voiceInspector.ts'),
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          inspector: resolve(__dirname, 'src/renderer/inspector.html'),
          'voice-inspector': resolve(__dirname, 'src/renderer/voice-inspector.html'),
        },
      },
    },
  },
})
