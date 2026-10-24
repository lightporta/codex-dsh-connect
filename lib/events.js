const MAX_LINE_CHARS = 400
const MAX_INPUT_CHARS = 200
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']
const usageFieldSteps = Symbol('usageFieldSteps')

export function createAggregate() {
  return {
    eventCount: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    textChars: 0,
    thinkingChars: 0,
    sessionId: undefined,
    finalText: undefined,
    endReason: undefined,
    usage: Object.fromEntries(USAGE_KEYS.map(key => [key, 0])),
    usageAccounting: {
      reported: false,
      completeness: 'unknown',
      stepsObserved: 0,
      stepsReported: 0,
      fieldCompleteness: Object.fromEntries(USAGE_KEYS.map(key => [key, 'unknown'])),
    },
    [usageFieldSteps]: Object.fromEntries(USAGE_KEYS.map(key => [key, 0])),
  }
}

function isTokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function addStepUsage(aggregate, sample) {
  // Native headless reports usage for this step, including its retried attempts,
  // then resets its accumulator. It is not a running total for the invocation.
  // Missing optional buckets must remain distinguishable from a reported zero.
  const accounting = aggregate.usageAccounting
  const counts = aggregate[usageFieldSteps]
  accounting.stepsObserved += 1
  const usage = sample !== null && typeof sample === 'object' ? sample : {}
  if (isTokenCount(usage.inputTokens) && isTokenCount(usage.outputTokens)) accounting.stepsReported += 1
  for (const key of USAGE_KEYS) {
    if (isTokenCount(usage[key])) {
      aggregate.usage[key] += usage[key]
      counts[key] += 1
      accounting.reported = true
    }
    accounting.fieldCompleteness[key] = counts[key] === 0
      ? 'unknown'
      : counts[key] === accounting.stepsObserved ? 'complete' : 'partial'
  }
  accounting.completeness = !accounting.reported
    ? 'unknown'
    : accounting.stepsReported === accounting.stepsObserved ? 'complete' : 'partial'
}

function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function fold(aggregate, event) {
  aggregate.eventCount += 1
  switch (event.type) {
    case 'session':
      if (typeof event.sessionId === 'string') aggregate.sessionId = event.sessionId
      return
    case 'status':
      if (event.phase === 'turn_start') aggregate.turns = Math.max(aggregate.turns, Number(event.turn) || 0)
      if (event.phase === 'step_start') aggregate.steps = Math.max(aggregate.steps, Number(event.step) || 0)
      if (event.phase === 'step_end') addStepUsage(aggregate, event.usage)
      if (event.phase === 'turn_end' && event.reason !== undefined) aggregate.endReason = event.reason
      return
    case 'thinking':
      aggregate.thinkingChars += typeof event.text === 'string' ? event.text.length : 0
      return
    case 'text':
      aggregate.textChars += typeof event.text === 'string' ? event.text.length : 0
      return
    case 'tool_call':
      aggregate.toolCalls += 1
      return
    case 'tool_result':
      if (event.status === 'error') aggregate.toolErrors += 1
      return
    case 'final':
      if (typeof event.text === 'string') aggregate.finalText = event.text
      return
    default:
      return
  }
}

export function compact(event) {
  switch (event.type) {
    case 'session':
      return `session ${event.sessionId ?? '?'}`
    case 'status': {
      const parts = [`status ${event.phase ?? '?'}`]
      if (event.turn !== undefined) parts.push(`turn=${event.turn}`)
      if (event.step !== undefined) parts.push(`step=${event.step}`)
      if (event.reason !== undefined) parts.push(`reason=${oneLine(JSON.stringify(event.reason), 80)}`)
      return parts.join(' ')
    }
    case 'thinking':
      return `thinking ${typeof event.text === 'string' ? event.text.length : 0} chars`
    case 'text':
      return `text ${oneLine(event.text, MAX_LINE_CHARS)}`
    case 'tool_call':
      return `tool ${event.tool ?? '?'} ${oneLine(JSON.stringify(event.input ?? {}), MAX_INPUT_CHARS)}`
    case 'tool_result':
      return `result ${event.status ?? '?'} ${oneLine(event.result ?? '', MAX_INPUT_CHARS)}`
    case 'final':
      return `final ${typeof event.text === 'string' ? event.text.length : 0} chars`
    default:
      return oneLine(JSON.stringify(event), MAX_LINE_CHARS)
  }
}
