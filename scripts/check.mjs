import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('..', import.meta.url))
async function walk(dir) {
  const paths=[]
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (['node_modules','.git','work'].includes(entry.name)) continue
    const path=join(dir,entry.name)
    if(entry.isDirectory()) paths.push(...await walk(path))
    else if(entry.isFile()) paths.push(path)
  }
  return paths
}
const files=await walk(root)
for(const file of files.filter(path=>/\.(?:js|mjs)$/.test(path))) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true})
  if(result.status!==0) throw new Error(result.stderr)
  const source=await readFile(file,'utf8')
  if(file.startsWith(join(root,'lib')) && /shell:\s*true/.test(source)) throw new Error('unsafe child process mode')
  if(file.startsWith(join(root,'lib')) && source.includes('qoder-'+'dsh-connect')) throw new Error('standalone project must have no external bridge coupling')
}
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
if(pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error('project must have no runtime package dependencies')
const lockPath = join(root, 'package-lock.json')
// npm intentionally excludes package-lock.json from a published tarball.
if (files.includes(lockPath)) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('package and lock versions differ')
}
const validation = JSON.parse(await readFile(join(root, 'docs/validation.json'), 'utf8'))
if (validation.version !== pkg.version) throw new Error('validation belongs to a different release')
for (const path of ['bin', 'lib', 'scripts', 'test', 'skills', 'assets', 'docs', 'plugin.json', 'mcp.json']) {
  if (!pkg.files?.includes(path)) throw new Error(`package missing required directory: ${path}`)
}
const plugin = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'))
const mcp = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'))
if (plugin.version !== pkg.version || plugin.name !== pkg.name) throw new Error('plugin and package identity differ')
if (plugin.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
  || mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') throw new Error('unsupported portable plugin schema')
const extension = plugin.extensions?.['com.openai']
for (const ref of [extension?.onboardingSkill, extension?.interface?.logo, extension?.interface?.composerIcon]) {
  if (typeof ref !== 'string' || !ref.startsWith('./') || ref.split('/').includes('..') || !files.includes(resolve(root, ref))) throw new Error('missing or invalid plugin asset')
}
const server = mcp.mcpServers?.codex_dsh_connect
if (server?.type !== 'stdio' || server.command !== 'node' || server.cwd !== '${PLUGIN_ROOT}'
  || JSON.stringify(server.args) !== JSON.stringify(['${PLUGIN_ROOT}/bin/codex-dsh-plugin.mjs', 'mcp'])) throw new Error('invalid bundled MCP launch')
if (!files.includes(join(root, 'skills', 'codex-dsh-connect', 'SKILL.md')) || !files.includes(join(root, 'bin', 'codex-dsh-plugin.mjs'))) throw new Error('plugin entrypoint missing')
console.log(`check passed: ${files.length} files`)
