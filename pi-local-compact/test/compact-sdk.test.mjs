import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { findPiRoot } from '../src/local-compact-health.mjs';
const root=await fs.mkdtemp(join(process.env.LOCAL_COMPACT_TEST_ROOT ?? tmpdir(),'local-compact-test-'));
const extensionPath=process.env.LOCAL_COMPACT_EXTENSION ?? fileURLToPath(new URL('../extensions/local-compact.ts',import.meta.url));
const base=join(await findPiRoot(null),'dist');
const sdk=await import(pathToFileURL(join(base,'index.js')));
const {prepareCompaction}=await import(pathToFileURL(join(base,'core/compaction/compaction.js')));
const provider='localllm-llamacpp-local';
process.env.PI_LOCAL_COMPACT_PROVIDERS=provider;
const usage={input:500,output:30,cacheRead:0,cacheWrite:0,totalTokens:530,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
let counter=0;
async function fixture(mode='stop',captured=true,withImage=false){
 const dir=join(root,'tests',String(++counter));await fs.mkdir(dir,{recursive:true});
 const requests=[];let summarize=false;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const payload=JSON.parse(raw);requests.push(payload);
  const failure=summarize?mode:'stop';
  if(failure==='hold'){req.on('close',()=>res.end());return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const base={id:'fixture',object:'chat.completion.chunk',created:0,model:'coder390'};
  const delta=failure==='tool_calls'?{tool_calls:[{index:0,id:'no-execute',type:'function',function:{name:'write',arguments:'{"path":"D:/never-create.txt","content":"bad"}'}}]}:{content:failure==='empty'?'':'## Goal\nPreserve the exact task.\n## Next Steps\nRun the pending check.'};
  if(!summarize&&withImage)delta.reasoning_content='Keep the completed reasoning byte-for-byte for prefix reuse.';
  res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:failure==='empty'?'stop':failure}],usage:{prompt_tokens:500,completion_tokens:30,total_tokens:530}})}\n\n`);
  res.end('data: [DONE]\n\n');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
 await fs.writeFile(join(dir,'models.json'),JSON.stringify({providers:{[provider]:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'test',models:[{id:'coder390',name:'test',reasoning:true,input:['text','image'],contextWindow:131072,maxTokens:65536,cost:usage.cost,compat:{supportsReasoningEffort:true}}]}}}));
 const runtime=await sdk.ModelRuntime.create({modelsPath:join(dir,'models.json'),authPath:join(dir,'auth.json'),modelsStorePath:join(dir,'catalog.json'),refreshOnCreate:false});
 const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false,reserveTokens:16384,keepRecentTokens:100},retry:{enabled:false}});
 const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,additionalExtensionPaths:[extensionPath],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await loader.reload();
 assert.deepEqual(loader.getExtensions().errors,[]);
 const manager=sdk.SessionManager.inMemory(dir);
 for(let i=0;i<4;i++){
  const content=[{type:'text',text:`Goal ${i}: keep exact path D:/fixture/task.py and pending validation. `.repeat(18)}];
  const picture={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII='};
  if(withImage===true&&i===0)content.push(picture);
  manager.appendMessage({role:'user',content,timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:`tool-${i}`,name:'write',arguments:{path:`D:/fixture/file-${i}.py`,content:'fixture'}}],api:'openai-completions',provider,model:'coder390',stopReason:'toolUse',timestamp:Date.now(),usage});
  manager.appendMessage({role:'toolResult',toolCallId:`tool-${i}`,toolName:'write',content:[{type:'text',text:'Fixture result; no file was written.'},...(withImage==='tool'&&i===3?[picture]:[])],isError:false,timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'Recorded goal and next step.'}],api:'openai-completions',provider,model:'coder390',stopReason:'stop',timestamp:Date.now(),usage});
 }
 const {session}=await sdk.createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel(provider,'coder390'),thinkingLevel:'medium',resourceLoader:loader,settingsManager:settings,sessionManager:manager});await session.bindExtensions({uiContext:{notify:message=>console.log(message)}});
 if(captured)await session.prompt('Continue the task.');
 const normal=requests.at(-1),before=requests.length,leaf=manager.getLeafId();
 const prep=prepareCompaction(manager.getBranch(),{enabled:true,reserveTokens:16384,keepRecentTokens:100});summarize=true;
 return {session,manager,normal,requests,before,leaf,prep,close:async()=>{session.dispose();await new Promise(r=>server.close(r));}};
 } catch(error) {
  server.closeAllConnections();await new Promise(r=>server.close(r));throw error;
 }
}
test('one native-prefix request preserves tools, retained boundary and file tracking, with thinking off',async()=>{
 const f=await fixture();try{
  const result=await f.session.compact('Keep the pending validation exact.');
  const summaries=f.requests.slice(f.before);assert.equal(summaries.length,1);
  const request=summaries[0],history=request.messages.slice(0,-1);
  assert.deepEqual(history,f.normal.messages.slice(0,history.length));assert.deepEqual(request.tools,f.normal.tools);
  assert.equal(request.chat_template_kwargs.enable_thinking,false);assert.equal(request.cache_prompt,true);
  assert.equal(f.normal.chat_template_kwargs?.enable_thinking,undefined);
  assert.match(JSON.stringify(request.messages.at(-1)),/Keep the pending validation exact/);
  assert.equal(result.firstKeptEntryId,f.prep.firstKeptEntryId);assert.ok(result.details.modifiedFiles.includes('D:/fixture/file-0.py'));
 }finally{await f.close();}
});
for(const failure of ['length','empty','tool_calls'])test(`${failure} summary never replaces the session`,async()=>{
 const f=await fixture(failure);try{await assert.rejects(()=>f.session.compact());assert.equal(f.manager.getLeafId(),f.leaf);assert.equal(f.requests.length-f.before,1);}finally{await f.close();}
});
for(const imageSource of [true,'tool'])test(`images from ${imageSource===true?'user':'tool result'} and the completed reply stay in the native prefix`,async()=>{
 const f=await fixture('stop',true,imageSource);try{
  const result=await f.session.compact();const summaries=f.requests.slice(f.before);assert.equal(summaries.length,1);
  const p=summaries[0];assert.equal(p.chat_template_kwargs.enable_thinking,false);assert.equal(p.cache_prompt,true);
  assert.deepEqual(p.messages.slice(0,f.normal.messages.length),f.normal.messages);
  assert.equal(p.messages.length,f.normal.messages.length+2);
  assert.equal(p.messages.at(-2).role,'assistant');assert.match(JSON.stringify(p.messages.at(-2)),/Preserve the exact task/);
  assert.match(JSON.stringify(p.messages.at(-2)),/Keep the completed reasoning byte-for-byte/);
  assert.ok(JSON.stringify(p).includes('data:image'));assert.equal(result.details.localCompact.images,true);
  assert.equal(result.firstKeptEntryId,f.prep.firstKeptEntryId);
 }finally{await f.close();}
});
test('repeated compaction retains the previous extension file ledger',async()=>{
 const f=await fixture();try{const first=await f.session.compact();assert.ok(first.details.modifiedFiles.includes('D:/fixture/file-0.py'));await f.session.prompt('Follow-up task with the same constraints. '.repeat(80));const second=await f.session.compact();assert.ok(second.details.modifiedFiles.includes('D:/fixture/file-0.py'));}finally{await f.close();}
});
test('cancelling compaction leaves the original session intact',async()=>{
 const f=await fixture('hold');try{const pending=f.session.compact();const timer=setTimeout(()=>f.session.abortCompaction(),50);await assert.rejects(()=>pending);clearTimeout(timer);assert.equal(f.manager.getLeafId(),f.leaf);}finally{await f.close();}
});
test('after reload / without a captured request, standard compaction still uses thinking off',async()=>{
 const f=await fixture('stop',false);try{await f.session.compact();assert.ok(f.requests.length);for(const p of f.requests)assert.equal(p.chat_template_kwargs.enable_thinking,false);}finally{await f.close();}
});
