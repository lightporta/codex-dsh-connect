#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkIsolation, runBounded } from '../lib/check.js'
import { createFixture, isolatedEnvironment } from '../lib/isolation.mjs'
import { buildSandboxLaunch } from '../lib/launch.mjs'

async function main() {
  const live = process.argv.includes('--live')
  if (process.argv.slice(2).some(arg => arg !== '--live' && arg !== '--check')) return { ok:false, outcome:'invalidArgument' }
  const check = await checkIsolation()
  if (!live || !check.ok) return check
  let root, verifier, child
  const pending = new Map()
  try {
    root = await realpath(await mkdtemp(join(tmpdir(),'codex-dsh-live-')))
    await writeFile(join(root,'math.mjs'),'export function add(a,b) { return a-b }\n',{mode:0o600})
    const bin=fileURLToPath(new URL('../bin/codex-dsh-connect.mjs',import.meta.url))
    child=spawn(process.execPath,[bin,'mcp','--workspace',root,'--timeout-ms','60000'],{cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},detached:true,shell:false,stdio:['pipe','pipe','pipe']})
    let buffer='',ordinal=0,bytes=0
    const fail=()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('MCP closed'))}pending.clear()}
    child.on('error',fail);child.on('close',fail);child.stdin.on('error',()=>{})
    child.stderr.on('data',chunk=>{bytes+=chunk.length})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data',chunk=>{
      bytes+=Buffer.byteLength(chunk)
      if(bytes>1024*1024){child.kill('SIGTERM');fail();return}
      buffer+=chunk
      for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
        try{const response=JSON.parse(line),item=pending.get(response.id);if(!item)continue;pending.delete(response.id);clearTimeout(item.timer);response.error||response.result?.isError?item.reject(new Error('MCP error')):item.resolve(response.result)}catch{fail()}
      }
    })
    const call=(method,params)=>new Promise((resolve,reject)=>{const id=++ordinal;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP deadline'))},28000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})
    const invoke=async(name,args)=>JSON.parse((await call('tools/call',{name,arguments:args})).content[0].text)
    const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-smoke',version:'1'}})
    if(init.serverInfo.name!=='codex-dsh-connect') throw new Error('identity')
    const tools=await call('tools/list',{})
    if(tools.tools.length!==5) throw new Error('catalog')
    const started=Date.now()
    let run=await invoke('dsh_delegate',{task:'只操作 math.mjs。先用 project_read_text 读取，再用 project_write_text 修复 add(a,b) 为加法，保留 export；不读取其他文件。最后一句话报告。',maxOutputChars:4000})
    while(run.status==='running'&&Date.now()-started<75000) run=await invoke('dsh_run',{id:run.id,waitMs:25000,maxOutputChars:4000})
    if(run.status!=='completed'||run.output?.available!==true) throw new Error('native failed')
    verifier=await createFixture({workspace:root,live:false,auth:'account'})
    if (process.platform === 'darwin') await writeFile(verifier.policy,await readFile(verifier.policy,'utf8')+'\n(deny network*)\n',{mode:0o600})
    const source = `import(${JSON.stringify(pathToFileURL(join(root, 'math.mjs')).href)}).then(({add})=>{if(add(2,3)!==5||add(-3,8)!==5||add(0,0)!==0)process.exitCode=1}).catch(()=>{process.exitCode=1})`
    const launch = buildSandboxLaunch(verifier, ['--input-type=module', '-e', source], { env: isolatedEnvironment({scratch:verifier.scratch,source:{},live:false}) })
    const verified=await runBounded(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,timeoutMs:10000})
    return {ok:verified.code===0&&!verified.timedOut&&!verified.overflow,mode:'standalone-stdio-native',nativeVersion:verifier.version,provider:'deepseek-account',model:'deepseek-flash',codeVerified:verified.code===0,compactChars:JSON.stringify(run).length,toolCalls:run.counts?.toolCalls,usage:run.usage}
  } catch { return {ok:false,outcome:'standaloneSmokeFailed'} }
  finally {
    for(const item of pending.values())clearTimeout(item.timer)
    if(child){child.stdin.end();child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);try{process.kill(-child.pid,'SIGKILL')}catch{}}
    if(verifier)await rm(verifier.scratch,{recursive:true,force:true})
    if(root)await rm(root,{recursive:true,force:true})
  }
}
const report=await main()
process.stdout.write(JSON.stringify(report)+'\n')
process.exitCode=report.ok?0:1
