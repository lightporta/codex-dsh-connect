import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalWorkspace, createProjectToolsSource, PROJECT_TOOL_NAMES } from './project-tools.mjs'

export const SUPPORTED_DSH_VERSION = '0.2.1-rc.2'
export const MODEL_TASK = '只回复两个字：收到。'
export const CODE_TASK = '只处理当前临时项目。先用 project_read_text 读取 math.mjs，再用 project_write_text 修复 add(a,b) 的减法错误为加法；保留 export。不要读取其他路径，不要使用 shell。完成后只用一句话报告修改。'

export function authProvider(auth = 'account') {
  if (auth !== 'api-key' && auth !== 'account') throw new Error('invalidAuthMode')
  return auth === 'account' ? 'deepseek-account' : 'deepseek-official'
}

// Only the native catalog and one fixed text-generation endpoint are permitted.
// This function does not inspect headers, tokens, bodies, or response contents.
export function classifyRequest(input, init = {}, auth = 'account') {
  let url
  try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input?.url) } catch { return undefined }
  if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash) return undefined
  const method = String(init.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET').toUpperCase()
  if (method === 'POST' && url.pathname === '/anthropic/v1/messages') return 'messages'
  if (auth === 'account' && method === 'GET' && url.pathname === '/models') return 'models'
  return undefined
}

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('invalidAbsolutePath')
  return resolve(path)
}

function within(path, root) {
  return path === root || path.startsWith(root + sep)
}

// SBPL string literals use JSON-compatible escaping for the path characters we
// permit. Reject line breaks/NUL before serialization; never interpolate code.
function literal(path) {
  return `(literal ${JSON.stringify(absolute(path))})`
}

function subtree(path) {
  return `(subpath ${JSON.stringify(absolute(path))})`
}

export function buildPolicy({ scratch, installation, node, credentialFile, live = false, workspace }) {
  scratch = absolute(scratch)
  installation = absolute(installation)
  node = absolute(node)
  // Broad roots would defeat a positive data-read allowlist.
  for (const root of [scratch, installation]) {
    if (['/', '/Users', '/Volumes', '/private', '/private/var', homedir()].includes(root)) throw new Error('unsafeReadRoot')
  }
  const project = workspace === undefined ? undefined : canonicalWorkspace(workspace)
  if (project !== undefined && (within(project, installation) || within(installation, project) || within(node, project))) throw new Error('workspaceMustNotContainRuntime')
  const roots = [scratch, installation, ...(project === undefined ? [] : [project])]
  const credential = credentialFile === undefined ? undefined : absolute(credentialFile)
  if (credential !== undefined && roots.some(root => within(credential, root))) throw new Error('credentialMustBeOutsideAllowedTrees')
  const readRules = [
    // Apple system.sb:95-98 requires this exact root-directory permission for
    // getcwd during process initialization. A literal does not allow children.
    literal('/'),
    ...['/System', '/usr/lib', '/usr/share', '/bin', '/sbin', '/private/etc', '/Library/Apple'].map(subtree),
    literal(node), subtree(installation), subtree(scratch),
    ...(project === undefined ? [] : [subtree(project)]),
    ...['/dev/null', '/dev/random', '/dev/urandom', '/private/var/run/resolv.conf'].map(literal),
    ...(live && credential !== undefined ? [literal(credential)] : []),
  ]
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-read*)',
    // Path metadata is needed for Node resolution and ancestor traversal. This
    // does not authorize directory enumeration or file contents.
    '(allow file-read-metadata)',
    `(allow file-read* ${readRules.join(' ')})`,
    '(deny file-write*)',
    `(allow file-write* ${subtree(scratch)} ${literal('/dev/null')}${project === undefined ? '' : ` ${subtree(project)}`})`,
    // A child must not create a second, less constrained launcher boundary.
    '(deny process-fork)',
    '',
  ].join('\n')
}

export function isolatedEnvironment({ scratch, source = process.env, live = false, auth = 'account' }) {
  scratch = absolute(scratch)
  authProvider(auth)
  // Intentionally no HOME/CODEX_HOME, NODE_OPTIONS, proxies, shell startup,
  // existing DSH_* configuration, or inherited user executable search path.
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
    TMPDIR: join(scratch, 'tmp'),
    DSH_HOME: join(scratch, 'dsh'),
    DSH_AGENTS_HOME: join(scratch, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TOOLS_MODE: 'native',
    ...(live && auth === 'api-key' && typeof source.DEEPSEEK_API_KEY === 'string' && source.DEEPSEEK_API_KEY.length > 0
      ? { DEEPSEEK_API_KEY: source.DEEPSEEK_API_KEY } : {}),
  }
}

export function guardSource(live, auth = 'account', code = true, maxRequests = code ? 8 : 1) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 16) throw new Error('maxRequests must be an integer from 1 to 16')
  const expected = authProvider(auth)
  const allowedTools = code ? PROJECT_TOOL_NAMES : []
  return `export const name = 'contract-no-tools'
export const inject = ['tools', 'llm']
const classifyRequest = ${classifyRequest.toString()}
export function apply(ctx) {
  const originalFetch = globalThis.fetch
  const originalInfo = console.info
  const dispatches = { models: 0, messages: 0 }
  globalThis.fetch = (input, init = {}) => {
    const kind = classifyRequest(input, init, ${JSON.stringify(auth)})
    if (!${live === true} || kind === undefined || ++dispatches[kind] > (kind === 'messages' ? ${maxRequests} : 1)) {
      process.stderr.write('contract/network-blocked\\n')
      throw new Error('Network request is disabled by isolated verification')
    }
    process.stderr.write('contract/network ' + JSON.stringify({ kind }) + '\\n')
    return originalFetch(input, { ...init, redirect: 'error' })
  }
  // Native account model-catalog diagnostics use console.info (stdout).
  // Preserve those diagnostics on stderr so stdout retains its NDJSON contract.
  console.info = (...args) => {
    if (args[0] === '[llm-deepseek-account]') console.warn(...args)
    else originalInfo(...args)
  }
  ctx.effect(() => () => { globalThis.fetch = originalFetch; console.info = originalInfo })
  const allowedTools = ${JSON.stringify(allowedTools)}
  ctx.tools.guard(exec => allowedTools.includes(exec?.name) ? undefined : 'Tool execution is disabled for this verification')
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: allowedTools })
  })
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    if (!${live === true}) throw new Error('Model requests are disabled in check mode')
    const toolCount = options.tools?.length ?? 0
    if (options.provider !== ${JSON.stringify(expected)}) throw new Error('Unexpected provider')
    if (options.model !== 'deepseek-flash') throw new Error('Unexpected native model')
    if (toolCount !== allowedTools.length || allowedTools.some(name => !options.tools?.some(tool => tool.name === name))) throw new Error('Unexpected tool catalog; expected an empty tool catalog or the exact project tools')
    if (++requests > ${maxRequests}) throw new Error('Only ${maxRequests === 1 ? 'one' : maxRequests} model request${maxRequests === 1 ? ' is' : 's are'} allowed')
    process.stderr.write('contract/route ' + JSON.stringify({ provider: options.provider, model: options.model, toolCount }) + '\\n')
    return next()
  })
}
`
}

const KEEP = new Set([
  'timer', 'llm', 'deepseek-llm-api-extensions', 'session', 'session-log-deepseek',
  'agent', 'agent-default-model', 'llm-deepseek', 'tools', 'system-prompt', 'agent-loop',
  'session-persistence-jsonl', 'session-query-sqlite', 'session-projection',
  'working-directory', 'fs-sandbox', 'sandbox-policy', 'attachment-local',
  'token-meter', 'compaction-basic', 'session-checkpoint-policy', 'headless-startup', 'headless-runner',
])

export async function createFixture({ installation = join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh'), node = process.execPath, credentialFile = join(homedir(), '.dsh', '.credentials.yaml'), workspace, live = false, auth = 'account', code = true, maxRequests = code ? 8 : 1, parent = tmpdir() } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('wslRequired')
  const provider = authProvider(auth)
  const guardText = guardSource(live, auth, code, maxRequests)
  const authorizedWorkspace = workspace === undefined ? undefined : canonicalWorkspace(workspace)
  // Read only package installation files. Never stat/read/realpath credentials.
  installation = await realpath(absolute(installation))
  node = await realpath(absolute(node))
  const manifest = JSON.parse(await readFile(join(installation, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== SUPPORTED_DSH_VERSION) throw new Error('unsupportedNativeVersion')
  const modules = join(installation, 'node_modules')
  const base = await readFile(join(modules, '@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8')
  const headless = await readFile(join(modules, '@deepseek-ai/dsh-headless/cordis.patch.yml'), 'utf8')
  const ids = new Set([...`${base}\n${headless}`.matchAll(/^\s*- id:\s*([\w-]+)\s*$/gm)].map(match => match[1]))
  const keep = new Set(KEEP)
  if (auth === 'account') {
    keep.delete('llm-deepseek')
    for (const id of ['llm-deepseek-account', 'authorization', 'deepseek-account']) keep.add(id)
  }
  for (const required of keep) if (!ids.has(required)) throw new Error('unexpectedNativeComposition')
  if (authorizedWorkspace !== undefined && (within(authorizedWorkspace, installation) || within(installation, authorizedWorkspace) || within(node, authorizedWorkspace))) throw new Error('workspaceMustNotContainRuntime')
  const originalCredential = absolute(credentialFile)
  if ([installation, ...(authorizedWorkspace === undefined ? [] : [authorizedWorkspace])].some(root => within(originalCredential, root))) throw new Error('credentialMustBeOutsideAllowedTrees')
  const scratch = await realpath(await mkdtemp(join(absolute(parent), 'dsh-isolated-')))
  try {
  const project = authorizedWorkspace ?? join(scratch, 'workspace')
  // The native launcher automatically reads process.cwd()/.env before mounting
  // plugins. Always launch in task-owned scratch; pin only its filesystem/Agent
  // working directory and project capabilities to the authorized project.
  const launchCwd = join(scratch, 'workspace')
  const profile = join(scratch, 'dsh/profiles/contract-smoke')
  for (const path of [profile, join(scratch, 'workspace'), join(scratch, 'tmp'), join(scratch, 'sessions'), join(scratch, 'agents')]) await mkdir(path, { recursive: true, mode: 0o700 })
  // The native runtime resolves packages from the existing read-only install.
  // No npm/pnpm invocation, copy, or mutation of the global installation.
  await symlink(modules, join(profile, 'node_modules'), 'dir')
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-contract-smoke', private: true, type: 'module',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }), { mode: 0o600 })
  const guard = join(scratch, 'contract-no-tools.mjs')
  await writeFile(guard, guardText, { mode: 0o600 })
  const projectTools = join(scratch, 'project-tools.mjs')
  if (code) {
    await writeFile(projectTools, createProjectToolsSource(project), { mode: 0o600 })
    if (authorizedWorkspace === undefined) await writeFile(join(project, 'math.mjs'), 'export function add(a, b) { return a - b }\n', { mode: 0o600 })
  }
  const disabled = [...ids].filter(id => !keep.has(id) && id !== 'credentials')
    .map(id => `- id: ${id}\n  disabled: true`).join('\n')
  const overlay = join(scratch, 'no-tools.patch.yml')
  const yamlPath = value => JSON.stringify(absolute(value))
  const credentialSource = live ? credentialFile : join(scratch, 'empty-credentials.yaml')
  if (auth === 'account' && !live) await writeFile(credentialSource, 'version: 1\nrefs: {}\nrecords: {}\n', { mode: 0o600 })
  const accountRows = auth === 'account' ? `
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
  config:
    desktopPlatform: null
    platformOrigin: https://platform.deepseek.com
    inferenceOrigin: https://api.deepseek.com
` : ''
  await writeFile(overlay, `${disabled}
- id: credentials
  disabled: ${live || auth === 'account' ? 'false' : 'true'}
  config:
    path: ${yamlPath(credentialSource)}
    watch: false
${accountRows}
- id: session-persistence-jsonl
  config:
    root: ${yamlPath(join(scratch, 'sessions'))}
- id: tools
  config:
    mode: native
- id: agent-default-model
  config:
    provider: ${provider}
    model: deepseek-flash
- id: sandbox-policy
  config:
    mode: read-only
    workspaceRoot: ${yamlPath(project)}
- id: fs-sandbox
  config:
    cwd: ${yamlPath(project)}
- id: system-prompt
  config:
    includeRuntimeContext: false
    personaPrefix: You are an AI agent powered by DeepSeek Harness.
- id: ${auth === 'account' ? 'llm-deepseek-account' : 'llm-deepseek'}
  config:
    baseURL: https://api.deepseek.com/anthropic
    maxTokens: 1024
    streamIdleTimeoutMs: 60000
    retryPolicy:
      mode: normal
      maxRetries: 0
- insert:
${code ? `    - id: project-tools
      name: ${JSON.stringify(pathToFileURL(projectTools).href)}
      inject: [tools]
` : ''}\
    - id: contract-no-tools
      name: ${JSON.stringify(pathToFileURL(guard).href)}
      inject: [tools, llm]
`, { mode: 0o600 })
  const policy = join(scratch, 'isolation.sb')
  await writeFile(policy, buildPolicy({ scratch, installation, node, credentialFile, live, workspace: project }), { mode: 0o600 })
  return { scratch, workspace: project, launchCwd, profile, profileName: 'contract-smoke', overlay, policy, node, installation, credentialFile: originalCredential, bin: join(installation, 'lib/bin.js'), version: manifest.version, platform: process.platform, live, auth, code, maxRequests }
  } catch (failure) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw failure
  }
}
