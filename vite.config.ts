import { join } from 'node:path'
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'
import { loadContent } from './src/content/load-node'

const VIRTUAL = 'virtual:lifesim-content'

/**
 * Compiles and validates the `content/` directory at build time and serves it to the app as one
 * module. A content error fails the build with the full list of problems; in development, editing
 * a content file reloads the page.
 */
function lifesimContent(): Plugin {
  let dir = join(process.cwd(), 'content')
  return {
    name: 'lifesim-content',
    configResolved(config) {
      dir = join(config.root, 'content')
    },
    resolveId(id) {
      return id === VIRTUAL ? '\0' + VIRTUAL : undefined
    },
    load(id) {
      if (id !== '\0' + VIRTUAL) return undefined
      return `export default ${JSON.stringify(loadContent(dir))}`
    },
    configureServer(server) {
      server.watcher.add(dir)
      server.watcher.on('change', (file) => {
        if (!file.startsWith(dir)) return
        for (const mod of server.moduleGraph.getModulesByFile('\0' + VIRTUAL) ?? []) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [preact(), lifesimContent()],
  worker: { format: 'es', plugins: () => [lifesimContent()] },
})
