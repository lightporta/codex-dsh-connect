import { buildLinuxLaunch, assertLinuxAvailable, assertLinuxFixture } from './linux-sandbox.mjs'
import { isolatedEnvironment } from './isolation.mjs'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

export async function assertSandboxAvailable(platform = process.platform) {
  if (platform === 'linux') return assertLinuxAvailable()
  if (platform !== 'darwin') throw new Error(platform === 'win32' ? 'wslRequired' : 'unsupportedPlatform')
  try { await access('/usr/bin/sandbox-exec', constants.X_OK) } catch { throw new Error('seatbeltUnavailable') }
}

export async function assertSandboxFixture(fixture) {
  if ((fixture.platform ?? process.platform) === 'linux') await assertLinuxFixture(fixture)
}

export function buildSandboxLaunch(fixture, args, { env = isolatedEnvironment({ scratch: fixture.scratch, source: {}, live: fixture.live, auth: fixture.auth }) } = {}) {
  const platform = fixture.platform ?? process.platform
  if (platform === 'linux') return buildLinuxLaunch({ ...fixture, env, args })
  if (platform !== 'darwin') throw new Error(platform === 'win32' ? 'wslRequired' : 'unsupportedPlatform')
  return {
    command: '/usr/bin/sandbox-exec', args: ['-f', fixture.policy, fixture.node, ...args],
    cwd: fixture.launchCwd, env,
  }
}
