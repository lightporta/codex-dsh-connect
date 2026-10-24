import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { compact, createAggregate, fold } from './events.js'
import { detached, terminateTree } from './process-tree.js'
import { redactSecrets } from './redact.js'
import {
  MAX_LABEL_CHARS,
  MAX_RESULT_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_TASK_CHARS,
  PLUGIN_NAME,
} from './protocol.js'

const JOB_KIND = `${PLUGIN_NAME}-subagent`
const STDERR_TAIL_BYTES = 4096
const MAX_LINE_BUFFER_BYTES = 1024 * 1024
const TEXT_BUFFER_CHARS = 64 * 1024

export function resolveDshBin(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.length > 0) candidates.push({ path: configured, source: 'config' })

  const entry = process.argv[1]
  if (typeof entry === 'string' && /[\\/]bin\.js$/.test(entry) && entry.includes('@deepseek-ai')) {
    candidates.push({ path: entry, source: 'host-entry' })
  }

  try {
    const require = createRequire(import.meta.url)
    candidates.push({ path: require.resolve('@deepseek-ai/dsh/lib/bin.js'), source: 'resolve' })
  } catch {
    // A linked checkout outside the profile cannot resolve the CLI; host-entry covers it.
  }

  for (const candidate of candidates) {
    if (candidate.path === undefined) continue
    try {
      if (statSync(candidate.path).isFile()) return { bin: candidate.path, source: candidate.source, reason: undefined }
    } catch {
      // Try the next candidate.
    }
  }
  return { bin: undefined, source: 'none', reason: 'no @deepseek-ai/dsh CLI entry found (set the plugin config `bin`)' }
}

export function resolveCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return { cwd: process.cwd(), error: undefined }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return { cwd: undefined, error: 'cwd must be an absolute path' }
  try {
    if (!statSync(cwd).isDirectory()) return { cwd: undefined, error: 'cwd is not a directory' }
  } catch {
    return { cwd: undefined, error: 'cwd does not exist' }
  }
  return { cwd, error: undefined }
}

export function createEngine({ config, store, warn, jobs }) {
  const resolution = resolveDshBin(config.bin)
  const runs = new Map()
  const live = new Set()
  let ordinal = 0

  function view(run, options = {}) {
    const tail = options.tail ?? 0
    const full = options.full === true
    const result = run.aggregate.finalText ?? run.textBuffer
    const base = {
      id: run.id,
      label: run.label,
      status: run.status,
      task: run.task.length > 2000 ? `${run.task.slice(0, 2000)}…` : run.task,
      taskChars: run.task.length,
      cwd: run.cwd,
      profile: run.profile,
      pid: run.pid,
      jobId: run.jobId,
      jobMirror: run.jobId !== undefined
        ? { attached: true, id: run.jobId }
        : { attached: false, reason: run.mirrorError ?? 'this host mounts no job registry' },
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      detail: run.detail,
      sessionId: run.resumeSessionId ?? run.aggregate.sessionId,
      resumed: run.resumeSessionId,
      counts: {
        events: run.aggregate.eventCount,
        turns: run.aggregate.turns,
        steps: run.aggregate.steps,
        toolCalls: run.aggregate.toolCalls,
        toolErrors: run.aggregate.toolErrors,
      },
      usage: { ...run.aggregate.usage },
      usageAccounting: {
        ...run.aggregate.usageAccounting,
        fieldCompleteness: { ...run.aggregate.usageAccounting.fieldCompleteness },
      },
      endReason: run.aggregate.endReason,
      resultChars: typeof result === 'string' ? result.length : 0,
      timedOut: run.timedOut,
    }
    if (result !== undefined) {
      base.result = full || result.length <= MAX_RESULT_CHARS
        ? result
        : `${result.slice(0, MAX_RESULT_CHARS)}…`
    }
    if (tail > 0) base.tail = run.tail.slice(-tail)
    if (run.stderrTail.length > 0) base.stderrTail = redactSecrets(run.stderrTail)
    return base
  }

  function accept(run, line) {
    void store.appendEvent(run.id, line)
    let event
    try {
      event = JSON.parse(line)
    } catch {
      event = { type: 'raw', text: line }
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) event = { type: 'raw', text: line }
    if (event.type === 'status' && event.phase === 'turn_start') {
      run.aggregate.finalText = undefined
      run.aggregate.endReason = undefined
      run.textBuffer = ''
    }
    if (event.type === 'error') run.protocolError = redactSecrets(String(event.message ?? 'dsh emitted an error')).slice(0, 1000)
    fold(run.aggregate, event)
    if (event.type === 'text' && typeof event.text === 'string') {
      run.textBuffer = (run.textBuffer + event.text).slice(-TEXT_BUFFER_CHARS)
    }
    const rendered = compact(event)
    run.tail.push(rendered)
    if (run.tail.length > config.tailLines * 4) run.tail.splice(0, run.tail.length - config.tailLines * 2)
    try {
      run.jobHandle?.append(rendered + '\n', { channel: 'log' })
    } catch {
      // The job ring is closed after settlement.
    }
  }

  function settle(run, code, signal) {
    if (run.status !== 'running') return
    clearTimeout(run.timer)
    run.finishedAt = Date.now()
    run.exitCode = code
    run.signal = signal ?? undefined
    live.delete(run)

    if (run.timedOut) {
      run.status = 'failed'
      run.detail = `timeout after ${run.timeoutMs}ms`
    } else if (run.killReason !== undefined) {
      run.status = 'killed'
      run.detail = run.killReason
    } else if (run.spawnError !== undefined) {
      run.status = 'failed'
      run.detail = run.spawnError
    } else if (code !== 0) {
      run.status = 'failed'
      run.detail = `exit code ${code}${signal === null ? '' : ` (signal ${signal})`}`
    } else if (run.protocolError !== undefined) {
      run.status = 'failed'
      run.detail = run.protocolError
    } else if (run.aggregate.finalText === undefined || run.aggregate.endReason?.kind !== 'completed') {
      run.status = 'failed'
      run.detail = 'dsh exited without a final result and completed terminal reason'
    } else {
      run.status = 'completed'
      run.detail = undefined
    }

    run.tail.push(`— ${run.status}${run.detail ? `: ${run.detail}` : ''} in ${run.finishedAt - run.startedAt}ms`)
    void store.appendEvent(run.id, JSON.stringify({
      type: 'proxy/settled',
      status: run.status,
      detail: run.detail,
      exitCode: code,
      at: run.finishedAt,
    }))

    for (const waiter of run.waiters) waiter()
    run.waiters.clear()

    try {
      run.jobHandle?.append(`run ${run.status}${run.detail ? `: ${run.detail}` : ''}\n`, { channel: 'log' })
    } catch {
      // Already settled on the registry side.
    }
    run.resolveOutcome({
      status: run.status === 'completed' ? 'completed' : run.status === 'killed' ? 'killed' : 'failed',
      detail: run.detail,
      result: run.aggregate.finalText ?? (run.textBuffer.length > 0 ? run.textBuffer : undefined),
    })

    void store.recordRun(view(run))
  }

  function killRun(run, reason) {
    if (run.status !== 'running') return 'already-finished'
    run.killReason = reason
    try {
      run.jobHandle?.updateProgress('stopping')
    } catch {
      // Post-settlement writes drop by design.
    }
    if (run.child !== undefined) terminateTree(run.child)
    return 'requested'
  }

  return {
    engine: { bin: resolution.bin, source: resolution.source, reason: resolution.reason, profile: config.profile },

    ready() {
      return resolution.bin !== undefined
    },

    start(request) {
      if (resolution.bin === undefined) return { error: resolution.reason ?? 'dsh CLI not found', status: 503 }
      const { task, sessionId, label } = request
      if (typeof task !== 'string' || task.trim().length === 0) return { error: 'task must be a non-empty string', status: 400 }
      if (task.length > MAX_TASK_CHARS) return { error: `task too long (max ${MAX_TASK_CHARS} characters)`, status: 413 }
      if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > MAX_SESSION_ID_CHARS)) {
        return { error: `sessionId must be a string of at most ${MAX_SESSION_ID_CHARS} characters`, status: 400 }
      }

      const resolved = resolveCwd(request.cwd)
      if (resolved.error !== undefined) return { error: resolved.error, status: 400 }

      let timeoutMs = config.timeoutMs
      if (request.timeoutMs !== undefined) {
        if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1000) return { error: 'timeoutMs must be at least 1000', status: 400 }
        timeoutMs = Math.min(Math.trunc(request.timeoutMs), config.maxTimeoutMs)
      }

      if (live.size >= config.concurrency) {
        return { error: `concurrency limit reached (${config.concurrency} live runs); wait for one to settle or kill it`, status: 429 }
      }

      const now = Date.now()
      ordinal += 1
      // Two hosts may share the ledger, so the ordinal needs the pid to stay unique.
      const id = `run-${now.toString(36)}-${ordinal.toString(36).padStart(3, '0')}-${process.pid.toString(36)}`
      const run = {
        id,
        label: typeof label === 'string' && label.trim().length > 0
          ? label.trim().slice(0, MAX_LABEL_CHARS)
          : task.trim().replace(/\s+/g, ' ').slice(0, 120),
        task,
        cwd: resolved.cwd,
        profile: config.profile,
        resumeSessionId: sessionId,
        timeoutMs,
        status: 'running',
        createdAt: now,
        startedAt: now,
        finishedAt: undefined,
        exitCode: undefined,
        signal: undefined,
        detail: undefined,
        pid: undefined,
        jobId: undefined,
        jobHandle: undefined,
        mirrorError: undefined,
        child: undefined,
        timer: undefined,
        killReason: undefined,
        timedOut: false,
        spawnError: undefined,
        protocolError: undefined,
        aggregate: createAggregate(),
        textBuffer: '',
        tail: [],
        stderrTail: '',
        waiters: new Set(),
        resolveOutcome: () => {},
      }
      run.outcome = new Promise(resolve => {
        run.resolveOutcome = resolve
      })

      runs.set(id, run)
      live.add(run)
      if (runs.size > 100) {
        for (const [key, candidate] of runs) {
          if (candidate.status !== 'running') runs.delete(key)
          if (runs.size <= 100) break
        }
      }

      const registry = jobs()
      if (registry !== undefined) {
        try {
          run.jobId = registry.start({
            kind: JOB_KIND,
            label: run.label,
            outputLimitBytes: 32 * 1024,
            run: handle => {
              run.jobHandle = handle
              handle.updateProgress('spawning')
              return {
                cancel: reason => killRun(run, typeof reason === 'string' ? reason : 'killed from the job list'),
                done: run.outcome,
              }
            },
          })
        } catch (error) {
          run.mirrorError = error instanceof Error ? error.message : String(error)
          warn(`job mirror unavailable for ${id}: ${run.mirrorError}`)
        }
      }

      const args = [resolution.bin, '--profile', config.profile, '--json']
      if (typeof sessionId === 'string' && sessionId.length > 0) args.push('--session-id', sessionId)
      args.push('-')

      let child
      try {
        child = spawn(process.execPath, args, {
          cwd: run.cwd,
          env: config.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
          detached,
        })
      } catch (error) {
        run.spawnError = `spawn failed: ${error instanceof Error ? error.message : String(error)}`
        settle(run, null, null)
        return { run, view: view(run) }
      }

      run.child = child
      run.pid = child.pid
      try {
        run.jobHandle?.updateProgress(`pid ${child.pid ?? '?'}`)
      } catch {
        // Mirror already closed.
      }

      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (run.status !== 'running' || run.protocolError !== undefined) return
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (Buffer.byteLength(line) > MAX_LINE_BUFFER_BYTES) {
            run.protocolError = 'dsh emitted a JSON event larger than 1 MiB'
            buffer = ''
            terminateTree(child)
            return
          }
          if (line.trim().length > 0) accept(run, line)
          newline = buffer.indexOf('\n')
        }
        if (Buffer.byteLength(buffer) > MAX_LINE_BUFFER_BYTES) {
          run.protocolError = 'dsh emitted a JSON event larger than 1 MiB'
          buffer = ''
          terminateTree(child)
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        run.stderrTail = (run.stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
      })

      child.stdin.on('error', () => {})
      child.stdin.end(task)

      child.on('error', error => {
        run.spawnError = `child error: ${error.message}`
        settle(run, child.exitCode, child.signalCode)
      })
      child.on('close', (code, signal) => {
        if (buffer.trim().length > 0) accept(run, buffer.trim())
        settle(run, code, signal)
      })

      run.timer = setTimeout(() => {
        run.timedOut = true
        terminateTree(child)
      }, timeoutMs)

      void store.appendEvent(id, JSON.stringify({
        type: 'proxy/started',
        id,
        label: run.label,
        cwd: run.cwd,
        profile: run.profile,
        timeoutMs,
        resumed: sessionId,
        at: now,
      }))
      return { run, view: view(run) }
    },

    find(id) {
      return runs.get(id)
    },

    view,

    list(limit) {
      return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(run => view(run))
    },

    liveCount() {
      return live.size
    },

    kill(id, reason) {
      const run = runs.get(id)
      if (run === undefined) return 'unknown'
      return killRun(run, reason ?? 'killed by the caller')
    },

    wait(run, ms) {
      if (run.status !== 'running') return Promise.resolve(run)
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          run.waiters.delete(done)
          resolve(run)
        }, ms)
        const done = () => {
          clearTimeout(timer)
          resolve(run)
        }
        run.waiters.add(done)
      })
    },

    disposeAll() {
      let count = 0
      for (const run of [...live]) {
        killRun(run, 'proxy plugin unloaded')
        count += 1
      }
      return count
    },
  }
}
