import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink, link, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createProjectToolsSource, PROJECT_TOOL_NAMES } from '../lib/project-tools.mjs'

async function fixture(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-project-tools-')))
  const root = join(scratch, 'project')
  await mkdir(root)
  const source = createProjectToolsSource(root)
  const pluginPath = join(scratch, 'project-tools.mjs')
  await writeFile(pluginPath, source)
  const plugin = await import(pathToFileURL(pluginPath).href)
  const tools = new Map()
  plugin.apply({ get(name) { assert.equal(name, 'tools'); return { register(definition) { tools.set(definition.name, definition) } } } })
  t.after(() => rm(scratch, { recursive: true, force: true }))
  return { root, scratch, plugin, tools, call: (name, args, signal) => tools.get(name).execute(args, { signal }) }
}

test('self-contained source registers exactly three native tool definitions', async t => {
  const f = await fixture(t)
  assert.equal(f.plugin.name, 'codex-dsh-project-tools')
  assert.deepEqual(f.plugin.inject, ['tools'])
  assert.deepEqual([...f.tools.keys()], PROJECT_TOOL_NAMES)
  for (const definition of f.tools.values()) {
    assert.equal(definition.parameters.type, 'object')
    assert.deepEqual(definition.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
  }
})

test('normal project listing, UTF-8 read, new file and atomic replacement work', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'src'))
  await writeFile(join(f.root, 'src', 'sum.js'), 'export const sum = (a, b) => a - b\n')
  assert.deepEqual(await f.call('project_list_files', {}), { files: ['src/sum.js'], truncated: false })
  assert.equal((await f.call('project_read_text', { path: 'src/sum.js' })).text, 'export const sum = (a, b) => a - b\n')
  const written = await f.call('project_write_text', { path: 'src/sum.js', content: 'export const sum = (a, b) => a + b\n' })
  assert.equal(written.bytesWritten, Buffer.byteLength('export const sum = (a, b) => a + b\n'))
  assert.equal(await readFile(join(f.root, 'src', 'sum.js'), 'utf8'), 'export const sum = (a, b) => a + b\n')
  await f.call('project_write_text', { path: 'notes.txt', content: '你好 UTF-8' })
  assert.equal((await f.call('project_read_text', { path: 'notes.txt' })).text, '你好 UTF-8')
  assert.deepEqual((await readdir(join(f.root, 'src'))), ['sum.js'])
})

test('absolute, traversal, NUL, Windows, deep, and overlong paths are denied', async t => {
  const f = await fixture(t)
  const paths = ['/etc/passwd', '../outside', 'x/../outside', 'C:/Windows/file', 'x\\file', 'a\0b', 'a'.repeat(129), Array(9).fill('a').join('/')]
  for (const path of paths) {
    await assert.rejects(f.call('project_read_text', { path }))
    await assert.rejects(f.call('project_write_text', { path, content: 'x' }))
    await assert.rejects(f.call('project_list_files', { path }))
  }
  await assert.rejects(f.call('project_write_text', { path: 'safe.txt', content: 'x', code: 'process.exit()' }), /invalid arguments/)
  await assert.rejects(f.call('project_read_text', { path: 'safe.txt', argv: ['anything'] }), /invalid arguments/)
})

test('sensitive files are unavailable and their names do not leak through listing', async t => {
  const f = await fixture(t)
  for (const name of ['.env', '.env.production', '.npmrc', 'credentials.json', 'secrets.yaml', 'id_rsa', 'service.key']) {
    await writeFile(join(f.root, name), 'TEST_SECRET')
    await assert.rejects(f.call('project_read_text', { path: name }), /sensitive/)
    await assert.rejects(f.call('project_write_text', { path: name, content: 'replacement' }), /sensitive/)
  }
  await mkdir(join(f.root, '.git'))
  await writeFile(join(f.root, '.git', 'config'), 'TEST_SECRET')
  await assert.rejects(f.call('project_list_files', { path: '.git' }), /sensitive/)
  assert.deepEqual(await f.call('project_list_files', {}), { files: [], truncated: false })
})

test('file, directory, and dangling symlinks are denied without altering their targets', async t => {
  const f = await fixture(t)
  const outside = join(f.scratch, 'outside.txt')
  await writeFile(outside, 'outside stays unchanged')
  try {
    await symlink(outside, join(f.root, 'file-link'), 'file')
    await symlink(join(f.scratch, 'missing'), join(f.root, 'dangling'), 'file')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file symlinks require Developer Mode or elevation; junction and hard-link rejection remain tested')
    throw error
  }
  await symlink(f.scratch, join(f.root, 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of ['file-link', 'directory-link/outside.txt', 'dangling']) {
    await assert.rejects(f.call('project_read_text', { path }), /symlink/)
    await assert.rejects(f.call('project_write_text', { path, content: 'forbidden' }), /symlink/)
  }
  assert.equal(await readFile(outside, 'utf8'), 'outside stays unchanged')
  assert.deepEqual(await f.call('project_list_files', {}), { files: [], truncated: false })
})

test('hard links are denied without reading or replacing their targets', async t => {
  const f = await fixture(t)
  const outside = join(f.scratch, 'outside.txt')
  await writeFile(outside, 'outside stays unchanged')
  await link(outside, join(f.root, 'hard-link'))
  await assert.rejects(f.call('project_read_text', { path: 'hard-link' }), /plain unlinked file/)
  await assert.rejects(f.call('project_write_text', { path: 'hard-link', content: 'forbidden' }), /plain unlinked file/)
  assert.equal(await readFile(outside, 'utf8'), 'outside stays unchanged')
})

test('file sizes, binary input, cancellation, read pagination and list output are bounded', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'too-large.txt'), 'x'.repeat(65537))
  await assert.rejects(f.call('project_read_text', { path: 'too-large.txt' }), /65536/)
  await assert.rejects(f.call('project_write_text', { path: 'too-large.txt', content: 'x'.repeat(65537) }), /65536/)
  await assert.rejects(f.call('project_write_text', { path: 'binary.txt', content: 'a\0b' }), /UTF-8/)
  await writeFile(join(f.root, 'binary.txt'), Buffer.from([0xff, 0x00]))
  await assert.rejects(f.call('project_read_text', { path: 'binary.txt' }))
  const text = '中文\\\"\n'.repeat(5000)
  await writeFile(join(f.root, 'paged.txt'), text)
  const first = await f.call('project_read_text', { path: 'paged.txt' })
  assert.ok(JSON.stringify(first).length <= 8192)
  assert.equal(first.text, text.slice(0, first.nextOffset))
  const second = await f.call('project_read_text', { path: 'paged.txt', offset: first.nextOffset })
  assert.equal(second.text, text.slice(first.nextOffset, second.nextOffset))
  for (let i = 0; i < 210; i += 1) await writeFile(join(f.root, `file-${String(i).padStart(3, '0')}.txt`), '')
  const listed = await f.call('project_list_files', {})
  assert.equal(listed.truncated, true)
  assert.ok(listed.files.length <= 200)
  assert.ok(JSON.stringify(listed).length <= 8192)
  await assert.rejects(f.call('project_write_text', { path: 'cancelled.txt', content: 'x' }, AbortSignal.abort()), /cancelled/)
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.codex-dsh-tmp-')), false)
})

test('source generator rejects a symlink root and filesystem root', async t => {
  const f = await fixture(t)
  const alias = join(f.scratch, 'alias')
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => createProjectToolsSource(alias), /plain director/)
  assert.throws(() => createProjectToolsSource('/'), /project directory/)
  assert.throws(() => createProjectToolsSource('relative/path'), /absolute/)
})

test('a workspace replaced by a symlink is denied after source generation', async t => {
  const f = await fixture(t)
  await rename(f.root, join(f.scratch, 'original-project'))
  const outside = join(f.scratch, 'outside-directory')
  await mkdir(outside)
  await writeFile(join(outside, 'unchanged.txt'), 'outside test data')
  await symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.call('project_list_files', {}), /workspace ancestor/)
  await assert.rejects(f.call('project_read_text', { path: 'unchanged.txt' }), /workspace ancestor/)
  await assert.rejects(f.call('project_write_text', { path: 'unchanged.txt', content: 'forbidden' }), /workspace ancestor/)
  assert.equal(await readFile(join(outside, 'unchanged.txt'), 'utf8'), 'outside test data')
})
