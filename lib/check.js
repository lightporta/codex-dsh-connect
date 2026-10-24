import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFixture, isolatedEnvironment } from './isolation.mjs'

export function runBounded(command, args, { cwd, env, input, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', overflow = false, timedOut = false
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
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
  if (process.platform !== 'darwin') return { ok: false, outcome: 'macOSRequired', modelRequests: 0, credentialAccess: false }
  let fixture, outside
  try {
    fixture = await createFixture({ ...options, live: false, auth: 'account', code: true })
    outside = await realpath(await mkdtemp(join(tmpdir(), 'codex-dsh-denied-')))
    const allowed = join(fixture.scratch, 'sentinel')
    const denied = join(outside, 'sentinel')
    await writeFile(allowed, 'allowed', { mode: 0o600 })
    await writeFile(denied, 'private synthetic data', { mode: 0o600 })
    const env = isolatedEnvironment({ scratch: fixture.scratch, source: {}, live: false, auth: 'account' })
    const probe = `const fs=require('node:fs');const [a,b]=process.argv.slice(1);let r=false,w=false;fs.readFileSync(a);fs.writeFileSync(a,'changed');try{fs.readFileSync(b)}catch(e){r=['EPERM','EACCES'].includes(e.code)}try{fs.writeFileSync(b,'x')}catch(e){w=['EPERM','EACCES'].includes(e.code)}if(!r||!w)process.exitCode=1;`
    const launch = args => runBounded('/usr/bin/sandbox-exec', ['-f', fixture.policy, fixture.node, ...args], { env, cwd: fixture.launchCwd })
    const result = await launch(['-e', probe, allowed, denied])
    if (result.code !== 0 || await readFile(denied, 'utf8') !== 'private synthetic data') throw new Error('denial failed')
    const version = await launch([fixture.bin, '--version'])
    const help = await launch([fixture.bin, '--profile', fixture.profileName, '--patch', fixture.overlay, '--help'])
    if (version.code !== 0 || version.stdout.trim() !== fixture.version || help.code !== 0 || !help.stdout.includes('--json')) throw new Error('native check failed')
    return { ok: true, outcome: 'isolationVerified', nativeVersion: fixture.version, modelRequests: 0, credentialAccess: false }
  } catch {
    return { ok: false, outcome: 'isolationUnavailable', modelRequests: 0, credentialAccess: false }
  } finally {
    if (outside) await rm(outside, { recursive: true, force: true })
    if (fixture) await rm(fixture.scratch, { recursive: true, force: true })
  }
}
