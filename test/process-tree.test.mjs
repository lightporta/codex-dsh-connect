import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { detached, terminateTree } from '../lib/process-tree.js'

test('cancellation stops a real child and its descendant before cleanup', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-process-tree-'))
  const heartbeat = join(root, 'heartbeat')
  const descendant = `
    const fs = require('node:fs'); let count = 0;
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++count));
    setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++count)), 25);
    process.send({pid:process.pid});
  `
  const parent = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore','ignore','ignore','ipc'], shell:false});
    child.on('message', message => process.stdout.write(JSON.stringify(message) + '\\n'));
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['-e', parent], { detached, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let descendantPid
  const closed = once(child, 'close')
  const watchdog = setTimeout(() => terminateTree(child, 50), 7000)
  try {
    const [chunk] = await once(child.stdout, 'data')
    descendantPid = JSON.parse(chunk.toString()).pid
    terminateTree(child, 50)
    await closed
    await delay(100)
    const stopped = await readFile(heartbeat, 'utf8')
    await delay(150)
    assert.equal(await readFile(heartbeat, 'utf8'), stopped)
  } finally {
    clearTimeout(watchdog)
    terminateTree(child, 0)
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* Already terminated. */ }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
