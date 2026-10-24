export const DEFAULT_OUTPUT_CHARS = 8000
export const MAX_OUTPUT_CHARS = 16000
export const MAX_WAIT_MS = 25000

export function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function outputBudget(value) {
  return integer(value, DEFAULT_OUTPUT_CHARS, 1024, MAX_OUTPUT_CHARS, 'maxOutputChars')
}

function safeText(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

function numbers(source, keys) {
  const result = {}
  for (const key of keys) {
    if (typeof source?.[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key]
  }
  return result
}

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']
const COMPLETENESS = new Set(['unknown', 'partial', 'complete'])

export function compactUsage(run) {
  const accounting = run?.usageAccounting
  const fieldCompleteness = {}
  const tokens = {}
  for (const key of TOKEN_KEYS) {
    const state = accounting?.fieldCompleteness?.[key]
    fieldCompleteness[key] = COMPLETENESS.has(state) ? state : 'unknown'
    const value = run?.usage?.[key]
    if (fieldCompleteness[key] !== 'unknown' && Number.isSafeInteger(value) && value >= 0) tokens[key] = value
  }
  return {
    source: 'native-dsh-reported',
    completeness: COMPLETENESS.has(accounting?.completeness) ? accounting.completeness : 'unknown',
    tokens,
    fieldCompleteness,
  }
}

export function finalAnswer(text) {
  // These are answer-channel delimiters, never a substitute for access to a model's private reasoning.
  return text
    .replace(/<(think|thinking|analysis)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\/(?:think|thinking|analysis)\s*>/gi, '')
    .trim()
}

export function compactRun(run, { maxOutputChars, resultOffset } = {}) {
  const budget = outputBudget(maxOutputChars)
  const offset = integer(resultOffset, 0, 0, 1000000000, 'resultOffset')
  // A failed/killed run may contain textBuffer fragments without a native final
  // event. Only a successfully completed run can expose its answer as final output.
  const completed = run?.status === 'completed'
  const answer = completed && typeof run?.result === 'string' ? finalAnswer(run.result) : ''
  const result = {
    id: typeof run?.id === 'string' && run.id.length <= 200 ? run.id : undefined,
    ...(typeof run?.id === 'string' && run.id.length > 200 ? { idOmitted: 'exceeds-supported-length' } : {}),
    status: safeText(run?.status, 32),
    sessionId: typeof run?.sessionId === 'string' && run.sessionId.length <= 512 ? run.sessionId : undefined,
    ...(typeof run?.sessionId === 'string' && run.sessionId.length > 512 ? { sessionIdOmitted: 'exceeds-supported-length' } : {}),
    exitCode: Number.isInteger(run?.exitCode) ? run.exitCode : undefined,
    timedOut: run?.timedOut === true,
    durationMs: typeof run?.durationMs === 'number' && Number.isFinite(run.durationMs) ? run.durationMs : undefined,
    counts: numbers(run?.counts, ['turns', 'steps', 'toolCalls', 'toolErrors']),
    usage: compactUsage(run),
    output: {
      available: completed,
      totalChars: answer.length,
      offset: Math.min(offset, answer.length),
      truncated: false,
      budgetChars: budget,
    },
  }
  if (completed) {
    result.result = ''
    result.output.truncated = offset < answer.length
    if (result.output.truncated) result.output.nextOffset = offset
  }
  // Keep optional statistics from consuming most of a small answer budget. Session ids
  // retain their exact value; metadata is omitted explicitly instead of shortening ids.
  if (JSON.stringify(result).length > Math.floor(budget / 2)) delete result.counts
  if (JSON.stringify(result).length > Math.floor(budget / 2)) delete result.durationMs
  if (JSON.stringify(result).length > Math.floor(budget / 2)) {
    delete result.usage
    result.usageOmitted = 'output-budget'
  }
  if (JSON.stringify(result).length > budget && result.sessionId !== undefined) {
    delete result.sessionId
    result.sessionIdOmitted = 'output-budget'
  }
  if (JSON.stringify(result).length > budget && result.id !== undefined) {
    delete result.id
    result.idOmitted = 'output-budget'
  }
  if (completed) {
    // Binary search budgets JSON escaping and reserves the pagination cursor itself.
    let low = 0
    let high = Math.min(budget, Math.max(0, answer.length - offset))
    while (low < high) {
      const size = Math.ceil((low + high) / 2)
      result.result = answer.slice(offset, offset + size)
      result.output.truncated = offset + size < answer.length
      if (result.output.truncated) result.output.nextOffset = offset + size
      else delete result.output.nextOffset
      if (JSON.stringify(result).length <= budget) low = size
      else high = size - 1
    }
    result.result = answer.slice(offset, offset + low)
    result.output.truncated = offset + low < answer.length
    if (result.output.truncated) result.output.nextOffset = offset + low
    else delete result.output.nextOffset
  }
  return result
}

export function compactStatus(status) {
  return {
    bridge: 'codex-dsh-connect',
    executor: 'native-deepseek-harness',
    ready: status?.ready === true,
    platform: ['darwin', 'linux', 'win32'].includes(status?.platform) ? status.platform : 'unknown',
    workspaceConfigured: status?.workspaceConfigured === true,
    limits: numbers(status?.limits, ['concurrency', 'liveRuns', 'timeoutMs', 'maxTimeoutMs', 'maxRequests', 'retainRuns']),
    auth: { mode: ['account', 'environment', 'unavailable'].includes(status?.auth?.mode) ? status.auth.mode : 'unknown' },
    defaults: { submitWaitMs: 0, pollWaitMs: MAX_WAIT_MS, maxOutputChars: DEFAULT_OUTPUT_CHARS },
  }
}

export function compactError(error) {
  // Native exceptions can contain paths, credentials, or echoed task fragments.
  const status = Number.isInteger(error?.status) ? error.status : undefined
  const validation = typeof error?.message === 'string'
    && (/^(?:maxOutputChars|resultOffset|waitMs|timeoutMs|limit) must be an integer between \d+ and \d+$/.test(error.message)
      || /^invalid (?:task|cwd|label|id|reason|live)$/.test(error.message))
  return {
    error: validation ? error.message : 'native DeepSeek Harness request failed',
    ...(status === undefined ? {} : { status }),
  }
}
