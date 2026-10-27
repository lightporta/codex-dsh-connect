import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { authProvider, buildPolicy, classifyRequest, createFixture, guardSource, isolatedEnvironment } from '../lib/isolation.mjs'
import { canonicalWorkspace, PROJECT_TOOL_NAMES } from '../lib/project-tools.mjs'

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-isolation-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function fakeInstall(root) {
  const install = join(root, 'installation')
  const base = join(install, 'node_modules/@deepseek-ai/dsh-base')
  const headless = join(install, 'node_modules/@deepseek-ai/dsh-headless')
  await mkdir(base, { recursive: true })
  await mkdir(headless, { recursive: true })
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }))
  const ids = ['timer','llm','deepseek-llm-api-extensions','session','session-log-deepseek','agent','agent-default-model','llm-deepseek','tools','system-prompt','agent-loop','session-persistence-jsonl','session-query-sqlite','session-projection','working-directory','fs-sandbox','sandbox-policy','attachment-local','token-meter','compaction-basic','session-checkpoint-policy','tool-fs','tool-bash','agent-instructions','skill-filesystem','settings','credentials','llm-pi-ai','session-title-llm','unknown-future-plugin','authorization','deepseek-account','llm-deepseek-account']
  await writeFile(join(base, 'cordis.patch.yml'), ids.map(id => `- id: ${id}`).join('\n'))
  await writeFile(join(headless, 'cordis.patch.yml'), '- id: headless-startup\n- id: headless-runner\n')
  return install
}

async function mount(live = true, auth = 'account', code = true, maxRequests) {
  const module = await import('data:text/javascript,' + encodeURIComponent(guardSource(live, auth, code, maxRequests)))
  const listeners = new Map()
  const effects = []
  let guard
  module.apply({ tools: { guard: fn => { guard = fn } }, on: (name, fn) => listeners.set(name, fn), effect: fn => effects.push(fn()) })
  return { guard, listeners, close: () => { for (const effect of effects.reverse()) effect() } }
}

test('account is the default and only explicit API-key live mode forwards an existing key', () => {
  assert.equal(authProvider(), 'deepseek-account')
  assert.equal(authProvider('api-key'), 'deepseek-official')
  assert.throws(() => authProvider('other'))
  const source = { HOME: '/personal', CODEX_HOME: '/personal/config', NODE_OPTIONS: '--require private', HTTPS_PROXY: 'private', DSH_HOME: '/personal/dsh', DEEPSEEK_API_KEY: 'synthetic-key' }
  const scratch = join(tmpdir(), 'task')
  for (const env of [isolatedEnvironment({ scratch, source }), isolatedEnvironment({ scratch, source, live: true })]) {
    for (const key of ['HOME','CODEX_HOME','NODE_OPTIONS','HTTPS_PROXY','DEEPSEEK_API_KEY']) assert.equal(env[key], undefined)
    assert.equal(env.DSH_HOME, join(scratch, 'dsh'))
    assert.equal(env.DSH_AGENTS_HOME, join(scratch, 'agents'))
  }
  assert.equal(isolatedEnvironment({ scratch, source, live: true, auth: 'api-key' }).DEEPSEEK_API_KEY, 'synthetic-key')
})

test('explicit workspace must be an existing plain canonical project, never a broad root or symlink', async t => {
  const root = await temporary(t)
  const project = join(root, 'project')
  await mkdir(project)
  assert.equal(canonicalWorkspace(project), project)
  for (const path of ['relative', '/', homedir(), join(homedir(), 'Documents'), '/Users', '/Volumes', '/private/var', join(root, 'missing')]) assert.throws(() => canonicalWorkspace(path))
  const alias = join(root, 'alias')
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => canonicalWorkspace(alias), /symlink/)
  await mkdir(join(project, 'nested'))
  assert.throws(() => canonicalWorkspace(join(alias, 'nested')), /symlink/)
  const file = join(root, 'file')
  await writeFile(file, 'synthetic')
  assert.throws(() => canonicalWorkspace(file), /plain director/)
})

test('policy allows only the explicit workspace and scratch to be written, with credentials and runtime protected', { skip: process.platform === 'win32' ? 'Seatbelt policy paths are POSIX; Windows uses WSL2 configuration tests' : false }, async t => {
  const root = await temporary(t)
  const workspace = join(root, 'authorized-project')
  await mkdir(workspace)
  const options = { scratch: join(root, 'scratch'), installation: join(root, 'runtime'), node: join(root, 'node'), workspace, credentialFile: join(root, 'credential.yaml') }
  const check = buildPolicy(options)
  assert.match(check, /\(deny file-read\*\)/)
  assert.match(check, /\(allow file-read-metadata\)/)
  assert.match(check, /\(literal "\/"\)/)
  assert.equal(check.includes('(subpath "/")'), false)
  assert.equal(check.includes('(subpath "/Volumes")'), false)
  assert.match(check, /\(deny process-fork\)/)
  assert.equal(check.includes(options.credentialFile), false)
  const writes = check.split('\n').find(line => line.startsWith('(allow file-write*'))
  assert.equal(writes.includes(JSON.stringify(workspace)), true)
  assert.equal(writes.includes(JSON.stringify(root)), false)
  assert.equal(writes.includes(JSON.stringify(options.installation)), false)
  const live = buildPolicy({ ...options, live: true })
  assert.equal(live.includes(`(literal ${JSON.stringify(options.credentialFile)})`), true)
  assert.equal(writes.includes(options.credentialFile), false)
  assert.throws(() => buildPolicy({ ...options, credentialFile: join(workspace, 'private-key') }), /credential/)
  assert.throws(() => buildPolicy({ ...options, installation: workspace }), /Runtime/)
})

test('fixture uses the authorized project without modifying its files and composes an isolated native account runtime', { skip: process.platform === 'win32' ? 'Native fixtures run inside Linux/WSL2; Windows host does not create POSIX sandboxes' : false }, async t => {
  const root = await temporary(t)
  const installation = await fakeInstall(root)
  const workspace = join(root, 'authorized-project')
  await mkdir(workspace)
  await writeFile(join(workspace, 'math.mjs'), 'ORIGINAL_SYNTHETIC_PROJECT')
  const fixture = await createFixture({ installation, workspace, credentialFile: join(root, 'never-read-credential') })
  t.after(() => rm(fixture.scratch, { recursive: true, force: true }))
  assert.equal(fixture.workspace, workspace)
  assert.equal(fixture.launchCwd, join(fixture.scratch, 'workspace'))
  assert.notEqual(fixture.launchCwd, workspace)
  assert.equal(fixture.auth, 'account')
  assert.equal(fixture.code, true)
  assert.equal(fixture.maxRequests, 8)
  assert.equal(fixture.profileName, 'contract-smoke')
  assert.equal(await readFile(join(workspace, 'math.mjs'), 'utf8'), 'ORIGINAL_SYNTHETIC_PROJECT')
  const overlay = await readFile(fixture.overlay, 'utf8')
  for (const id of ['tool-fs','tool-bash','agent-instructions','skill-filesystem','settings','llm-pi-ai','llm-deepseek','session-title-llm','unknown-future-plugin']) assert.match(overlay, new RegExp(`- id: ${id}\\n  disabled: true`))
  assert.match(overlay, /provider: deepseek-account\n    model: deepseek-flash/)
  assert.equal(overlay.includes(`- id: fs-sandbox\n  config:\n    cwd: ${JSON.stringify(workspace)}`), true)
  assert.match(overlay, /- id: authorization\n  disabled: false/)
  assert.match(overlay, /- id: deepseek-account\n  disabled: false/)
  assert.equal(overlay.includes('never-read-credential'), false)
  assert.equal((await readFile(fixture.policy, 'utf8')).includes('never-read-credential'), false)
  assert.equal(await readFile(join(fixture.scratch, 'empty-credentials.yaml'), 'utf8'), 'version: 1\nrefs: {}\nrecords: {}\n')
  assert.equal((await readFile(join(fixture.scratch, 'project-tools.mjs'), 'utf8')).includes(JSON.stringify(workspace)), true)
  assert.match(await readFile(join(fixture.scratch, 'contract-no-tools.mjs'), 'utf8'), /if \(!false\) throw/)
})

test('workspace-free fixture remains synthetic, while live API-key credentials are still not read by the supervisor', { skip: process.platform === 'win32' ? 'Native fixtures run inside Linux/WSL2; Windows host does not create POSIX sandboxes' : false }, async t => {
  const root = await temporary(t)
  const installation = await fakeInstall(root)
  const code = await createFixture({ installation, live: true, auth: 'api-key', credentialFile: join(root, 'nonexistent-key'), maxRequests: 3 })
  t.after(() => rm(code.scratch, { recursive: true, force: true }))
  assert.equal(code.workspace, join(code.scratch, 'workspace'))
  assert.equal(await readFile(join(code.workspace, 'math.mjs'), 'utf8'), 'export function add(a, b) { return a - b }\n')
  assert.equal(code.maxRequests, 3)
  const overlay = await readFile(code.overlay, 'utf8')
  assert.match(overlay, /provider: deepseek-official/)
  assert.match(overlay, /- id: credentials\n  disabled: false/)
  assert.equal(overlay.includes(join(root, 'nonexistent-key')), true)
  const text = await createFixture({ installation, code: false })
  t.after(() => rm(text.scratch, { recursive: true, force: true }))
  assert.equal(text.maxRequests, 1)
  assert.equal((await readFile(text.overlay, 'utf8')).includes('- id: project-tools'), false)
  const credentialProject = join(root, 'credential-project')
  await mkdir(credentialProject)
  await assert.rejects(createFixture({ installation, workspace: credentialProject, credentialFile: join(credentialProject, 'private-key') }), /credential/)
})

test('project guard permits exactly the three capabilities and eight native model steps by default', async () => {
  const mounted = await mount()
  try {
    for (const name of PROJECT_TOOL_NAMES) assert.equal(mounted.guard({ name }), undefined)
    for (const name of ['bash','read','web_fetch','spawn_agent']) assert.equal(typeof mounted.guard({ name }), 'string')
    let mask
    mounted.listeners.get('agent/created')({ agent: { ctx: { tools: { restrict: value => { mask = value } } } } })
    assert.deepEqual(mask, { allow: PROJECT_TOOL_NAMES })
    const call = mounted.listeners.get('llm/stream')
    const tools = PROJECT_TOOL_NAMES.map(name => ({ name }))
    assert.throws(() => call({ provider: 'other', model: 'deepseek-flash', tools }, () => []), /provider/)
    assert.throws(() => call({ provider: 'deepseek-account', model: 'other', tools }, () => []), /native model/)
    assert.throws(() => call({ provider: 'deepseek-account', model: 'deepseek-flash', tools: [tools[0],tools[0],tools[0]] }, () => []), /catalog/)
    for (let index = 0; index < 8; index += 1) assert.deepEqual(call({ provider: 'deepseek-account', model: 'deepseek-flash', tools }, () => []), [])
    assert.throws(() => call({ provider: 'deepseek-account', model: 'deepseek-flash', tools }, () => []), /Only 8/)
  } finally { mounted.close() }
})

test('fixture construction removes scratch when late runtime overlap validation fails', { skip: process.platform === 'win32' ? 'Native fixtures run inside Linux/WSL2; Windows host rejects them before allocation' : false }, async t => {
  const root = await temporary(t)
  const installation = await fakeInstall(root)
  const before = await readdir(installation)
  // The synthetic project would be nested in the runtime. This reaches policy
  // validation after profile files exist and must remove the entire new scratch.
  await assert.rejects(createFixture({ installation, parent: installation, code: false }), /workspaceMustNotContainRuntime/)
  assert.deepEqual(await readdir(installation), before)
})

test('request bounds are explicit integers 1..16 and text mode keeps its one-request empty-tool contract', async () => {
  for (const limit of [0,17,-1,1.5,NaN,'8']) assert.throws(() => guardSource(true, 'account', true, limit), /1 to 16/)
  const mounted = await mount(true, 'api-key', false)
  try {
    const call = mounted.listeners.get('llm/stream')
    const request = { provider: 'deepseek-official', model: 'deepseek-flash', tools: [] }
    assert.equal(typeof mounted.guard({ name: 'project_read_text' }), 'string')
    call(request, () => [])
    assert.throws(() => call(request, () => []), /Only one/)
  } finally { mounted.close() }
  const check = await mount(false)
  try {
    assert.throws(() => check.listeners.get('llm/stream')({}, () => []), /disabled in check/)
    assert.throws(() => globalThis.fetch('https://api.deepseek.com/models'), /disabled by isolated/)
  } finally { check.close() }
})

test('account HTTP boundary blocks profile, wallet, bonus, history and Files and bounds model dispatches', async () => {
  assert.equal(classifyRequest('https://api.deepseek.com/models'), 'models')
  assert.equal(classifyRequest('https://api.deepseek.com/models', {}, 'api-key'), undefined)
  for (const url of ['https://platform.deepseek.com/auth-api/v0/users/current','https://platform.deepseek.com/api/v0/users/get_user_summary','https://platform.deepseek.com/api/v0/users/get_unnotified_bonuses','https://api.deepseek.com/history','https://api.deepseek.com/anthropic/v1/files','https://api.deepseek.com/models?user_id=private','https://token@api.deepseek.com/models']) assert.equal(classifyRequest(url), undefined)
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => { calls.push({ input, redirect: init.redirect }); return {} }
  const mounted = await mount(true, 'account', true, 2)
  try {
    assert.throws(() => globalThis.fetch('https://platform.deepseek.com/auth-api/v0/users/current'), /disabled by isolated/)
    assert.equal(calls.length, 0)
    await globalThis.fetch('https://api.deepseek.com/models')
    for (let index = 0; index < 2; index += 1) await globalThis.fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST' })
    assert.equal(calls.length, 3)
    assert.equal(calls.every(call => call.redirect === 'error'), true)
    assert.throws(() => globalThis.fetch('https://api.deepseek.com/models'), /disabled by isolated/)
    assert.throws(() => globalThis.fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST' }), /disabled by isolated/)
  } finally { mounted.close(); globalThis.fetch = original }
})
