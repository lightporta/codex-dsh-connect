import { createDispatcher as createTransportDispatcher, runStdioServer as runTransport } from './stdio.js'
import { compactError, compactRun, compactStatus, integer, MAX_WAIT_MS, outputBudget } from './projection.js'
import { VERSION } from './version.js'

export const SERVER_INFO = { name: 'codex-dsh-connect', version: VERSION }
const text = description => ({ type: 'string', description })
const number = (description, minimum, maximum, defaultValue) => ({ type: 'integer', description, minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const budget = { maxOutputChars: number('Maximum JSON result characters, including metadata.', 1024, 16000, 8000) }
const wait = { waitMs: number('Bounded poll wait; stays below the usual Codex MCP timeout.', 0, MAX_WAIT_MS, MAX_WAIT_MS) }

function stringArg(value, name, max = 200000, required = false) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`invalid ${name}`)
  return value
}

export function toolDefinitions() {
  return [
    {
      name: 'dsh_status',
      description: 'Check the native DeepSeek Harness executor, account-auth mode, configured workspace, isolation backend and concurrency. Linux and WSL2 use bubblewrap; macOS uses Seatbelt.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: schema({}),
      handler: async client => compactStatus(await client.status()),
    },
    {
      name: 'dsh_delegate',
      description: 'Submit a scoped task asynchronously to native DeepSeek Harness in the explicitly configured workspace with OS filesystem isolation. Exposes only project file listing, text reading, and text writing. No shell, network, account, or old-session tools. Returns a run id for polling; does not replace Codex built-in agents.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: schema({
        task: text('Self-contained task, scoped files, acceptance criteria, and a concise final-report request. Never include credentials.'),
        cwd: text('Optional working directory inside the workspace configured at server startup. It cannot expand that authorization.'),
        timeoutMs: number('Child wall-clock budget in milliseconds; executor limits apply.', 1, 86400000),
        label: text('Short run label.'),
        ...budget,
      }, ['task']),
      handler: async (client, args) => {
        outputBudget(args.maxOutputChars)
        const run = await client.run({
          task: stringArg(args.task, 'task', 200000, true),
          cwd: stringArg(args.cwd, 'cwd', 4096),
          timeoutMs: integer(args.timeoutMs, undefined, 1, 86400000, 'timeoutMs'),
          label: stringArg(args.label, 'label', 200),
          wait: 0,
        })
        return compactRun(run, args)
      },
    },
    {
      name: 'dsh_run',
      description: 'Poll an external DSH run. Returns only bounded final-answer text and usage metadata; never raw reasoning, tool logs, or intermediate text. Follow output.nextOffset to read a further answer chunk when needed.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: schema({
        id: text('Run id returned by dsh_delegate.'),
        ...wait,
        ...budget,
        resultOffset: number('Character offset into the filtered final answer.', 0, 1000000000, 0),
      }, ['id']),
      handler: async (client, args) => {
        outputBudget(args.maxOutputChars)
        integer(args.resultOffset, 0, 0, 1000000000, 'resultOffset')
        return compactRun(await client.get(stringArg(args.id, 'id', 200, true), {
          wait: integer(args.waitMs, MAX_WAIT_MS, 0, MAX_WAIT_MS, 'waitMs'),
        }), args)
      },
    },
    {
      name: 'dsh_runs',
      description: 'List a small set of external DSH run ids and states, without task prompts or results.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: schema({ limit: number('Maximum records.', 1, 10, 5), live: { type: 'boolean', description: 'Only live runs.' } }),
      handler: async (client, args) => {
        if (args.live !== undefined && typeof args.live !== 'boolean') throw new Error('invalid live')
        const data = await client.runs({ limit: integer(args.limit, 5, 1, 10, 'limit'), live: args.live === true })
        return {
          live: typeof data?.live === 'number' ? data.live : undefined,
          runs: (Array.isArray(data?.runs) ? data.runs : []).slice(0, 10).map(run => ({
            id: typeof run.id === 'string' ? run.id.slice(0, 200) : undefined,
            status: typeof run.status === 'string' ? run.status.slice(0, 32) : undefined,
            durationMs: typeof run.durationMs === 'number' ? run.durationMs : undefined,
          })),
        }
      },
    },
    {
      name: 'dsh_kill',
      description: 'Cancel one native DSH run and terminate its process tree. Poll afterwards to confirm its final state.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: schema({ id: text('Run id.'), reason: text('Short cancellation reason.') }, ['id']),
      handler: async (client, args) => {
        const result = await client.kill(stringArg(args.id, 'id', 200, true), stringArg(args.reason, 'reason', 200))
        return {
          id: typeof result?.id === 'string' ? result.id.slice(0, 200) : undefined,
          admission: typeof result?.admission === 'string' ? result.admission.slice(0, 64) : undefined,
        }
      },
    },
  ]
}

function options() {
  return {
    tools: toolDefinitions(),
    serverInfo: SERVER_INFO,
    controlTools: ['dsh_kill'],
    projectResult: value => JSON.stringify(value),
    projectError: error => JSON.stringify(compactError(error)),
  }
}

export function createDispatcher(client) {
  return createTransportDispatcher(client, options())
}

export async function runStdioServer(params) {
  return runTransport({ ...params, ...options() })
}
