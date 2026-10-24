import { spawnSync } from 'node:child_process'

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
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (!signalTree(child, 'SIGTERM')) return
  const escalate = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        // Nothing else to try; the run settles on its own timeout.
      }
      return
    }
    signalTree(child, 'SIGKILL')
  }, graceMs)
  escalate.unref()
}
