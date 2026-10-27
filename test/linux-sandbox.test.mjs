import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BWRAP_PATH, assertLinuxFixture, buildLinuxLaunch } from '../lib/linux-sandbox.mjs'

const fixture = overrides => ({
  scratch: '/tmp/dsh-isolated-123', workspace: '/home/tester/project',
  installation: '/home/tester/.local/share/dsh', node: '/opt/node/bin/node',
  launchCwd: '/tmp/dsh-isolated-123/workspace',
  credentialFile: '/home/tester/.dsh/.credentials.yaml', live: false,
  args: ['/home/tester/.local/share/dsh/lib/bin.js', '--json', '-'],
  ...overrides,
})

function mounts(args, flag) {
  return args.flatMap((arg, index) => arg === flag ? [[args[index + 1], args[index + 2]]] : [])
}

test('Linux simulated launch binds only explicit writable task roots', () => {
  const launch = buildLinuxLaunch(fixture())
  assert.equal(launch.command, BWRAP_PATH)
  assert.equal(launch.cwd, '/tmp/dsh-isolated-123/workspace')
  assert.deepEqual(launch.env, {})
  assert.deepEqual(mounts(launch.args, '--bind'), [
    ['/tmp/dsh-isolated-123', '/tmp/dsh-isolated-123'],
    ['/home/tester/project', '/home/tester/project'],
  ])
  assert.ok(launch.args.includes('--remount-ro'))
  assert.deepEqual(launch.args.slice(launch.args.indexOf('--remount-ro'), launch.args.indexOf('--remount-ro') + 2), ['--remount-ro', '/'])
  assert.ok(mounts(launch.args, '--ro-bind').some(([source]) => source === '/opt/node/bin/node'))
  const readonly = mounts(launch.args, '--ro-bind-try').map(([source]) => source)
  assert.ok(!readonly.includes('/usr') && !readonly.includes('/etc'))
  for (const path of ['/', '/home', '/run', '/mnt', '/opt']) {
    assert.ok(!mounts(launch.args, '--ro-bind').some(([source]) => source === path))
  }
})

test('Linux check launch isolates network and all namespaces without original credentials', () => {
  const { args } = buildLinuxLaunch(fixture())
  for (const flag of ['--unshare-all', '--unshare-user', '--new-session', '--die-with-parent', '--clearenv']) assert.ok(args.includes(flag))
  assert.ok(!args.includes('--share-net'))
  assert.ok(!args.includes('/home/tester/.dsh/.credentials.yaml'))
  assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL'])
})

test('Linux live launch explicitly shares network and binds one readonly credential file', () => {
  const { args } = buildLinuxLaunch(fixture({ live: true }))
  assert.ok(args.includes('--share-net'))
  assert.deepEqual(mounts(args, '--ro-bind').filter(([source]) => source.includes('.credentials')), [
    ['/home/tester/.dsh/.credentials.yaml', '/home/tester/.dsh/.credentials.yaml'],
  ])
  assert.ok(!args.includes('/home/tester/.dsh'))
})

test('Linux launch handles a synthetic project inside scratch without duplicate mounts', () => {
  const { args } = buildLinuxLaunch(fixture({ workspace: '/tmp/dsh-isolated-123/workspace' }))
  assert.equal(mounts(args, '--bind').length, 1)
})

test('Linux argv preserves spaces and shell metacharacters as literal arguments', () => {
  const taskArg = '$(touch /tmp/should-not-exist); "quoted" `code`'
  const { args } = buildLinuxLaunch(fixture({ workspace: '/home/tester/my project', args: ['-e', taskArg] }))
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '/opt/node/bin/node', '-e', taskArg])
  assert.ok(args.includes('/home/tester/my project'))
})

test('Linux environment rejects inherited home, preload and proxy configuration', () => {
  for (const key of ['HOME', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'HTTP_PROXY', 'WSLENV', 'DSH_CONFIG']) {
    assert.throws(() => buildLinuxLaunch(fixture({ env: { [key]: 'unsafe' } })), /invalidLinuxEnvironment/)
  }
  assert.throws(() => buildLinuxLaunch(fixture({ env: { LANG: 'C\0unsafe' } })), /invalidLinuxEnvironment/)
})

test('Linux environment contains only task-specific profile and temporary locations', () => {
  const { args } = buildLinuxLaunch(fixture())
  const env = Object.fromEntries(mounts(args, '--setenv'))
  assert.deepEqual(env, {
    HOME: '/tmp/dsh-isolated-123', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8',
    TMPDIR: '/tmp/dsh-isolated-123/tmp', DSH_HOME: '/tmp/dsh-isolated-123/dsh',
    DSH_AGENTS_HOME: '/tmp/dsh-isolated-123/agents', DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
  })
})

test('Linux launch rejects broad system and personal root mounts', () => {
  for (const key of ['scratch', 'workspace', 'installation']) {
    for (const path of ['/', '/home', '/home/tester', '/tmp', '/usr', '/etc', '/mnt/c', '/home/tester/.ssh']) {
      assert.throws(() => buildLinuxLaunch(fixture({ [key]: path })), /unsafeLinuxRoot/)
    }
  }
})

test('Linux launch rejects runtime overwrite and overlapping task roots', () => {
  for (const overrides of [
    { installation: '/home/tester/project/native' },
    { node: '/home/tester/project/node' },
    { node: '/tmp/dsh-isolated-123/node' },
    { workspace: '/tmp/dsh-isolated-123' },
    { scratch: '/home/tester/project/scratch', launchCwd: '/home/tester/project/scratch/workspace' },
  ]) assert.throws(() => buildLinuxLaunch(fixture(overrides)), /workspaceMustNot/)
  for (const workspace of ['/usr/lib/my-project', '/proc/project', '/dev/project']) {
    assert.throws(() => buildLinuxLaunch(fixture({ workspace })), /workspaceMustNotOverlapSystemRuntime/)
  }
  assert.throws(() => buildLinuxLaunch(fixture({ launchCwd: '/home/tester/project' })), /linuxLaunchDirectoryMustBeInsideScratch/)
})

test('Linux launch rejects credential files exposed through existing mounts', () => {
  for (const credentialFile of [
    '/tmp/dsh-isolated-123/token', '/home/tester/project/token',
    '/home/tester/.local/share/dsh/token', '/usr/lib/token', '/etc/ssl/certs/token', '/etc/hosts', '/opt/node/bin/node',
  ]) assert.throws(() => buildLinuxLaunch(fixture({ credentialFile, live: true })), /credentialMustBeOutsideAllowedTrees/)
})

test('Linux launch rejects noncanonical paths, NUL arguments and nonboolean live flags', () => {
  for (const workspace of ['relative/project', '/home/tester/project/../other', '/home/tester/project/', '//home/tester/project', '/home/tester/project\nunsafe']) {
    assert.throws(() => buildLinuxLaunch(fixture({ workspace })), /Linux.*Path|canonicalLinuxPath/)
  }
  assert.throws(() => buildLinuxLaunch(fixture({ args: ['\0'] })), /invalidLinuxLaunchArguments/)
  assert.throws(() => buildLinuxLaunch(fixture({ live: 'true' })), /invalidLinuxLaunchArguments/)
})

async function withDiskFixture(fn) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-linux-policy-')))
  try {
    const scratch = join(base, 'scratch'), workspace = join(base, 'project'), installation = join(base, 'native')
    for (const path of [scratch, workspace, installation, join(scratch, 'workspace')]) await mkdir(path, { recursive: true })
    const credentialFile = join(base, 'account.yaml')
    await writeFile(credentialFile, 'synthetic-only')
    await fn({ scratch, workspace, installation, node: await realpath(process.execPath), launchCwd: join(scratch, 'workspace'), credentialFile, live: true, auth: 'account' }, base)
  } finally { await rm(base, { recursive: true, force: true }) }
}

const posixMetadata = { skip: process.platform === 'win32' ? 'Linux metadata preflight requires POSIX paths; Windows launch policy is tested above and in WSL configuration tests' : false }

test('Linux fixture preflight accepts canonical metadata with a plain credential file', posixMetadata, async () => {
  await withDiskFixture(async data => { await assertLinuxFixture(data) })
})

test('Linux fixture preflight rejects directory, symlink and hardlinked credentials', posixMetadata, async () => {
  await withDiskFixture(async (data, base) => {
    await assert.rejects(assertLinuxFixture({ ...data, credentialFile: base }), /invalidLinuxCredentialFile/)
    const alias = join(base, 'alias.yaml')
    await symlink(data.credentialFile, alias)
    await assert.rejects(assertLinuxFixture({ ...data, credentialFile: alias }), /invalidLinuxCredentialFile/)
    const hard = join(base, 'hard.yaml')
    await link(data.credentialFile, hard)
    await assert.rejects(assertLinuxFixture({ ...data, credentialFile: hard }), /invalidLinuxCredentialFile/)
  })
})

test('Linux fixture preflight rejects symlink runtime mounts', posixMetadata, async () => {
  await withDiskFixture(async (data, base) => {
    const alias = join(base, 'native-alias')
    await symlink(data.installation, alias, 'dir')
    await assert.rejects(assertLinuxFixture({ ...data, installation: alias }), /canonicalLinuxFixtureRequired/)
  })
})

test('Linux offline fixture does not inspect original credential metadata', posixMetadata, async () => {
  await withDiskFixture(async (data, base) => {
    await assertLinuxFixture({ ...data, live: false, credentialFile: join(base, 'does-not-exist') })
  })
})


test('Linux fixture preflight rejects a symlink launch directory', posixMetadata, async () => {
  await withDiskFixture(async (data, base) => {
    const alias = join(data.scratch, 'launch-alias')
    await symlink(data.launchCwd, alias, 'dir')
    await assert.rejects(assertLinuxFixture({ ...data, launchCwd: alias }), /canonicalLinuxFixtureRequired/)
  })
})
