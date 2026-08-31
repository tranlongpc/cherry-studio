import { resolve } from 'node:path'

import { defineConfig } from 'electron-vite'

import baseConfig from './electron.vite.config'

const config = baseConfig as Record<string, any>

export default defineConfig({
  ...config,
  main: {
    ...config.main,
    build: {
      ...config.main.build,
      outDir: resolve(__dirname, 'out-client/main'),
      lib: { entry: resolve(__dirname, 'packages/desktop-client/src/main.ts') },
      rollupOptions: {
        ...config.main.build.rollupOptions,
        output: {
          entryFileNames: 'main.js'
        }
      }
    }
  },
  preload: {
    ...config.preload,
    build: {
      ...config.preload.build,
      outDir: resolve(__dirname, 'out-client/preload'),
      rollupOptions: {
        ...config.preload.build.rollupOptions,
        input: {
          remoteClient: resolve(__dirname, 'packages/desktop-client/src/preload.ts')
        }
      }
    }
  },
  renderer: {
    ...config.renderer,
    build: {
      ...config.renderer.build,
      outDir: resolve(__dirname, 'out-client/renderer'),
      rollupOptions: {
        ...config.renderer.build.rollupOptions,
        input: {
          remoteClient: resolve(__dirname, 'src/renderer/windows/remoteClient/index.html')
        }
      }
    }
  }
})
