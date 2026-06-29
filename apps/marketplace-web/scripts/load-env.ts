import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// Dependency-free .env loader: Vite only injects import.meta.env in app code,
// not process.env, and we keep deps lean (no dotenv). Limited to `KEY=value`
// lines with optional quotes — no multi-line, no expansion.
export const loadEnv = (cwd: string = process.cwd()): void => {
  const envFile = resolve(cwd, '.env')
  if (!existsSync(envFile)) return
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [, key, value] = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/) ?? []
    if (key && value !== undefined && !process.env[key]) {
      process.env[key] = value.replace(/^['"]|['"]$/g, '')
    }
  }
}
