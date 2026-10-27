import { posix } from 'node:path'

const BROAD_ROOTS = new Set(['/', '/bin', '/dev', '/etc', '/home', '/lib', '/lib64', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var'])

function linuxPath(value, name, { directory = false } = {}) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || (value.length > 1 && value.endsWith('/')) || /[\\\x00-\x1f\x7f]/.test(value) || posix.normalize(value) !== value) {
    throw new Error(`${name} must be a normalized absolute Linux path`)
  }
  if (value === '/' || (directory && (BROAD_ROOTS.has(value) || /^\/home\/[^/]+(?:\/(?:Documents|Desktop|Downloads))?$/.test(value) || /^\/mnt\/[a-z]$/i.test(value)))) {
    throw new Error(`${name} must not be a broad root`)
  }
  return value
}

function within(value, root) {
  return value === root || value.startsWith(root + '/')
}

function budget(value, name, min, max) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) throw new Error(`invalid ${name}`)
  return value
}

// This creates an argv vector only. It neither launches WSL nor translates host
// paths. Linux node, connector and Harness must already exist in the distro.
export function buildWslLaunch({ distribution, workspace, cliPath, nodePath, installation, credentialFile, maxRequests, timeoutMs } = {}) {
  if (typeof distribution !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(distribution) || distribution.trim() !== distribution) {
    throw new Error('an explicit valid WSL distribution is required')
  }
  workspace = linuxPath(workspace, 'workspace', { directory: true })
  cliPath = linuxPath(cliPath, 'CLI path')
  nodePath = linuxPath(nodePath, 'Node path')
  installation = linuxPath(installation, 'installation', { directory: true })
  if ([cliPath, nodePath, installation].some(value => within(value, workspace)) || within(workspace, installation)) {
    throw new Error('workspace must not overlap the runtime')
  }
  if (credentialFile !== undefined) {
    credentialFile = linuxPath(credentialFile, 'credential file')
    if ([workspace, installation].some(root => within(credentialFile, root))) throw new Error('credential file must be outside workspace and runtime')
  }
  budget(maxRequests, 'maxRequests', 1, 16)
  budget(timeoutMs, 'timeoutMs', 1000, 300000)
  const args = [
    '--distribution', distribution, '--exec', '/usr/bin/env', '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8',
    nodePath, cliPath, 'mcp', '--workspace', workspace, '--dsh-root', installation,
  ]
  if (credentialFile !== undefined) args.push('--credential-file', credentialFile)
  if (maxRequests !== undefined) args.push('--max-requests', String(maxRequests))
  if (timeoutMs !== undefined) args.push('--timeout-ms', String(timeoutMs))
  return { command: 'wsl.exe', args }
}

export function generateWslCodexConfig(options) {
  const { command, args } = buildWslLaunch(options)
  return [
    '# Requires WSL2 and Linux Node, Harness, bubblewrap and account login in the selected distribution.',
    '# All paths below refer to Linux paths in that distribution. Merge explicitly.',
    '[mcp_servers.codex_dsh_connect]',
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 60',
    '',
  ].join('\n')
}
