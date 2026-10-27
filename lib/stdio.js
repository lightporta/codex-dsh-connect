import { VERSION } from './version.js'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'codex-dsh-connect', version: VERSION }
const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_PENDING_REQUESTS = 32
const MAX_QUEUED_OUTPUT_BYTES = 1024 * 1024

function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return { content: [{ type: 'text', text }] }
}

export function createDispatcher(client, options = {}) {
  const tools = new Map((options.tools ?? []).map(tool => [tool.name, tool]))
  const serverInfo = options.serverInfo ?? SERVER_INFO

  return async function dispatch(request) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)
      || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC request' } }
    }
    const id = request.id
    if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC id' } }
    }
    if (id === undefined) return undefined
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        },
      }
    }
    if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return undefined
    if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (request.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [...tools.values()].map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations === undefined ? {} : { annotations }) })),
        },
      }
    }
    if (request.method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } }
    if (request.method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } }
    if (request.method === 'tools/call') {
      const name = request.params?.name
      const tool = tools.get(name)
      if (tool === undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } }
      }
      const args = request.params?.arguments ?? {}
      const properties = tool.inputSchema?.properties ?? {}
      if (args === null || typeof args !== 'object' || Array.isArray(args)
        || (tool.inputSchema?.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(properties, key)))
        || (tool.inputSchema?.required ?? []).some(key => !Object.hasOwn(args, key))) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid tool arguments' } }
      }
      try {
        const value = await tool.handler(client, args)
        const projected = options.projectResult === undefined ? value : await options.projectResult(value, name)
        return { jsonrpc: '2.0', id, result: toolResult(projected) }
      } catch (error) {
        try {
          if (options.projectError !== undefined) {
            return { jsonrpc: '2.0', id, result: { ...toolResult(await options.projectError(error)), isError: true } }
          }
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'executor tool failed' }], isError: true },
          }
        } catch {
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'bridge tool failed' }], isError: true } }
        }
      }
    }
    if (request.id === undefined) return undefined
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }
  }
}

export async function runStdioServer({ client, input = process.stdin, output = process.stdout, error = process.stderr, ...options }) {
  const dispatch = createDispatcher(client, options)
  let buffer = Buffer.alloc(0)
  const pending = new Set()
  let pendingControl = 0
  let ended = false
  let completed = false
  let backpressured = false
  let queuedOutputBytes = 0
  const outputQueue = []
  let resolveServing
  let rejectServing

  const fail = failure => {
    if (completed) return
    completed = true
    input.pause?.()
    outputQueue.length = 0
    queuedOutputBytes = 0
    rejectServing(failure)
  }

  function maybeComplete() {
    if (!completed && ended && buffer.length === 0 && pending.size === 0 && outputQueue.length === 0) {
      completed = true
      output.end()
      resolveServing()
    }
  }

  const send = message => {
    if (message === undefined || completed) return
    const line = JSON.stringify(message) + '\n'
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_MESSAGE_BYTES) { fail(new Error('JSON-RPC output exceeds 1 MiB')); return }
    if (backpressured) {
      if (queuedOutputBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) { fail(new Error('JSON-RPC output queue exceeds 1 MiB')); return }
      outputQueue.push({ line, bytes })
      queuedOutputBytes += bytes
    } else if (!output.write(line)) {
      backpressured = true
      input.pause?.()
    }
  }

  async function consume(text) {
    let request
    try {
      request = JSON.parse(text)
    } catch {
      error.write('invalid JSON-RPC message\n')
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } })
      return
    }
    const control = request?.method === 'tools/call' && (options.controlTools ?? []).includes(request?.params?.name)
    if (pending.size >= MAX_PENDING_REQUESTS && (!control || pendingControl >= 4)) {
      send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: 'too many concurrent requests' } })
      return
    }
    if (control) pendingControl += 1
    try {
      const response = await dispatch(request)
      send(response)
    } finally {
      if (control) pendingControl -= 1
    }
  }

  function schedule(body) {
    const task = consume(body).catch(consumeError => {
      error.write('JSON-RPC request failed\n')
    }).finally(() => { pending.delete(task); maybeComplete() })
    pending.add(task)
  }

  function drain() {
    while (buffer.length > 0 && !backpressured && !completed) {
      if (buffer.subarray(0, 15).toString('ascii') === 'Content-Length:') {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const firstHeader = buffer.subarray(0, headerEnd).toString('ascii').split(/\r\n/, 1)[0]
        const length = Number(firstHeader.slice('Content-Length:'.length).trim())
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) throw new Error('invalid or oversized Content-Length')
        if (buffer.length < headerEnd + 4 + length) return
        const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')
        buffer = buffer.subarray(headerEnd + 4 + length)
        schedule(body)
        continue
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      if (newline > MAX_MESSAGE_BYTES) throw new Error('JSON-RPC message exceeds 1 MiB')
      const line = buffer.subarray(0, newline).toString('utf8').trim()
      buffer = buffer.subarray(newline + 1)
      if (line.length > 0) {
        schedule(line)
      }
    }
  }

  function flushEnd() {
    if (!ended || backpressured || completed) return
    if (buffer.length > MAX_MESSAGE_BYTES) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC message exceeds 1 MiB' } })
    } else if (buffer.length > 0) schedule(buffer.toString('utf8'))
    buffer = Buffer.alloc(0)
    maybeComplete()
  }

  function outputDrained() {
    if (completed) return
    backpressured = false
    while (outputQueue.length > 0 && !backpressured) {
      const item = outputQueue.shift()
      queuedOutputBytes -= item.bytes
      backpressured = !output.write(item.line)
    }
    if (backpressured) return
    try { drain(); flushEnd() } catch (failure) { fail(failure); return }
    if (!ended && !backpressured && !completed) input.resume?.()
    maybeComplete()
  }

  error.write(`${(options.serverInfo ?? SERVER_INFO).name} MCP server ready on stdio\n`)
  await new Promise((resolve, reject) => {
    resolveServing = resolve
    rejectServing = reject
    const finish = () => {
      if (ended) return
      ended = true
      flushEnd()
    }
    input.on('data', chunk => {
      if (ended || completed) return
      try {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
        drain()
        if (buffer.length > MAX_MESSAGE_BYTES + 8192) throw new Error('JSON-RPC message exceeds 1 MiB')
      } catch (failure) {
        error.write(`${failure.message}\n`)
        buffer = Buffer.alloc(0)
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: failure.message } })
        input.destroy?.()
        finish()
      }
    })
    input.once('end', finish)
    input.once('close', finish)
    input.once('error', fail)
    output.on('drain', outputDrained)
    output.once('error', fail)
  }).finally(() => {
    output.off('drain', outputDrained)
    output.off('error', fail)
    input.off('error', fail)
  })
}

