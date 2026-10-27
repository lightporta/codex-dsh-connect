import { randomBytes } from 'node:crypto'
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createEngine } from './engine.js'
import { createFixture, isolatedEnvironment, SUPPORTED_DSH_VERSION } from './isolation.mjs'
import { assertSandboxAvailable, assertSandboxFixture, buildSandboxLaunch } from './launch.mjs'
import { canonicalWorkspace } from './project-tools.mjs'

const CONCURRENCY = 2
const RETAIN_RUNS = 50
const TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 300000
const MAX_WAIT_MS = 25000
const MAX_TASK_CHARS = 60 * 1024
const noopStore = { appendEvent: async () => {}, recordRun: async () => {} }

function error(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error(`invalid ${name}`)
  return value
}

function launcherSource(fixture, { timeoutMs }) {
  const fixed = JSON.stringify({
    ...buildSandboxLaunch(fixture, [fixture.bin, '--profile', fixture.profileName ?? 'contract-smoke', '--patch', fixture.overlay, '--json', '-']),
    profile: fixture.profileName ?? 'contract-smoke', timeoutMs,
  })
  return `import { spawn } from 'node:child_process'
const fixed = ${fixed}
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--profile', fixed.profile, '--json', '-'])) process.exit(64)
const child = spawn(fixed.command, fixed.args, {
  cwd: fixed.cwd, env: fixed.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
})
const timer = setTimeout(() => child.kill('SIGKILL'), fixed.timeoutMs + 1000)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.stdin.on('error', () => {})
process.stdin.pipe(child.stdin)
process.once('SIGTERM', () => child.kill('SIGKILL'))
child.once('error', () => { clearTimeout(timer); process.exitCode = 70 })
child.once('close', (code, signal) => { clearTimeout(timer); process.exitCode = signal ? 70 : code ?? 70 })
`
}

function snapshot(record) {
  if (record.snapshot) return structuredClone(record.snapshot)
  const raw = record.engine.view(record.nativeRun, { full: true })
  const kept = { id: record.id }
  for (const key of ['status', 'createdAt', 'startedAt', 'finishedAt', 'durationMs', 'exitCode', 'signal', 'timedOut', 'sessionId', 'counts', 'usage', 'usageAccounting', 'endReason']) {
    if (raw[key] !== undefined) kept[key] = raw[key]
  }
  if (raw.status === 'completed' && typeof raw.result === 'string') kept.result = raw.result
  return structuredClone(kept)
}

export async function createClient(options = {}) {
  const auth = options.auth ?? 'account'
  if (auth !== 'account') throw error('only account authentication is supported')
  const maxRequests = integer(options.maxRequests, 8, 1, 16, 'maxRequests')
  const defaultTimeout = integer(options.timeoutMs, TIMEOUT_MS, 1000, MAX_TIMEOUT_MS, 'timeoutMs')
  const installation = options.installation ?? join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh')
  const fixtureFactory = options.fixtureFactory ?? createFixture
  const makeLauncher = options.launcherFactory ?? launcherSource
  const injected = options.fixtureFactory !== undefined || options.launcherFactory !== undefined
  let workspace
  let workspaceReason = 'workspaceRequired'
  if (typeof options.workspace === 'string' && isAbsolute(options.workspace)) {
    try {
      workspace = canonicalWorkspace(options.workspace)
    } catch { workspace = undefined; workspaceReason = 'workspaceUnavailable' }
  }
  const records = new Map()
  const setups = new Set()
  let slots = 0
  let closed = false
  let order = 0

  async function readiness() {
    if (closed) return 'clientClosed'
    if (workspace === undefined) return workspaceReason
    if (injected) return undefined
    try { await assertSandboxAvailable() } catch (failure) { return failure.message }
    if (typeof installation !== 'string' || !isAbsolute(installation)) return 'installationUnavailable'
    try {
      const manifest = JSON.parse(await readFile(join(installation, 'package.json'), 'utf8'))
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== SUPPORTED_DSH_VERSION) return 'unsupportedNativeVersion'
      if (!(await stat(join(installation, 'lib/bin.js'))).isFile()) return 'installationUnavailable'
    } catch { return 'installationUnavailable' }
    return undefined
  }

  function prune() {
    const terminal = [...records.values()].filter(record => record.finalized).sort((a, b) => a.order - b.order)
    for (const record of terminal.slice(0, Math.max(0, terminal.length - RETAIN_RUNS))) records.delete(record.id)
  }

  async function finalize(record) {
    try {
      await record.nativeRun.outcome
      record.snapshot = snapshot(record)
      await rm(record.fixture.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } finally {
      slots -= 1
      record.fixture = undefined
      record.engine = undefined
      record.nativeRun = undefined
      record.finalized = true
      prune()
    }
  }

  async function buildRun(request, timeoutMs) {
    let fixture
    try {
      fixture = await fixtureFactory({
        installation, node: options.node ?? process.execPath, credentialFile: options.credentialFile,
        workspace, live: true, auth, code: true, maxRequests,
      })
      if (closed) throw error('clientClosed', 409)
      if (await realpath(fixture.workspace) !== workspace || await realpath(fixture.scratch) === workspace) throw error('invalid fixture workspace')
      if (makeLauncher === launcherSource) {
        if (typeof fixture.launchCwd !== 'string' || !isAbsolute(fixture.launchCwd)) throw error('isolated launch directory required')
        const path = relative(await realpath(fixture.scratch), await realpath(fixture.launchCwd))
        if (path === '' || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw error('invalid isolated launch directory')
        await assertSandboxFixture(fixture)
      }
      const launcher = join(fixture.scratch, 'launcher.mjs')
      await writeFile(launcher, await makeLauncher(fixture, { timeoutMs }), { mode: 0o600, flag: 'wx' })
      if (closed) throw error('clientClosed', 409)
      const engine = createEngine({
        config: { bin: launcher, profile: fixture.profileName ?? 'contract-smoke', timeoutMs, maxTimeoutMs: MAX_TIMEOUT_MS,
          concurrency: 1, tailLines: 5, env: isolatedEnvironment({ scratch: fixture.scratch, source: {}, live: true, auth }) },
        store: noopStore, warn: () => {}, jobs: () => undefined,
      })
      const started = engine.start({ task: request.task, cwd: workspace, timeoutMs, label: request.label })
      if (started.error) throw error('native executor could not start', started.status ?? 503)
      const record = { id: `run-${randomBytes(12).toString('hex')}`, order: ++order, fixture, engine, nativeRun: started.run }
      records.set(record.id, record)
      record.done = finalize(record)
      record.done.catch(() => {})
      return record
    } catch (failure) {
      slots -= 1
      if (fixture?.scratch) await rm(fixture.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      throw failure
    }
  }

  async function viewAfterWait(record, waitMs) {
    if (record.engine && waitMs > 0) await record.engine.wait(record.nativeRun, waitMs)
    if (record.snapshot || record.nativeRun?.status !== 'running') await record.done
    return snapshot(record)
  }

  return {
    async status() {
      const reason = await readiness()
      return {
        ready: reason === undefined, platform: process.platform, auth: { mode: auth }, workspaceConfigured: workspace !== undefined,
        engine: { source: 'isolated-native', profile: 'contract-smoke', isolation: process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' ? 'bubblewrap' : 'unavailable' },
        limits: { concurrency: CONCURRENCY, liveRuns: slots, timeoutMs: defaultTimeout, maxTimeoutMs: MAX_TIMEOUT_MS, maxRequests, retainRuns: RETAIN_RUNS },
        ...(reason === undefined ? {} : { reason }),
      }
    },

    async run(request = {}) {
      if (request.sessionId !== undefined) throw error('session resume is disabled')
      if (typeof request.task !== 'string' || request.task.trim().length === 0 || request.task.length > MAX_TASK_CHARS) throw error('invalid task')
      const timeoutMs = integer(request.timeoutMs, defaultTimeout, 1000, MAX_TIMEOUT_MS, 'timeoutMs')
      const waitMs = integer(request.wait, 0, 0, MAX_WAIT_MS, 'wait')
      const reason = await readiness()
      if (reason !== undefined) throw error(reason, reason === 'workspaceRequired' || reason === 'workspaceUnavailable' ? 400 : 503)
      if (request.cwd !== undefined) {
        if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) throw error('invalid cwd')
        let actual
        try { actual = await realpath(request.cwd) } catch { throw error('invalid cwd') }
        if (actual !== workspace) throw error('cwd must equal the configured workspace', 403)
      }
      if (closed) throw error('clientClosed', 409)
      if (slots >= CONCURRENCY) throw error('concurrency limit reached', 429)
      slots += 1
      const setup = buildRun(request, timeoutMs)
      setups.add(setup)
      setup.finally(() => setups.delete(setup)).catch(() => {})
      return viewAfterWait(await setup, waitMs)
    },

    async get(id, options = {}) {
      const record = records.get(id)
      if (!record) throw error('unknown run', 404)
      return viewAfterWait(record, integer(options.wait, 0, 0, MAX_WAIT_MS, 'wait'))
    },

    async runs(options = {}) {
      const limit = integer(options.limit, 5, 1, RETAIN_RUNS, 'limit')
      const liveOnly = options.live === true || options.live === '1'
      return { live: slots, runs: [...records.values()].sort((a, b) => b.order - a.order)
        .filter(record => !liveOnly || record.nativeRun?.status === 'running').slice(0, limit).map(snapshot) }
    },

    async kill(id, reason) {
      const record = records.get(id)
      if (!record) throw error('unknown run', 404)
      return { id, admission: record.engine ? record.engine.kill(record.nativeRun.id, typeof reason === 'string' ? reason.slice(0, 200) : 'cancelled') : 'already-finished' }
    },

    async close() {
      closed = true
      for (const record of records.values()) record.engine?.disposeAll()
      await Promise.allSettled([...setups])
      for (const record of records.values()) record.engine?.disposeAll()
      const results = await Promise.allSettled([...records.values()].map(record => record.done))
      if (results.some(result => result.status === 'rejected')) throw error('temporary cleanup failed', 500)
    },
  }
}
