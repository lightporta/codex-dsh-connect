import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { parse, main } from './cli.js'
import { generateCodexConfig } from './setup.js'
import { canonicalWorkspace } from './project-tools.mjs'
import { buildWslLaunch } from './windows-wsl.mjs'
import { VERSION } from './version.js'

const KEYS = ['workspace', 'installation', 'credentialFile', 'maxRequests', 'timeoutMs', 'wslDistro', 'wslNode', 'wslCli']
const FLAGS = { workspace: '--workspace', installation: '--dsh-root', credentialFile: '--credential-file', maxRequests: '--max-requests', timeoutMs: '--timeout-ms' }
const HELP = `codex-dsh-connect plugin ${VERSION}

  configure --workspace /absolute/project [options]  Save one explicitly authorized workspace
  status                                           Check saved settings without model requests
  mcp                                              Start the bundled stdio MCP server

Options: --dsh-root, --credential-file, --max-requests, --timeout-ms
Windows WSL2: --wsl-distro, --wsl-node, --wsl-cli and --dsh-root (Linux paths)
  --settings-file /absolute/plugin.json  Override the connector settings file
  --force                               Back up and replace an existing settings file

Default settings: ~/.config/codex-dsh-connect/plugin.json
Settings contain paths and limits only, never credential contents. Restart the
plugin after configuring it. No workspace is inferred from the current directory.
`

export function pluginSettingsPath(value, home = homedir()) {
  const path = value ?? join(home, '.config', 'codex-dsh-connect', 'plugin.json')
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('invalid plugin settings path')
  return resolve(path)
}

export function validatePluginSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || Object.keys(value).some(key => key !== 'version' && !KEYS.includes(key))) throw new Error('invalid plugin settings')
  const options = Object.fromEntries(KEYS.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
  // Reuse the explicit-path, WSL argv and budget validators. Nothing is launched.
  generateCodexConfig(options)
  return options
}

async function assertSettingsOutsideWorkspace(path, options) {
  if (options.wslDistro !== undefined) return // Host settings and Linux workspace use different filesystems.
  const within = candidate => {
    const part = relative(options.workspace, candidate)
    return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))
  }
  if (within(path)) throw new Error('invalid plugin settings path: must be outside the workspace')
  // A parent symlink must not hide a settings file inside the delegated project.
  let parent
  try { parent = await realpath(dirname(path)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (parent && within(join(parent, basename(path)))) throw new Error('invalid plugin settings path: must be outside the workspace')
}

export async function readPluginSettings(path) {
  let file
  try {
    path = pluginSettingsPath(path)
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('invalid plugin settings file')
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384 || entry.dev !== info.dev || entry.ino !== info.ino) throw new Error('invalid plugin settings file')
    const options = validatePluginSettings(JSON.parse(await file.readFile('utf8')))
    await assertSettingsOutsideWorkspace(path, options)
    return options
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error('invalid plugin settings; check the file or configure it again')
  } finally { await file?.close() }
}

export async function configurePlugin({ settingsFile, force = false, ...input } = {}) {
  const path = pluginSettingsPath(settingsFile)
  const options = validatePluginSettings({ version: 1, ...input })
  if (options.wslDistro === undefined) options.workspace = canonicalWorkspace(options.workspace)
  // A settings file inside the authorized writable project could be changed by
  // a delegated file task. Keep it outside that capability boundary.
  await assertSettingsOutsideWorkspace(path, options)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await assertSettingsOutsideWorkspace(path, options)
  let existing
  try { existing = await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('invalid plugin settings file')
  if (existing && !force) throw new Error('plugin settings already exist; --force creates a backup before replacing them')
  const data = JSON.stringify({ version: 1, ...options }, null, 2) + '\n'
  if (!existing) {
    await writeFile(path, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return { configured: path, restartRequired: true }
  }
  const backup = `${path}.backup-${randomUUID()}`
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    await copyFile(path, backup, constants.COPYFILE_EXCL)
    await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
  return { configured: path, backup, restartRequired: true }
}

export function pluginLaunch(options, command = 'mcp') {
  if (!['mcp', 'status'].includes(command)) throw new Error('invalid plugin command')
  if (options?.wslDistro !== undefined) {
    const launch = buildWslLaunch({
      distribution: options.wslDistro, workspace: options.workspace, cliPath: options.wslCli,
      nodePath: options.wslNode, installation: options.installation, credentialFile: options.credentialFile,
      maxRequests: options.maxRequests, timeoutMs: options.timeoutMs,
    })
    // buildWslLaunch fixes the CLI subcommand at argv[9]; don't replace any
    // user-supplied path or option whose contents happen to equal "mcp".
    if (command === 'status') launch.args[9] = 'status'
    return launch
  }
  return { args: [command, ...Object.entries(FLAGS).flatMap(([key, flag]) => options?.[key] === undefined ? [] : [flag, String(options[key])])] }
}

async function runWsl(launch) {
  if (process.platform !== 'win32') throw new Error('invalid plugin platform: WSL settings require a Windows host')
  await new Promise((resolveRun, reject) => {
    const child = spawn(launch.command, launch.args, { stdio: 'inherit', shell: false, windowsHide: true })
    const stop = () => { child.kill() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const cleanup = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', (code, signal) => { cleanup(); process.exitCode = signal ? 1 : code ?? 1; resolveRun() })
  })
}

export async function pluginMain(args) {
  try {
    let settingsFile
    const rest = []
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--settings-file') {
        if (settingsFile !== undefined) throw new Error('invalid repeated --settings-file')
        settingsFile = args[++index]
        if (settingsFile === undefined) throw new Error('invalid missing --settings-file')
      } else rest.push(args[index])
    }
    const parsed = parse(rest)
    if (parsed.options.help || parsed.command === undefined || parsed.command === 'help') { process.stdout.write(HELP); return }
    if (parsed.rest.length || !['configure', 'mcp', 'status'].includes(parsed.command)) throw new Error('invalid plugin command; use --help')
    if (parsed.command === 'configure') {
      const { force, ...options } = parsed.options
      process.stdout.write(JSON.stringify(await configurePlugin({ ...options, settingsFile, force })) + '\n')
      return
    }
    if (Object.keys(parsed.options).length) throw new Error('invalid plugin launch options; use configure first')
    const options = await readPluginSettings(pluginSettingsPath(settingsFile))
    const launch = pluginLaunch(options, parsed.command)
    if (launch.command) await runWsl(launch)
    else await main(launch.args)
  } catch (error) {
    const message = String(error.message)
    const safe = message.startsWith('invalid plugin') || message.startsWith('plugin settings already exist;')
    process.stderr.write(JSON.stringify({ error: safe ? message : 'Plugin setup failed; check explicit paths, settings, and prerequisites.' }) + '\n')
    process.exitCode = 1
  }
}
