import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPolicy, isolatedEnvironment } from '../lib/isolation.mjs'
import { buildLinuxLaunch } from '../lib/linux-sandbox.mjs'

if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error('This probe requires macOS or Linux. On Windows run it inside the explicitly selected WSL2 distribution.')
}

// Real OS filesystem isolation with synthetic files only. This deliberately
// requires no Harness installation, account credentials or model request.
const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-platform-isolation-')))
try {
  const scratch = join(root, 'task')
  const workspace = join(root, 'project')
  const installation = join(root, 'runtime')
  const launchCwd = join(scratch, 'workspace')
  for (const path of [scratch, workspace, installation, launchCwd, join(scratch, 'tmp')]) await mkdir(path, { recursive: true, mode: 0o700 })
  const node = await realpath(process.execPath)
  const credentialFile = join(root, 'synthetic-credential.txt')
  const outside = join(root, 'outside.txt')
  const runtimeFile = join(installation, 'runtime.txt')
  await writeFile(credentialFile, 'SYNTHETIC_CREDENTIAL')
  await writeFile(outside, 'OUTSIDE_SENTINEL')
  await writeFile(runtimeFile, 'READONLY_RUNTIME')
  await writeFile(join(workspace, 'input.txt'), 'PROJECT_INPUT')
  for (const live of [false, true]) {
    const script = join(scratch, `probe-${live}.mjs`)
    await writeFile(script, `
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
const paths = ${JSON.stringify({ scratch, workspace, credentialFile, outside, runtimeFile, root, launchCwd })}
assert.equal(process.cwd(), paths.launchCwd)
assert.equal(readFileSync(paths.workspace + '/input.txt', 'utf8'), 'PROJECT_INPUT')
assert.equal(readFileSync(paths.runtimeFile, 'utf8'), 'READONLY_RUNTIME')
writeFileSync(paths.workspace + '/output.txt', 'PROJECT_OUTPUT')
writeFileSync(paths.scratch + '/scratch.txt', 'SCRATCH_OUTPUT')
assert.throws(() => readFileSync(paths.outside))
${process.platform === 'linux' ? `assert.equal(readdirSync(paths.root).includes('outside.txt'), false)\n${live ? '' : "assert.equal(readdirSync(paths.root).includes('synthetic-credential.txt'), false)"}` : 'assert.throws(() => readdirSync(paths.root))'}
assert.throws(() => writeFileSync(paths.outside, 'CHANGED'))
assert.throws(() => writeFileSync(paths.runtimeFile, 'CHANGED'))
assert.throws(() => writeFileSync(paths.credentialFile, 'CHANGED'))
${live ? "assert.equal(readFileSync(paths.credentialFile, 'utf8'), 'SYNTHETIC_CREDENTIAL')" : 'assert.throws(() => readFileSync(paths.credentialFile))'}
${process.platform === 'linux' ? "assert.equal(process.env.HOME, paths.scratch)\nassert.equal(homedir(), paths.scratch)" : "assert.equal(process.env.HOME, undefined)"}
for (const name of ['CODEX_HOME', 'NODE_OPTIONS', 'HTTPS_PROXY', 'PARENT_SYNTHETIC']) assert.equal(process.env[name], undefined)
console.log(JSON.stringify({ passed: true, liveCredentialPolicy: ${live}, checks: 14 }))
`)
    const env = isolatedEnvironment({ scratch, source: {}, live, auth: 'account' })
    let launch
    if (process.platform === 'linux') {
      launch = buildLinuxLaunch({ scratch, workspace, installation, node, credentialFile, live, launchCwd, env, args: [script] })
    } else {
      const policy = join(scratch, `probe-${live}.sb`)
      await writeFile(policy, buildPolicy({ scratch, workspace, installation, node, credentialFile, live }))
      launch = { command: '/usr/bin/sandbox-exec', args: ['-f', policy, node, script], cwd: launchCwd, env }
    }
    const result = spawnSync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024, shell: false, windowsHide: true })
    if (result.error || result.status !== 0) throw new Error(`real ${process.platform} isolation probe failed (${live ? 'synthetic credential readable' : 'offline'}): ${result.error?.message ?? result.stderr.slice(-4000)}`)
    assert.equal(JSON.parse(result.stdout.trim()).passed, true)
    assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE_SENTINEL')
    assert.equal(await readFile(runtimeFile, 'utf8'), 'READONLY_RUNTIME')
    assert.equal(await readFile(credentialFile, 'utf8'), 'SYNTHETIC_CREDENTIAL')
    assert.equal(await readFile(join(workspace, 'output.txt'), 'utf8'), 'PROJECT_OUTPUT')
  }
  console.log(JSON.stringify({ mode: 'real-os-synthetic-isolation', platform: process.platform, node: process.version, backend: process.platform === 'linux' ? 'bubblewrap' : 'seatbelt', phases: 2, passed: true, harnessOrModelTested: false }))
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
