import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// `electron` is provided by the runtime and must never be bundled.
// The Discord RPC lib talks to a local IPC socket — keep it external so its
// transports/sub-deps resolve at runtime instead of being bundled.
const external = [
  'electron',
  '@xhayper/discord-rpc',
  '@homebridge/node-pty-prebuilt-multiarch',
  // ssh2 pulls in optional native addons (cpu-features) — keep it external so
  // those resolve (or gracefully no-op) at runtime instead of being bundled.
  'ssh2',
  'cpu-features',
  // Remote-control server deps: ws is pure JS (with optional native speedups we
  // don't require); cloudflared spawns an external binary it manages itself.
  'ws',
  'cloudflared'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external,
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external,
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // @pierre/diffs highlights in module workers (Shiki code-splits), which
    // Vite's default iife worker format cannot bundle.
    worker: { format: 'es' },
    plugins: [react()]
  }
})
