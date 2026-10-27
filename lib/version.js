import { readFileSync } from 'node:fs'

// The packaged manifest is the single source for CLI and MCP release identity.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
