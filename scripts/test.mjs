import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Windows cmd.exe does not expand globs for Node 22's test runner.
const directory = new URL('../test/', import.meta.url)
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort().map(name => fileURLToPath(new URL(name, directory)))
if (files.length === 0) throw new Error('no test files found')
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', shell: false, windowsHide: true })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.once('error', () => { process.exitCode = 1 })
child.once('close', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
