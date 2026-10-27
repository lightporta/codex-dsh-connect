import { mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generateWslCodexConfig } from './windows-wsl.mjs'

export const CLI_PATH = fileURLToPath(new URL('../bin/codex-dsh-connect.mjs', import.meta.url))
const SKILL_SOURCE = fileURLToPath(new URL('../skills/codex-dsh-connect/SKILL.md', import.meta.url))

export function generateCodexConfig({ workspace, cliPath = CLI_PATH, nodePath = process.execPath, installation, credentialFile, maxRequests, timeoutMs, wslDistro, wslNode, wslCli } = {}) {
  if (wslDistro !== undefined || wslNode !== undefined || wslCli !== undefined) {
    return generateWslCodexConfig({ distribution: wslDistro, workspace, cliPath: wslCli, nodePath: wslNode, installation, credentialFile, maxRequests, timeoutMs })
  }
  for (const value of [workspace, cliPath, nodePath]) {
    if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('workspace, CLI and Node paths must be absolute')
  }
  const args = [cliPath, 'mcp', '--workspace', resolve(workspace)]
  if (installation !== undefined) {
    if (!isAbsolute(installation) || /[\r\n\0]/.test(installation)) throw new Error('installation must be absolute')
    args.push('--dsh-root', resolve(installation))
  }
  if (credentialFile !== undefined) {
    if (typeof credentialFile !== 'string' || !isAbsolute(credentialFile) || /[\r\n\0]/.test(credentialFile)) throw new Error('invalid credential file path')
    args.push('--credential-file', resolve(credentialFile))
  }
  for (const [value, name, flag, min, max] of [[maxRequests, 'maxRequests', '--max-requests', 1, 16], [timeoutMs, 'timeoutMs', '--timeout-ms', 1000, 300000]]) {
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`)
    args.push(flag, String(value))
  }
  return [
    '# Merge this snippet into the intended Codex configuration explicitly.',
    '# No HTTP host, API key, global profile or old session is used.',
    '[mcp_servers.codex_dsh_connect]',
    `command = ${JSON.stringify(nodePath)}`,
    `args = ${JSON.stringify(args)}`,
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    '',
  ].join('\n')
}

export async function installSkill({ dest, force = false } = {}) {
  if (typeof dest !== 'string' || dest.length === 0) throw new Error('an explicit --dest is required')
  const destination = resolve(dest)
  if (dirname(destination) === destination) throw new Error('skill destination must not be a filesystem root')
  let existing
  try { existing = await lstat(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing?.isSymbolicLink()) throw new Error('refusing to replace a symlink skill destination')
  if (existing !== undefined && !existing.isDirectory()) throw new Error('skill destination must be a directory')
  if (existing !== undefined && !force) throw new Error('skill destination already exists; --force creates a backup before replacing it')

  const source = await readFile(SKILL_SOURCE, 'utf8')
  const backup = existing === undefined ? undefined : `${destination}.backup-${Date.now()}-${randomUUID().slice(0, 8)}`
  await mkdir(dirname(destination), { recursive: true })
  if (backup !== undefined) await rename(destination, backup)
  try {
    // Copy only the maintained skill text plus executable paths, never config files or credentials.
    await mkdir(join(destination, 'references'), { recursive: true })
    await writeFile(join(destination, 'SKILL.md'), source, { encoding: 'utf8', flag: 'wx' })
    await writeFile(join(destination, 'references', 'local-paths.md'), [
      '# Local executable paths',
      '',
      `- Node: ${JSON.stringify(process.execPath)}`,
      `- CLI: ${JSON.stringify(CLI_PATH)}`,
      '',
      'Use an argv array when executing these paths. No model credentials are installed here.',
      '',
    ].join('\n'), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    if (backup !== undefined) await rename(backup, destination)
    throw error
  }
  return { installed: destination, ...(backup === undefined ? {} : { backup }) }
}
