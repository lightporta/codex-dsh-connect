import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

export const PROJECT_TOOL_NAMES = Object.freeze(['project_list_files', 'project_read_text', 'project_write_text'])

// The caller supplies the one explicitly authorized project. Resolving a path
// is not authorization to widen it to an ancestor or follow a symlink alias.
export function canonicalWorkspace(workspaceAbsolute) {
  if (typeof workspaceAbsolute !== 'string' || !isAbsolute(workspaceAbsolute) || /[\r\n\0]/.test(workspaceAbsolute)) throw new Error('workspace must be an absolute plain directory')
  const normalized = resolve(workspaceAbsolute)
  const home = resolve(homedir())
  const broad = new Set([
    parse(normalized).root, home, dirname(home), '/Users', '/Users/Shared', '/Volumes',
    '/private', '/private/var', '/private/tmp', '/tmp', '/var', '/System', '/Library',
    '/Applications', '/usr', '/usr/local', '/opt', '/etc', '/bin', '/sbin',
    ...['Documents', 'Downloads', 'Desktop', 'Library', 'Pictures', 'Music', 'Movies', 'Public'].map(name => join(home, name)),
  ])
  if (broad.has(normalized) || normalized.split(sep).some(part => /^\.(?:dsh|ssh|aws|codex|agents|config)$/i.test(part))) throw new Error('workspace must be a project directory, not a home or broad system directory')
  let current = parse(normalized).root
  for (const part of normalized.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('workspace and its ancestors must be plain directories without symlinks')
  }
  const canonical = realpathSync(normalized)
  if (canonical !== normalized) throw new Error('workspace must use its canonical directory path')
  return canonical
}

// This source generator is an explicit capability boundary for a native DSH profile,
// not an OS sandbox. Node's path APIs cannot make ancestor checks and rename one
// atomic operation against a hostile process concurrently replacing directories.
function installProjectTools(ctx, root) {
  const FILE_BYTES = 65536
  const OUTPUT_CHARS = 8192
  const MAX_DEPTH = 8
  const sensitive = part => /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.aws|\.ssh|\.dsh|\.codex|\.agents|\.config|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.codex-dsh-tmp-.*)$/i.test(part)
    || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part)
  const fail = message => { throw new Error(`project tools: ${message}`) }
  const aborted = signal => { if (signal?.aborted) throw new Error('project tools: cancelled') }
  const stamp = stat => `${stat.dev}:${stat.ino}`

  function segments(value, allowRoot = false) {
    if (allowRoot && (value === undefined || value === '.')) return []
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\x00-\x1f\x7f\\:]/.test(value) || value.startsWith('/')) fail('path must be a short relative project path')
    const parts = value.split('/')
    if (parts.length > MAX_DEPTH || parts.some(part => !part || part === '.' || part === '..' || part.length > 128)) fail('path depth or segment is invalid')
    if (parts.some(sensitive)) fail('sensitive path is unavailable')
    return parts
  }

  async function checked(parts, { missing = false, directory = false } = {}) {
    // Recheck the canonical root and its ancestors on every operation. No link is
    // accepted, including one introduced after this fixture was generated.
    let current = root.startsWith('/') ? '/' : parse(root).root
    const records = []
    for (const part of root.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part)
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('workspace ancestor is not a plain directory')
      records.push({ path: current, stamp: stamp(stat) })
    }
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index])
      let stat
      try { stat = await lstat(current) } catch (error) {
        if (missing && index === parts.length - 1 && error.code === 'ENOENT') return { path: current, stat: undefined, records }
        throw error
      }
      if (stat.isSymbolicLink()) fail('symlinks are unavailable')
      if (index < parts.length - 1 && !stat.isDirectory()) fail('path ancestor is not a directory')
      if (index === parts.length - 1 && (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('target must be a plain unlinked file')
      records.push({ path: current, stamp: stamp(stat) })
      if (index === parts.length - 1) return { path: current, stat, records }
    }
    return { path: current, stat: await lstat(current), records }
  }

  async function unchanged(records) {
    for (const record of records) {
      const stat = await lstat(record.path)
      if (stat.isSymbolicLink() || stamp(stat) !== record.stamp) fail('project path changed during operation')
    }
  }

  async function list(args, signal) {
    const start = segments(args.path, true)
    await checked(start, { directory: true })
    const files = []
    const queue = [start]
    let visited = 0
    let truncated = false
    while (queue.length > 0 && !truncated) {
      aborted(signal)
      const parts = queue.shift()
      const target = await checked(parts, { directory: true })
      const dir = await opendir(target.path)
      try {
        await unchanged(target.records)
        for await (const entry of dir) {
          aborted(signal)
          if (++visited > 2000) { truncated = true; break }
          if (sensitive(entry.name) || entry.isSymbolicLink() || entry.name.length > 128 || /[\x00-\x1f\x7f\\:]/.test(entry.name)) continue
          const child = [...parts, entry.name]
          if (child.length > MAX_DEPTH || child.join('/').length > 512) { truncated = true; break }
          if (entry.isDirectory()) queue.push(child)
          else if (entry.isFile()) {
            const safe = await checked(child)
            await unchanged(safe.records)
            const relative = child.join('/')
            if (files.length >= 200 || JSON.stringify({ files: [...files, relative], truncated: true }).length > OUTPUT_CHARS) { truncated = true; break }
            files.push(relative)
          }
        }
      } finally { await dir.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error }) }
    }
    return { files: files.sort(), truncated }
  }

  async function read(args, signal) {
    const parts = segments(args.path)
    const offset = args.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > FILE_BYTES) fail('invalid text offset')
    const target = await checked(parts)
    if (target.stat.size > FILE_BYTES) fail('file exceeds 65536 bytes')
    const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stamp(stat) !== stamp(target.stat)) fail('file changed during open')
      await unchanged(target.records)
      aborted(signal)
      const buffer = Buffer.alloc(FILE_BYTES + 1)
      const result = await handle.read(buffer, 0, buffer.length, 0)
      if (result.bytesRead > FILE_BYTES) fail('file exceeds 65536 bytes')
      bytes = buffer.subarray(0, result.bytesRead)
    } finally { await handle.close() }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) fail('binary files are unavailable')
    aborted(signal)
    const value = { path: parts.join('/'), offset: Math.min(offset, text.length), totalChars: text.length, text: '' }
    let low = 0
    let high = Math.min(text.length - value.offset, OUTPUT_CHARS)
    while (low < high) {
      const size = Math.ceil((low + high) / 2)
      value.text = text.slice(value.offset, value.offset + size)
      value.nextOffset = value.offset + size
      if (JSON.stringify(value).length <= OUTPUT_CHARS) low = size
      else high = size - 1
    }
    value.text = text.slice(value.offset, value.offset + low)
    if (value.offset + low < text.length) value.nextOffset = value.offset + low
    else delete value.nextOffset
    return value
  }

  async function write(args, signal) {
    const parts = segments(args.path)
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > FILE_BYTES || args.content.includes('\0') || Buffer.from(args.content).toString('utf8') !== args.content) fail('content must be UTF-8 text of at most 65536 bytes')
    const target = await checked(parts, { missing: true })
    const temporary = join(dirname(target.path), `.codex-dsh-tmp-${randomUUID()}`)
    let handle
    try {
      aborted(signal)
      await unchanged(target.records)
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, target.stat === undefined ? 0o600 : target.stat.mode & 0o777)
      await handle.writeFile(args.content, { encoding: 'utf8', signal })
      await handle.sync()
      await handle.close()
      handle = undefined
      aborted(signal)
      await unchanged(target.records)
      const latest = await checked(parts, { missing: true })
      if (target.stat === undefined && latest.stat !== undefined) fail('target appeared during write')
      await rename(temporary, target.path)
      return { path: parts.join('/'), bytesWritten: Buffer.byteLength(args.content, 'utf8') }
    } finally {
      await handle?.close()
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  const schema = properties => ({ type: 'object', properties, additionalProperties: false })
  const path = { type: 'string', description: 'Relative project path, without dot segments or symlinks.' }
  const registry = ctx.get('tools')
  if (registry === undefined || typeof registry.register !== 'function') fail('native tools registry is required')
  for (const [name, description, parameters, handler] of [
    ['project_list_files', 'List relative regular-file names under this authorized project. Sensitive paths and symlinks are excluded. Output is bounded.', schema({ path }), list],
    ['project_read_text', 'Read one UTF-8 project file (64 KiB maximum). A bounded chunk is returned; use nextOffset to continue.', { ...schema({ path, offset: { type: 'integer', description: 'Character offset, default 0.' } }), required: ['path'] }, read],
    ['project_write_text', 'Atomically replace or create one UTF-8 project file (64 KiB maximum). Parent directory must already exist. No code is executed.', { ...schema({ path, content: { type: 'string', description: 'Complete new file contents.' } }), required: ['path', 'content'] }, write],
  ]) {
    registry.register({
      name, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(parameters.properties, key))) fail('invalid arguments')
        return handler(args, exec?.signal)
      },
    })
  }
}

export function createProjectToolsSource(workspaceAbsolute) {
  const root = canonicalWorkspace(workspaceAbsolute)
  return [
    "import { constants } from 'node:fs'",
    "import { lstat, opendir, open, rename, unlink } from 'node:fs/promises'",
    "import { dirname, join, parse, sep } from 'node:path'",
    "import { randomUUID } from 'node:crypto'",
    "export const name = 'codex-dsh-project-tools'",
    "export const inject = ['tools']",
    `const install = ${installProjectTools.toString()}`,
    `export function apply(ctx) { install(ctx, ${JSON.stringify(root)}) }`,
    '',
  ].join('\n')
}
