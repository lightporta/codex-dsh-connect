import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateCodexConfig, installSkill } from '../lib/setup.js'
import { parse, runMcp } from '../lib/cli.js'
import { PassThrough } from 'node:stream'

test('config is a standalone native stdio snippet with explicit workspace and no credentials', () => {
  const snippet=generateCodexConfig({ workspace: process.cwd() })
  assert.match(snippet,/\[mcp_servers.codex_dsh_connect\]/)
  assert.match(snippet,/--workspace/)
  assert.equal(/http:\/\/|QODER|API_KEY|token=/.test(snippet),false)
  assert.throws(()=>generateCodexConfig(),/absolute/)
  assert.throws(()=>generateCodexConfig({workspace:'relative'}),/absolute/)
})

test('Skill installation needs explicit destination and protects existing content', async () => {
  const root=await mkdtemp(join(tmpdir(),'codex-dsh-setup-'))
  try {
    await assert.rejects(installSkill(),/explicit --dest/)
    const dest=join(root,'skill')
    await installSkill({dest})
    await writeFile(join(dest,'sentinel'),'test data')
    await assert.rejects(installSkill({dest}),/already exists/)
    const changed=await installSkill({dest,force:true})
    assert.equal(await readFile(join(changed.backup,'sentinel'),'utf8'),'test data')
    assert.match(await readFile(join(dest,'SKILL.md'),'utf8'),/codex-dsh-connect/)
    assert.equal((await readFile(join(dest,'references/local-paths.md'),'utf8')).includes('credentials.yaml'),false)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('CLI rejects unsupported flags and invalid budgets without opening configuration', () => {
  assert.throws(()=>parse(['mcp','--url','http://localhost']),/unknown option/)
  assert.throws(()=>parse(['mcp','--workspace']),/missing value/)
  assert.throws(()=>parse(['run','hello','--max-requests','17']),/invalid/)
  assert.equal(parse(['mcp','--workspace',process.cwd()]).options.workspace,process.cwd())
})

test('stdio EOF cancels the executor before waiting for its pending long poll', async () => {
  const input=new PassThrough(), output=new PassThrough()
  let polling, closed=false, started
  const ready=new Promise(resolve=>{started=resolve})
  const client={
    get(){started();return new Promise(resolve=>{polling=resolve})},
    async close(){closed=true;polling?.({id:'run-test',status:'killed'})},
  }
  const serving=runMcp(client,{input,output})
  input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dsh_run',arguments:{id:'run-test',waitMs:25000}}})+'\n')
  await ready
  input.end()
  const watchdog=setTimeout(()=>{polling?.({id:'run-test',status:'failed'})},1000)
  const before=Date.now()
  try {await serving;assert.equal(closed,true);assert.ok(Date.now()-before<500)}
  finally{clearTimeout(watchdog)}
})
