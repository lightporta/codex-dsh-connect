import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../lib/client.js'

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-direct-client-')))
  const workspace = join(root, 'project')
  await mkdir(workspace)
  const created = []
  const requests = []
  const client = await createClient({
    workspace,
    fixtureFactory: async input => {
      requests.push(input)
      const sequence = requests.length
      const scratch = join(root, `execution-${sequence}`)
      created[sequence - 1] = scratch
      await mkdir(scratch)
      await mkdir(join(scratch, 'tmp'))
      return { scratch, workspace, sequence, node: process.execPath, profileName: 'contract-smoke' }
    },
    launcherFactory: (f, { timeoutMs }) => `
      import { writeFileSync } from 'node:fs';
      const emit = value => console.log(JSON.stringify(value));
      let task = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => task += chunk);
      process.stdin.on('end', () => {
        writeFileSync(${JSON.stringify(join(root, `execution-info-${f.sequence}.json`))}, JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env), timeoutMs: ${timeoutMs} }));
        emit({ type: 'session', sessionId: ${JSON.stringify('fresh-' + f.sequence)} });
        emit({ type: 'status', phase: 'turn_start', turn: 1 });
        if (task === 'slow') { setInterval(() => {}, 1000); return; }
        emit({ type: 'thinking', text: 'PRIVATE_SYNTHETIC_TRACE' });
        emit({ type: 'status', phase: 'step_end', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
        emit({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
        emit({ type: 'final', text: 'verified' });
      });
    `,
    ...options,
  })
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { root, workspace, client, created, requests }
}

async function absent(path) {
  await assert.rejects(() => stat(path), { code: 'ENOENT' })
}

test('workspace is explicit and status never creates an execution or reads credentials', async t => {
  let invoked = false
  const client = await createClient({ fixtureFactory: async () => { invoked = true } })
  t.after(() => client.close())
  const status = await client.status()
  assert.equal(status.ready, false)
  assert.equal(status.workspaceConfigured, false)
  assert.equal(status.reason, 'workspaceRequired')
  await assert.rejects(() => client.run({ task: 'check' }), /workspaceRequired/)
  assert.equal(invoked, false)
})

test('each task has a fresh fixture and session, no resume or raw logs, and durable compact results', async t => {
  const f = await fixture(t)
  const status = await f.client.status()
  assert.equal(status.ready, true)
  assert.equal(status.auth.mode, 'account')
  assert.equal(status.limits.concurrency, 2)
  assert.equal(status.limits.timeoutMs, 120000)
  assert.equal(status.limits.maxTimeoutMs, 300000)
  assert.equal(status.limits.maxRequests, 8)
  const first = await f.client.run({ task: 'check', wait: 2000 })
  const second = await f.client.run({ task: 'check again', wait: 2000 })
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(first.status, 'completed')
  assert.equal(first.result, 'verified')
  assert.equal(first.usage.totalTokens, 5)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_SYNTHETIC_TRACE|task|stderr|tail|cwd/)
  for (const path of f.created) await absent(path)
  assert.equal(f.requests[0].workspace, f.workspace)
  assert.equal(f.requests[0].live, true)
  assert.equal(f.requests[0].auth, 'account')
  assert.equal(f.requests[0].code, true)
  assert.equal(f.requests[0].maxRequests, 8)
  const info = JSON.parse(await readFile(join(f.root, 'execution-info-1.json'), 'utf8'))
  assert.deepEqual(info.argv, ['--profile', 'contract-smoke', '--json', '-'])
  assert.equal(info.envKeys.includes('HOME'), false)
  assert.equal(info.envKeys.includes('NODE_OPTIONS'), false)
  assert.equal(info.envKeys.includes('CODEX_HOME'), false)
  assert.equal(info.envKeys.includes('DEEPSEEK_API_KEY'), false)
  assert.equal(info.timeoutMs, 120000)
  await assert.rejects(() => f.client.run({ task: 'resume', sessionId: 'old-session' }), /resume is disabled/)
  await assert.rejects(() => f.client.run({ task: 'resume', sessionId: '' }), /resume is disabled/)
  assert.equal(f.created.length, 2)
  const polled = await f.client.get(first.id)
  polled.result = 'mutated by consumer'
  assert.equal((await f.client.get(first.id)).result, 'verified')
})

test('cwd cannot redirect the executor beyond its configured canonical project', async t => {
  const f = await fixture(t)
  const outside = join(f.root, 'another-project')
  await mkdir(outside)
  for (const cwd of [outside, join(f.workspace, 'missing'), 'relative']) {
    await assert.rejects(() => f.client.run({ task: 'check', cwd }), error => error.status === 403 || error.status === 400)
  }
  assert.equal(f.created.length, 0)
  assert.equal((await f.client.run({ task: 'check', cwd: f.workspace, wait: 2000 })).status, 'completed')
})

test('an explicit symlink workspace is rejected before fixture creation', async t => {
  const f = await fixture(t)
  const alias = join(f.root, 'project-alias')
  await symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  let invoked = false
  const client = await createClient({ workspace: alias, fixtureFactory: async () => { invoked = true } })
  t.after(() => client.close())
  const status = await client.status()
  assert.equal(status.ready, false)
  assert.equal(status.reason, 'workspaceUnavailable')
  await assert.rejects(() => client.run({ task: 'check' }), /workspaceUnavailable/)
  assert.equal(invoked, false)
})

test('two concurrent executions reserve slots and cancellation releases one with cleanup', async t => {
  const f = await fixture(t)
  const [first, second] = await Promise.all([f.client.run({ task: 'slow' }), f.client.run({ task: 'slow' })])
  assert.notEqual(first.id, second.id)
  await assert.rejects(() => f.client.run({ task: 'third' }), error => error.status === 429)
  assert.equal((await f.client.runs({ live: true })).runs.length, 2)
  assert.equal((await f.client.kill(first.id, 'test cancellation')).admission, 'requested')
  assert.equal((await f.client.get(first.id, { wait: 2000 })).status, 'killed')
  await absent(f.created[0])
  assert.equal((await f.client.run({ task: 'third', wait: 2000 })).status, 'completed')
  await f.client.close()
  assert.equal((await f.client.get(second.id)).status, 'killed')
  assert.equal((await f.client.status()).limits.liveRuns, 0)
  for (const path of f.created) await absent(path)
  await assert.rejects(() => f.client.run({ task: 'after close' }), /clientClosed/)
})

test('timeout kills a synthetic child and removes its fixture before returning a terminal view', async t => {
  const f = await fixture(t)
  const run = await f.client.run({ task: 'slow', timeoutMs: 1000 })
  const final = await f.client.get(run.id, { wait: 2500 })
  assert.equal(final.status, 'failed')
  assert.equal(final.timedOut, true)
  assert.equal(final.result, undefined)
  await absent(f.created[0])
  await assert.rejects(() => f.client.run({ task: 'invalid timeout', timeoutMs: 300001 }), /timeoutMs/)
})

test('a fixture construction failure releases its slot for subsequent tasks', async t => {
  const f = await fixture(t)
  let attempts = 0
  const client = await createClient({
    workspace: f.workspace,
    fixtureFactory: async () => { attempts += 1; throw new Error('synthetic setup failure') },
  })
  t.after(() => client.close())
  for (let i = 0; i < 3; i += 1) await assert.rejects(() => client.run({ task: 'check' }), /synthetic setup failure/)
  assert.equal(attempts, 3)
  assert.equal((await client.status()).limits.liveRuns, 0)
})

test('close waits for an in-progress setup and removes its fixture before returning', async t => {
  const f = await fixture(t)
  let release, announce
  const gate = new Promise(accept => { release = accept })
  const created = new Promise(accept => { announce = accept })
  let scratch
  const client = await createClient({ workspace: f.workspace, launcherFactory: () => '', fixtureFactory: async () => {
    scratch = await mkdtemp(join(f.root, 'pending-setup-'))
    announce()
    await gate
    return { scratch, workspace: f.workspace }
  } })
  t.after(() => client.close())
  const run = assert.rejects(client.run({ task: 'check' }), /clientClosed/)
  await created
  const closing = client.close()
  release()
  await Promise.all([run, closing])
  await absent(scratch)
  assert.equal((await client.status()).limits.liveRuns, 0)
})

test('the production launcher requires an isolated boot directory before any native process starts', async t => {
  const f = await fixture(t)
  let scratch
  const client = await createClient({ workspace: f.workspace, fixtureFactory: async () => {
    scratch = await mkdtemp(join(f.root, 'invalid-launch-'))
    return { scratch, workspace: f.workspace, launchCwd: f.workspace }
  } })
  t.after(() => client.close())
  await assert.rejects(() => client.run({ task: 'check' }), /isolated launch directory/)
  await absent(scratch)
})

test('terminal history retains fifty entries without retaining any execution directories', async t => {
  const f = await fixture(t)
  let first
  for (let index = 0; index < 52; index += 1) {
    const run = await f.client.run({ task: 'quick check', wait: 2000 })
    first ??= run.id
  }
  assert.equal((await f.client.runs({ limit: 50 })).runs.length, 50)
  await assert.rejects(() => f.client.get(first), error => error.status === 404)
  assert.equal((await readdir(f.root)).some(name => name.startsWith('execution-') && !name.endsWith('.json')), false)
})
