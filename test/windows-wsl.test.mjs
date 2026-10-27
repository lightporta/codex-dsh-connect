import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWslLaunch, generateWslCodexConfig } from '../lib/windows-wsl.mjs'

const options = {
  distribution: 'Ubuntu-24.04', workspace: '/home/alice/projects/app',
  cliPath: '/opt/codex-dsh-connect/bin/codex-dsh-connect.mjs',
  nodePath: '/usr/local/bin/node', installation: '/opt/deepseek/dsh',
}

test('WSL configuration selects an explicit distro and invokes Linux Node with a clean environment and no shell', () => {
  const launch = buildWslLaunch(options)
  assert.equal(launch.command, 'wsl.exe')
  assert.deepEqual(launch.args, [
    '--distribution', 'Ubuntu-24.04', '--exec', '/usr/bin/env', '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8',
    options.nodePath, options.cliPath, 'mcp', '--workspace', options.workspace, '--dsh-root', options.installation,
  ])
  assert.equal(launch.args.some(value => /^(?:HOME|NODE_OPTIONS|DEEPSEEK_API_KEY|WSLENV)=/.test(value)), false)
  assert.equal(launch.args.includes('-c'), false)
})

test('WSL preserves metacharacters and spaces as single argv values without interpolation', () => {
  const workspace = '/home/alice/projects/space $name; `test`'
  const launch = buildWslLaunch({ ...options, workspace, distribution: 'Custom Ubuntu' })
  assert.equal(launch.args[1], 'Custom Ubuntu')
  assert.equal(launch.args[launch.args.indexOf('--workspace') + 1], workspace)
  const config = generateWslCodexConfig({ ...options, workspace })
  const encoded = config.split('\n').find(line => line.startsWith('args = ')).slice(7)
  assert.deepEqual(JSON.parse(encoded), buildWslLaunch({ ...options, workspace }).args)
})

test('WSL requires explicit Linux paths instead of inferring host paths or defaults', () => {
  assert.throws(() => buildWslLaunch(), /distribution/)
  for (const key of ['workspace', 'cliPath', 'nodePath', 'installation']) {
    for (const bad of [undefined, 'relative', 'C:\\Users\\alice', '/home/alice/../app', '/project\nnext', '//server/share', '/opt/app/']) {
      assert.throws(() => buildWslLaunch({ ...options, [key]: bad }), /Linux path|broad root/)
    }
  }
  for (const bad of ['', '-Ubuntu', ' Ubuntu', 'Ubuntu\n', 'Ubuntu;id', 'Ubuntu/24']) {
    assert.throws(() => buildWslLaunch({ ...options, distribution: bad }), /distribution/)
  }
})

test('WSL rejects broad workspaces and overlapping runtime or credentials', () => {
  for (const workspace of ['/', '/home', '/home/alice', '/home/alice/Documents', '/mnt/c', '/usr', '/tmp']) {
    assert.throws(() => buildWslLaunch({ ...options, workspace }), /broad root/)
  }
  for (const [key, value] of [
    ['workspace', '/opt/codex-dsh-connect'], ['workspace', '/opt/deepseek/dsh/project'],
    ['installation', options.workspace], ['credentialFile', options.workspace + '/.credentials.yaml'],
    ['credentialFile', options.installation + '/credential'],
  ]) assert.throws(() => buildWslLaunch({ ...options, [key]: value }), /runtime|credential/)
})

test('WSL forwards explicit account credential path and bounded runtime settings without credential contents', () => {
  const launch = buildWslLaunch({ ...options, credentialFile: '/home/alice/.dsh/.credentials.yaml', maxRequests: 4, timeoutMs: 60000 })
  assert.deepEqual(launch.args.slice(-6), ['--credential-file', '/home/alice/.dsh/.credentials.yaml', '--max-requests', '4', '--timeout-ms', '60000'])
  for (const [key, values] of [['maxRequests', [0, 17, 1.5, '8']], ['timeoutMs', [999, 300001, NaN, '1000']]]) {
    for (const value of values) assert.throws(() => buildWslLaunch({ ...options, [key]: value }), /invalid/)
  }
})

test('WSL TOML contains one fixed stdio server and declares the WSL2 prerequisite', () => {
  const config = generateWslCodexConfig(options)
  assert.match(config, /Requires WSL2/)
  assert.match(config, /command = "wsl.exe"/)
  assert.match(config, /startup_timeout_sec = 30/)
  assert.equal((config.match(/\[mcp_servers\./g) ?? []).length, 1)
})
