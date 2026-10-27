import { access, constants, lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix } from 'node:path'

export const BWRAP_PATH = '/usr/bin/bwrap'

// Keep the runtime allowlist narrower than /usr or /etc. In particular, never
// expose /home, /run, /mnt (WSL Windows drives), or the host's whole root.
const RUNTIME_TREES = Object.freeze([
  '/usr/lib', '/usr/lib64', '/lib', '/lib64',
  '/usr/share/zoneinfo', '/usr/share/ca-certificates', '/etc/ssl/certs',
])
const RUNTIME_FILES = Object.freeze([
  '/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/hosts', '/etc/resolv.conf',
])
const ENV_KEYS = new Set([
  'PATH', 'LANG', 'TMPDIR', 'DSH_HOME', 'DSH_AGENTS_HOME',
  'DSH_TELEMETRY_DISABLED', 'DSH_TOOLS_MODE',
])

function absolute(value) {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('invalidLinuxAbsolutePath')
  if (posix.resolve(value) !== value || value.startsWith('//')) throw new Error('canonicalLinuxPathRequired')
  return value
}

const within = (path, root) => path === root || path.startsWith(root + '/')
const overlap = (a, b) => within(a, b) || within(b, a)

function boundedRoot(value) {
  const broad = new Set([
    '/', '/home', '/root', '/Users', '/tmp', '/var', '/var/tmp', '/private',
    '/run', '/mnt', '/media', '/usr', '/usr/local', '/opt', '/srv', '/etc',
    '/bin', '/sbin', '/lib', '/lib64', homedir(),
  ])
  if (broad.has(value) || /^\/home\/[^/]+(?:\/(?:Documents|Downloads|Desktop|Pictures|Music|Videos|Public))?$/.test(value) || /^\/mnt\/[a-z]$/i.test(value) || value.split('/').some(part => /^\.(?:ssh|aws|dsh|codex|agents|config)$/i.test(part))) throw new Error('unsafeLinuxRoot')
}

export async function assertLinuxAvailable() {
  try { await access(BWRAP_PATH, constants.X_OK) } catch { throw new Error('bubblewrapUnavailable') }
}

// Inputs must already be canonicalized by createFixture. This builder performs
// structural checks as well so simulated paths are validated on any host OS.
// Missing runtime mounts use --ro-bind-try; task/runtime mounts are mandatory.
export function buildLinuxLaunch({ scratch, workspace, installation, node, credentialFile, launchCwd, live = false, env, args = [] }) {
  scratch = absolute(scratch)
  workspace = absolute(workspace)
  installation = absolute(installation)
  node = absolute(node)
  launchCwd = absolute(launchCwd ?? posix.join(scratch, 'workspace'))
  for (const path of [scratch, workspace, installation]) boundedRoot(path)
  if (!within(launchCwd, scratch)) throw new Error('linuxLaunchDirectoryMustBeInsideScratch')
  if (overlap(scratch, installation) || overlap(workspace, installation) || within(node, workspace) || within(node, scratch)) throw new Error('workspaceMustNotContainRuntime')
  if (within(scratch, workspace) && scratch !== workspace) throw new Error('workspaceMustNotContainScratch')
  if (scratch === workspace) throw new Error('workspaceMustNotEqualScratch')
  const systemRoots = [...RUNTIME_TREES, '/dev', '/proc']
  if ([scratch, workspace].some(path => systemRoots.some(root => overlap(path, root)) || RUNTIME_FILES.some(file => overlap(path, file)))) throw new Error('workspaceMustNotOverlapSystemRuntime')
  if (RUNTIME_TREES.includes(installation) || ['/dev', '/proc'].some(root => overlap(installation, root))) throw new Error('unsafeLinuxRoot')
  if (typeof live !== 'boolean' || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalidLinuxLaunchArguments')

  const credential = credentialFile === undefined ? undefined : absolute(credentialFile)
  if (credential !== undefined && [scratch, workspace, installation, ...RUNTIME_TREES, '/proc', '/dev'].some(root => within(credential, root))) throw new Error('credentialMustBeOutsideAllowedTrees')
  if (credential !== undefined && [node, ...RUNTIME_FILES].includes(credential)) throw new Error('credentialMustBeOutsideAllowedTrees')

  const environment = env ?? {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8',
    TMPDIR: posix.join(scratch, 'tmp'), DSH_HOME: posix.join(scratch, 'dsh'),
    DSH_AGENTS_HOME: posix.join(scratch, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
  }
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('invalidLinuxEnvironment')
  for (const [key, value] of Object.entries(environment)) {
    if (!ENV_KEYS.has(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('invalidLinuxEnvironment')
  }

  const argv = ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv']
  if (live) argv.push('--share-net')
  for (const path of [...RUNTIME_TREES, ...RUNTIME_FILES]) argv.push('--ro-bind-try', path, path)
  argv.push('--proc', '/proc', '--dev', '/dev')
  // Never mount a runtime parent simply to make one executable reachable.
  argv.push('--ro-bind', node, node, '--ro-bind', installation, installation)
  argv.push('--bind', scratch, scratch)
  if (!within(workspace, scratch)) argv.push('--bind', workspace, workspace)
  if (live && credential !== undefined) argv.push('--ro-bind', credential, credential)
  // Node can resolve os.homedir() without mounting host /etc/passwd. This is
  // a fixed task-owned HOME, never the parent's HOME or a caller override.
  argv.push('--chdir', launchCwd, '--remount-ro', '/', '--setenv', 'HOME', scratch)
  for (const [key, value] of Object.entries(environment)) argv.push('--setenv', key, value)
  argv.push('--', node, ...args)
  return { command: BWRAP_PATH, args: argv, cwd: launchCwd, env: {} }
}

// Metadata-only preflight: binding a directory at credentialFile would expose a
// whole private tree. The adapter never reads its contents. As with project-tool
// checks, a hostile host process concurrently swapping paths is outside this
// check's guarantee; task inputs and the pinned runtime must remain trusted.
export async function assertLinuxFixture(fixture) {
  const launch = buildLinuxLaunch(fixture)
  const canonical = { ...fixture, launchCwd: launch.cwd }
  for (const [key, directory] of [['scratch', true], ['workspace', true], ['installation', true], ['node', false], ['launchCwd', true]]) {
    const path = absolute(canonical[key])
    const info = await lstat(path)
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || await realpath(path) !== path) throw new Error('canonicalLinuxFixtureRequired')
  }
  if (fixture.live === true && (fixture.auth ?? 'account') === 'account') {
    if (fixture.credentialFile === undefined) throw new Error('invalidLinuxCredentialFile')
    const path = absolute(fixture.credentialFile)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) throw new Error('invalidLinuxCredentialFile')
  }
}
