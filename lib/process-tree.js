import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const GRACE_MS = 3000

export const detached = process.platform !== 'win32'

function signalTree(child, signal) {
  if (child === undefined || child.pid === undefined) return false
  if (process.platform === 'win32') {
    try {
      child.kill(signal)
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-child.pid, signal)
    return true
  } catch {
    try {
      child.kill(signal)
      return true
    } catch {
      return false
    }
  }
}

export function terminateTree(child, graceMs = GRACE_MS) {
  if (child === undefined || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // Killing the root first loses the PID needed by taskkill to find children.
    // Windows SIGTERM is forceful, so terminate the whole tree in one operation.
    try {
      const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      const result = spawnSync(executable, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      if (result.status === 0) return
    } catch { /* Fall back to killing the direct child if taskkill is unavailable. */ }
    try { child.kill('SIGKILL') } catch { /* The child may already have exited. */ }
    return
  }
  if (!signalTree(child, 'SIGTERM')) return
  const escalate = setTimeout(() => {
    // The root can exit before a descendant that ignores SIGTERM. Its process
    // group remains addressable until the last member exits.
    signalTree(child, 'SIGKILL')
  }, graceMs)
  escalate.unref()
}
