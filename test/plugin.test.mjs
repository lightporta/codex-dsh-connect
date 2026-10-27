import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configurePlugin, pluginLaunch, pluginSettingsPath, readPluginSettings, validatePluginSettings } from '../lib/plugin.js'
import { buildWslLaunch } from '../lib/windows-wsl.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const runFile = promisify(execFile)

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-dsh-plugin-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'project')
  await mkdir(workspace)
  return { directory, workspace, settingsFile: join(directory, 'settings.json') }
}

async function startPlugin(t, settingsFile) {
  const config = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')).mcpServers.codex_dsh_connect
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', root)
  const child = spawn(expand(config.command), [...config.args.map(expand), '--settings-file', settingsFile], {
    cwd: expand(config.cwd), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
  })
  let stderr = ''
  let buffered = ''
  let nextId = 0
  const pending = new Map()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      const waiter = pending.get(message.id)
      if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message) }
    }
  })
  const failed = error => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    pending.clear()
  }
  child.once('error', failed)
  child.once('close', code => failed(new Error(`plugin exited with ${code}: ${stderr}`)))
  t.after(async () => {
    child.stdin.end()
    if (child.exitCode === null) {
      await new Promise(resolve => {
        const watchdog = setTimeout(() => { child.kill(); resolve() }, 2000)
        child.once('close', () => { clearTimeout(watchdog); resolve() })
      })
    }
    assert.equal(stderr.includes(settingsFile), false)
  })
  return async (method, params) => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`plugin request timed out: ${method}; ${stderr}`)) }, 5000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
}

const content = response => JSON.parse(response.result.content[0].text)

test('plugin configuration saves explicit paths and limits without accessing credential contents', async t => {
  const { directory, workspace, settingsFile } = await fixture(t)
  const options = { workspace, installation: join(directory, 'absent-dsh'), credentialFile: join(directory, 'absent-login.yaml'), maxRequests: 2, timeoutMs: 45000 }
  const saved = await configurePlugin({ ...options, settingsFile })
  assert.equal(saved.configured, settingsFile)
  assert.equal(saved.restartRequired, true)
  assert.deepEqual(await readPluginSettings(settingsFile), options)
  assert.equal(await readPluginSettings(join(directory, 'not-configured.json')), undefined)
  assert.deepEqual(pluginLaunch(options).args, [
    'mcp', '--workspace', workspace, '--dsh-root', options.installation,
    '--credential-file', options.credentialFile, '--max-requests', '2', '--timeout-ms', '45000',
  ])
  await assert.rejects(access(options.credentialFile), { code: 'ENOENT' })
  assert.deepEqual(Object.keys(JSON.parse(await readFile(settingsFile, 'utf8'))).sort(), ['version', ...Object.keys(options)].sort())
})

test('plugin settings require explicit authorization and reject arbitrary execution settings', async t => {
  const { directory, workspace, settingsFile } = await fixture(t)
  for (const value of [null, [], {}, { version: 2, workspace }, { version: 1 }, { version: 1, workspace: '.' },
    { version: 1, workspace, command: 'unexpected' }, { version: 1, workspace, env: { SECRET: 'unexpected' } },
    { version: 1, workspace, maxRequests: 17 }, { version: 1, workspace, timeoutMs: 999 }]) {
    assert.throws(() => validatePluginSettings(value))
  }
  assert.throws(() => pluginSettingsPath('relative.json'))
  assert.throws(() => pluginSettingsPath(settingsFile + '\n'))
  await assert.rejects(configurePlugin({ workspace, settingsFile: join(workspace, 'settings.json') }), /outside the workspace/)
  const movedFile = join(workspace, 'manually-moved.json')
  await writeFile(movedFile, JSON.stringify({ version: 1, workspace }))
  await assert.rejects(readPluginSettings(movedFile), /invalid plugin settings/)
  const alias = join(directory, 'project-alias')
  await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(configurePlugin({ workspace, settingsFile: join(alias, 'settings.json') }), /outside the workspace/)
  await writeFile(settingsFile, '{malformed')
  await assert.rejects(readPluginSettings(settingsFile), /invalid plugin settings/)
  await writeFile(settingsFile, JSON.stringify({ version: 1, workspace, command: 'unexpected' }))
  await assert.rejects(readPluginSettings(settingsFile), /invalid plugin settings/)
})

test('plugin settings protect existing configuration and preserve a backup before replacement', async t => {
  const { workspace, settingsFile } = await fixture(t)
  await configurePlugin({ workspace, settingsFile, maxRequests: 2 })
  const original = await readFile(settingsFile, 'utf8')
  await assert.rejects(configurePlugin({ workspace, settingsFile, maxRequests: 3 }), /already exist/)
  assert.equal(await readFile(settingsFile, 'utf8'), original)
  const replaced = await configurePlugin({ workspace, settingsFile, maxRequests: 3, force: true })
  assert.equal(await readFile(replaced.backup, 'utf8'), original)
  assert.equal((await readPluginSettings(settingsFile)).maxRequests, 3)
})

test('bundled MCP starts unconfigured and refuses delegation instead of inferring a workspace', async t => {
  const { settingsFile } = await fixture(t)
  const request = await startPlugin(t, settingsFile)
  const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' } })
  assert.equal(initialized.result.serverInfo.name, 'codex-dsh-connect')
  const tools = await request('tools/list', {})
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ['dsh_status', 'dsh_delegate', 'dsh_run', 'dsh_runs', 'dsh_kill'])
  const status = content(await request('tools/call', { name: 'dsh_status', arguments: {} }))
  assert.equal(status.ready, false)
  assert.equal(status.reason, 'workspaceRequired')
  assert.equal(status.workspaceConfigured, false)
  const denied = await request('tools/call', { name: 'dsh_delegate', arguments: { task: 'This must never start a model request' } })
  assert.equal(denied.result.isError, true)
  assert.equal(content(denied).status, 400)
  const runs = content(await request('tools/call', { name: 'dsh_runs', arguments: {} }))
  assert.deepEqual(runs.runs, [])
})

test('plugin status uses saved limits and projects configuration paths out of its result', async t => {
  const { directory, workspace, settingsFile } = await fixture(t)
  await configurePlugin({ workspace, settingsFile, installation: join(directory, 'absent-native-install'), credentialFile: join(directory, 'private-login.yaml'), maxRequests: 3, timeoutMs: 45000 })
  const result = await runFile(process.execPath, [join(root, 'bin/codex-dsh-plugin.mjs'), 'status', '--settings-file', settingsFile], { cwd: directory, windowsHide: true })
  const status = JSON.parse(result.stdout)
  assert.equal(status.ready, false)
  assert.equal(status.workspaceConfigured, true)
  assert.equal(status.limits.maxRequests, 3)
  assert.equal(status.limits.timeoutMs, 45000)
  assert.equal(result.stdout.includes(directory), false)
  assert.equal(result.stdout.includes('private-login'), false)
  assert.equal(result.stderr, '')
})

test('plugin WSL status keeps the validated argv launcher and changes only its subcommand', () => {
  const options = {
    wslDistro: 'mcp', wslNode: '/usr/bin/node', wslCli: '/opt/connector with spaces/bin/codex-dsh-connect.mjs',
    workspace: '/home/demo/project', installation: '/opt/native-dsh', credentialFile: '/home/demo/.dsh/login.yaml',
    maxRequests: 3, timeoutMs: 45000,
  }
  assert.deepEqual(validatePluginSettings({ version: 1, ...options }), options)
  const expected = buildWslLaunch({ distribution: options.wslDistro, nodePath: options.wslNode, cliPath: options.wslCli, ...options })
  assert.deepEqual(pluginLaunch(options), expected)
  const status = pluginLaunch(options, 'status')
  const differences = status.args.flatMap((value, index) => value === expected.args[index] ? [] : [index])
  assert.deepEqual(differences, [9])
  assert.equal(expected.args[differences[0]], 'mcp')
  assert.equal(status.args[differences[0]], 'status')
  assert.equal(status.command, 'wsl.exe')
  assert.equal(status.args[1], 'mcp')
  assert.ok(status.args.includes(options.wslCli))
  assert.throws(() => pluginLaunch(options, 'run'))
})

test('portable plugin includes its discoverable workflows and all referenced resources', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, pkg.name)
  assert.equal(manifest.version, pkg.version)
  const extension = manifest.extensions['com.openai']
  for (const path of [extension.onboardingSkill, extension.interface.logo, extension.interface.composerIcon, './skills/codex-dsh-connect/SKILL.md', './bin/codex-dsh-plugin.mjs']) {
    assert.ok(path.startsWith('./'))
    assert.equal(path.includes('..'), false)
    await access(join(root, path))
  }
  for (const entry of ['skills', 'assets', 'plugin.json', 'mcp.json']) assert.ok(pkg.files.includes(entry))
})
