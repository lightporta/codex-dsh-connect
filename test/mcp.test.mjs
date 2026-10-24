import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createDispatcher, runStdioServer, SERVER_INFO } from '../lib/mcp.js'
import { compactRun, compactUsage, compactStatus } from '../lib/projection.js'

const parse = response => JSON.parse(response.result.content[0].text)
const request = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

function mockClient() {
  const seen = []
  const state = { status: 'running' }
  const view = () => ({
    id: 'run-1', status: state.status, sessionId: 'invocation-id',
    result: `<think>PRIVATE_REASONING</think>${'最终报告\\\"\n'.repeat(3000)}`,
    thinking: 'PRIVATE_REASONING', task: 'PRIVATE_PROMPT', tail: ['PRIVATE_TOOL_TRACE'], stderrTail: 'PRIVATE_STDERR',
    durationMs: 40,
    usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42, reasoningTokens: 5, cacheReadTokens: 0 },
    usageAccounting: { completeness: 'complete', fieldCompleteness: { inputTokens: 'complete', outputTokens: 'complete', totalTokens: 'complete', reasoningTokens: 'partial', cacheReadTokens: 'unknown' } },
  })
  const client = {
    async status() { return { ready: true, platform: 'darwin', workspaceConfigured: true, auth: { mode: 'account', token: 'PRIVATE_TOKEN' }, workspace: '/PRIVATE_PATH', reason: 'PRIVATE_REASON', limits: { concurrency: 2, liveRuns: 1, timeoutMs: 120000, maxTimeoutMs: 300000, maxRequests: 8, retainRuns: 50 }, engine: { source: 'isolated-native' } } },
    async run(args) { seen.push(['run', args]); return view() },
    async get(id, args) { seen.push(['get', id, args]); return view() },
    async runs(args) { seen.push(['runs', args]); return { live: 1, runs: [view()] } },
    async kill(id, reason) { seen.push(['kill', id, reason]); state.status = 'killed'; return { id, admission: 'requested', secret: 'PRIVATE_CANCEL' } },
    async close() {},
  }
  return { client, seen, state }
}

test('MCP advertises standalone identity and exactly five tools without session resumption', async () => {
  const { client } = mockClient()
  const dispatch = createDispatcher(client)
  const initialized = await dispatch(request('initialize', { protocolVersion: '2024-11-05' }))
  assert.deepEqual(initialized.result.serverInfo, { name: 'codex-dsh-connect', version: '0.1.0' })
  assert.equal(initialized.result.protocolVersion, '2024-11-05')
  const unsupported = await dispatch(request('initialize', { protocolVersion: 'not-a-protocol' }))
  assert.notEqual(unsupported.result.protocolVersion, 'not-a-protocol')
  const tools = (await dispatch(request('tools/list'))).result.tools
  assert.deepEqual(tools.map(tool => tool.name), ['dsh_status', 'dsh_delegate', 'dsh_run', 'dsh_runs', 'dsh_kill'])
  assert.equal(tools[1].inputSchema.properties.sessionId, undefined)
  assert.match(tools[1].description, /macOS/)
  assert.doesNotMatch(JSON.stringify(tools), /_market_|_lab_|HTTP|resume|shared host/i)
})

test('native status preserves useful limits and excludes private paths, reasons, and auth values', async () => {
  const { client } = mockClient()
  const status = parse(await createDispatcher(client)(request('tools/call', { name: 'dsh_status', arguments: {} })))
  assert.equal(status.ready, true)
  assert.equal(status.platform, 'darwin')
  assert.equal(status.workspaceConfigured, true)
  assert.deepEqual(status.auth, { mode: 'account' })
  assert.equal(status.limits.concurrency, 2)
  assert.equal(status.limits.maxRequests, 8)
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|token|profile/)
  assert.deepEqual(compactStatus({ platform: '/PRIVATE', auth: { mode: 'PRIVATE' } }).auth, { mode: 'unknown' })
})

test('delegate submits async, polling is bounded, listing omits prompts, and kill is explicit', async () => {
  const { client, state, seen } = mockClient()
  const dispatch = createDispatcher(client)
  const submitted = parse(await dispatch(request('tools/call', { name: 'dsh_delegate', arguments: { task: 'Edit authorized source', label: 'one task' } })))
  assert.equal(submitted.id, 'run-1')
  assert.equal(submitted.result, undefined)
  assert.equal(seen[0][1].wait, 0)
  assert.equal(Object.hasOwn(seen[0][1], 'sessionId'), false)
  assert.equal(parse(await dispatch(request('tools/call', { name: 'dsh_run', arguments: { id: 'run-1' } }))).status, 'running')
  assert.deepEqual(seen[1], ['get', 'run-1', { wait: 25000 }])
  const listed = parse(await dispatch(request('tools/call', { name: 'dsh_runs', arguments: { live: true } })))
  assert.deepEqual(seen[2], ['runs', { limit: 5, live: true }])
  assert.deepEqual(listed.runs, [{ id: 'run-1', status: 'running', durationMs: 40 }])
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE_|session|result/)
  const killed = parse(await dispatch(request('tools/call', { name: 'dsh_kill', arguments: { id: 'run-1', reason: 'done' } })))
  assert.deepEqual(killed, { id: 'run-1', admission: 'requested' })
  assert.equal(state.status, 'killed')
})

test('old sessions and unknown/raw parameters are rejected before reaching native client', async () => {
  const { client, seen } = mockClient()
  const dispatch = createDispatcher(client)
  for (const args of [{ task: 'x', sessionId: 'PRIVATE_OLD_SESSION' }, { task: 'x', raw: true }, null, ['x']]) {
    const response = await dispatch(request('tools/call', { name: 'dsh_delegate', arguments: args }))
    assert.equal(response.error?.code, -32602)
  }
  const invalidWait = await dispatch(request('tools/call', { name: 'dsh_run', arguments: { id: 'x', waitMs: 60000 } }))
  assert.equal(invalidWait.result.isError, true)
  assert.equal(seen.length, 0)
})

test('completed answers are paged within JSON budget and intermediate text is never exposed', async () => {
  const { client, state } = mockClient()
  const dispatch = createDispatcher(client)
  for (const status of ['running', 'failed', 'killed']) {
    state.status = status
    const value = parse(await dispatch(request('tools/call', { name: 'dsh_run', arguments: { id: 'run-1', waitMs: 0 } })))
    assert.equal(value.result, undefined)
    assert.equal(value.output.available, false)
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/)
  }
  state.status = 'completed'
  const response = await dispatch(request('tools/call', { name: 'dsh_run', arguments: { id: 'run-1', waitMs: 0, maxOutputChars: 1024 } }))
  assert.ok(response.result.content[0].text.length <= 1024)
  const first = parse(response)
  assert.equal(first.output.truncated, true)
  assert.ok(first.output.nextOffset > 0)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|thinking|stderr|tail|task/)
  const second = parse(await dispatch(request('tools/call', { name: 'dsh_run', arguments: { id: 'run-1', waitMs: 0, maxOutputChars: 1024, resultOffset: first.output.nextOffset } })))
  assert.equal(second.output.offset, first.output.nextOffset)
  const weird = compactRun({ id: '\u0000'.repeat(200), sessionId: '\u0000'.repeat(512), status: 'completed', result: '\"'.repeat(10000) }, { maxOutputChars: 1024 })
  assert.ok(JSON.stringify(weird).length <= 1024)
  assert.equal(weird.sessionIdOmitted, 'output-budget')
})

test('native usage retains completeness and reasoning tokens without fabricating unknown zero buckets', async () => {
  const { client, state } = mockClient()
  state.status = 'completed'
  const usage = compactUsage(await client.get('run-1', {}))
  assert.equal(usage.source, 'native-dsh-reported')
  assert.equal(usage.completeness, 'complete')
  assert.equal(usage.tokens.reasoningTokens, 5)
  assert.equal(usage.fieldCompleteness.reasoningTokens, 'partial')
  assert.equal(usage.tokens.cacheReadTokens, undefined)
  assert.deepEqual(compactUsage({ usage: { totalTokens: 0 } }).tokens, {})
})

test('native failures return sanitized errors without private native details', async () => {
  const { client } = mockClient()
  client.run = async () => { throw Object.assign(new Error('PRIVATE_NATIVE_ERROR /personal/account token=PRIVATE'), { status: 500, body: { secret: 'PRIVATE' } }) }
  const response = await createDispatcher(client)(request('tools/call', { name: 'dsh_delegate', arguments: { task: 'authorized task' } }))
  assert.equal(response.result.isError, true)
  assert.equal(parse(response).status, 500)
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|personal|token|HTTP/)
})

test('stdio framing handles split multibyte messages and concurrent kill during a pending poll', async () => {
  const { client } = mockClient()
  let releasePoll
  let started
  const pollStarted = new Promise(resolve => { started = resolve })
  client.get = async () => { started(); return new Promise(resolve => { releasePoll = () => resolve({ id: 'run-1', status: 'killed', result: 'PRIVATE_INTERMEDIATE' }) }) }
  const input = new PassThrough()
  const output = new PassThrough()
  const error = new PassThrough()
  const messages = []
  let buffer = ''
  output.on('data', chunk => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
  })
  const serving = runStdioServer({ client, input, output, error })
  const body = Buffer.from(JSON.stringify(request('tools/call', { name: 'dsh_delegate', arguments: { task: '检查项目' } }, 1)))
  const framed = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
  input.write(framed.subarray(0, framed.length - 4))
  input.write(framed.subarray(framed.length - 4))
  input.write(JSON.stringify(request('tools/call', { name: 'dsh_run', arguments: { id: 'run-1' } }, 2)) + '\n')
  await pollStarted
  input.write(JSON.stringify(request('tools/call', { name: 'dsh_kill', arguments: { id: 'run-1' } }, 3)) + '\n')
  for (let spin = 0; spin < 20 && !messages.some(message => message.id === 3); spin += 1) await new Promise(resolve => setImmediate(resolve))
  assert.ok(messages.some(message => message.id === 3))
  releasePoll()
  input.end()
  await serving
  assert.deepEqual(messages.map(message => message.id).sort(), [1, 2, 3])
  assert.equal(parse(messages.find(message => message.id === 2)).result, undefined)
  assert.deepEqual(SERVER_INFO, { name: 'codex-dsh-connect', version: '0.1.0' })
})
