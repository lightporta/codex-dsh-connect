import { writeFile } from 'node:fs/promises'
import { createClient } from './client.js'
import { runStdioServer } from './mcp.js'
import { compactRun, compactStatus } from './projection.js'
import { generateCodexConfig, installSkill } from './setup.js'
import { VERSION } from './version.js'

const HELP = `codex-dsh-connect ${VERSION} — standalone native DeepSeek Harness executor

Commands:
  mcp --workspace /absolute/project       Start stdio MCP, five delegation tools
  run "task" --workspace /absolute/project Run a new native task and await its final answer
  run - --workspace /absolute/project      Read the task from stdin
  status --workspace /absolute/project     Check readiness without accessing credentials
  config --workspace /absolute/project     Print a Codex MCP TOML snippet
  skill install --dest /explicit/directory Install the optional Skill

Options:
  --dsh-root /absolute/npm/dsh   Explicit installed @deepseek-ai/dsh directory
  --credential-file /absolute/path  Pass a credential location to native Harness only
  --max-requests 8              Native generation budget, 1–16
  --timeout-ms 120000           Task wall time, 1000–300000 ms
  --max-output-chars 8000       Encoded result budget, 1024–16000
  --output /new/file.toml       Create a new snippet file; refuses overwrite
  --force                      Back up an existing explicit Skill destination
  --wsl-distro Ubuntu          Config only: explicit WSL2 distribution
  --wsl-node /absolute/node    Config only: Linux Node executable in WSL2
  --wsl-cli /absolute/cli.mjs  Config only: Linux connector entry in WSL2

Requires macOS Seatbelt or Linux bubblewrap (including WSL2), and official
DSH 0.2.1-rc.2 with an existing native
DeepSeek account login. Three scoped file tools; no shell or code execution.
Every task starts a new isolated profile/session. No Qoder or HTTP host required.
`

export function parse(args) {
  const options = {}
  const rest = []
  const names = { '--workspace': 'workspace', '--dsh-root': 'installation', '--credential-file': 'credentialFile', '--max-requests': 'maxRequests', '--timeout-ms': 'timeoutMs', '--max-output-chars': 'maxOutputChars', '--output': 'output', '--dest': 'dest', '--wsl-distro': 'wslDistro', '--wsl-node': 'wslNode', '--wsl-cli': 'wslCli' }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--force') { options.force = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (Object.hasOwn(names, arg)) {
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
      options[names[arg]] = value
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else rest.push(arg)
  }
  for (const [key, min, max] of [['maxRequests', 1, 16], ['timeoutMs', 1000, 300000], ['maxOutputChars', 1024, 16000]]) {
    if (options[key] !== undefined) {
      const value = Number(options[key])
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${key}`)
      options[key] = value
    }
  }
  return { command: rest.shift(), rest, options }
}

export async function runMcp(client, { input = process.stdin, output = process.stdout } = {}) {
  // Stop generation as soon as the client disconnects, before draining pending
  // long polls; otherwise EOF could leave a native task active for 25 seconds.
  const disconnected = () => { void client.close().catch(() => { process.exitCode = 1 }) }
  input.once('end', disconnected)
  input.once('close', disconnected)
  try {
    await runStdioServer({ client, input, output })
  } finally {
    input.off('end', disconnected)
    input.off('close', disconnected)
    await client.close()
  }
}

export async function main(args) {
  let client
  const terminate = code => { void Promise.resolve(client?.close()).finally(() => process.exit(code)) }
  const onInterrupt = () => terminate(130)
  const onTerminate = () => terminate(143)
  try {
    const { command, rest, options } = parse(args)
    if (options.help || command === undefined || command === 'help') { process.stdout.write(HELP); return }
    if (command === 'config') {
      const snippet = generateCodexConfig(options)
      if (options.output !== undefined) await writeFile(options.output, snippet, { flag: 'wx', mode: 0o600 })
      else process.stdout.write(snippet)
      return
    }
    if (options.wslDistro !== undefined || options.wslNode !== undefined || options.wslCli !== undefined) throw new Error('invalid WSL flags: use config to generate the WSL2 launcher')
    if (command === 'skill' && rest[0] === 'install') {
      process.stdout.write(JSON.stringify(await installSkill(options)) + '\n')
      return
    }
    if (!['mcp', 'status', 'run'].includes(command)) throw new Error('unknown command; use --help')
    client = await createClient(options)
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    if (command === 'mcp') {
      // Keep the executor alive for async polling/cancellation until stdio EOF.
      await runMcp(client)
      return
    }
    if (command === 'status') {
      process.stdout.write(JSON.stringify(compactStatus(await client.status())) + '\n')
      return
    }
    let task = rest.join(' ')
    if (rest[0] === '-') {
      task = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) {
        task += chunk
        if (task.length > 60 * 1024) throw new Error('invalid task length')
      }
    }
    let run = await client.run({ task, timeoutMs: options.timeoutMs, wait: 0 })
    while (run.status === 'running') run = await client.get(run.id, { wait: 25000 })
    process.stdout.write(JSON.stringify(compactRun(run, options)) + '\n')
    if (run.status !== 'completed') process.exitCode = 1
  } catch (error) {
    // Native stderr, response bodies and model credentials never enter CLI errors.
    const safe = ['missing value for ', 'unknown option ', 'invalid ', 'unknown command', 'workspace, CLI and Node', 'an explicit --dest']
    const message = safe.some(prefix => String(error.message).startsWith(prefix)) ? error.message : 'Command failed; check the explicit workspace, native installation and account-login setup.'
    process.stderr.write(JSON.stringify({ error: message }) + '\n')
    process.exitCode = 1
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    await client?.close()
  }
}
