import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default {
  plugins: {
    // Absolute path: Tailwind discovers its config from the process cwd, and
    // the root vite.config.ts runs from the repo root, where no config exists.
    tailwindcss: { config: path.join(here, 'tailwind.config.ts') },
    autoprefixer: {},
  },
}
