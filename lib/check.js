import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFixture, isolatedEnvironment } from './isolation.mjs'
import { assertSandboxAvailable, assertSandboxFixture, buildSandboxLaunch } from './launch.mjs'
import { detached, terminateTree } from './process-tree.js'

export function runBounded(command, args, { cwd, env, input, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', overflow = false, timedOut = false
    const stop = () => terminateTree(child, 100)
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        if (overflow) return
        if (name === 'stdout') stdout += chunk
        else stderr += chunk
        if (stdout.length + stderr.length > 1024 * 1024) { overflow = true; stop() }
      })
    }
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, launchFailed: true, stdout: '', stderr: '' }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, overflow, timedOut }) })
  })
}

export async function checkIsolation(options = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) return { ok: false, outcome: 'wslRequired', modelRequests: 0, credentialAccess: false }
  let fixture, outside
  try {
    await assertSandboxAvailable()
    fixture = await createFixture({ ...options, live: false, auth: 'account', code: true })
    await assertSandboxFixture(fixture)
    outside = await realpath(await mkdtemp(join(tmpdir(), 'codex-dsh-denied-')))
    const allowed = join(fixture.scratch, 'sentinel')
    const denied = join(outside, 'sentinel')
    await writeFile(allowed, 'allowed', { mode: 0o600 })
    await writeFile(denied, 'private synthetic data', { mode: 0o600 })
    const env = isolatedEnvironment({ scratch: fixture.scratch, source: {}, live: false, auth: 'account' })
    const probe = `const fs=require('node:fs');const [a,b]=process.argv.slice(1);let r=false,w=false;fs.readFileSync(a);fs.writeFileSync(a,'changed');try{fs.readFileSync(b)}catch(e){r=['EPERM','EACCES','ENOENT'].includes(e.code)}try{fs.writeFileSync(b,'x')}catch(e){w=['EPERM','EACCES','ENOENT','EROFS'].includes(e.code)}if(!r||!w)process.exitCode=1;`
    const launch = args => {
      const spec = buildSandboxLaunch(fixture, args, { env })
      return runBounded(spec.command, spec.args, { env: spec.env, cwd: spec.cwd })
    }
    const result = await launch(['-e', probe, allowed, denied])
    if (result.code !== 0 || await readFile(denied, 'utf8') !== 'private synthetic data') throw new Error('denial failed')
    const version = await launch([fixture.bin, '--version'])
    const help = await launch([fixture.bin, '--profile', fixture.profileName, '--patch', fixture.overlay, '--help'])
    if (version.code !== 0 || version.stdout.trim() !== fixture.version || help.code !== 0 || !help.stdout.includes('--json')) throw new Error('native check failed')
    return { ok: true, outcome: 'isolationVerified', platform: process.platform, nativeVersion: fixture.version, modelRequests: 0, credentialAccess: false }
  } catch {
    return { ok: false, outcome: 'isolationUnavailable', modelRequests: 0, credentialAccess: false }
  } finally {
    if (outside) await rm(outside, { recursive: true, force: true })
    if (fixture) await rm(fixture.scratch, { recursive: true, force: true })
  }
}
