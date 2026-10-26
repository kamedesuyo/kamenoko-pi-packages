import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import {checkLocalCompactHealth,findPiRoot,registerHealthWatch} from '../src/local-compact-health.mjs';

const sdkSuite=fileURLToPath(new URL('./compact-sdk.test.mjs',import.meta.url));
const healthExtension=fileURLToPath(new URL('../extensions/local-compact-health.ts',import.meta.url));

const success={code:0,output:'# tests 9\n# pass 9\n# fail 0\n'};
const failure={code:1,output:'# tests 9\n# pass 8\n# fail 1\n'};
async function fixture(){
 const directory=await fs.mkdtemp(join(tmpdir(),'compact-health-test-'));
 const packageRoot=join(directory,'pi');await fs.mkdir(join(packageRoot,'dist/core/compaction'),{recursive:true});
 await fs.writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.4.0'}));
 await fs.writeFile(join(packageRoot,'dist/index.js'),'test SDK');
 await fs.writeFile(join(packageRoot,'dist/core/compaction/compaction.js'),'test compact');
 const extensionPath=join(directory,'local-compact.ts'),testPath=join(directory,'test.mjs');
 await fs.writeFile(extensionPath,'test extension');await fs.writeFile(testPath,'test suite');
 return {packageRoot,extensionPath,testPath,cachePath:join(directory,'health.json'),logPath:join(directory,'health.log')};
}

test('unchanged startup uses saved results; extension, pi and test updates trigger a check',async()=>{
 const options=await fixture();let calls=0;options.runTests=async()=>{calls++;return success;};
 assert.equal((await checkLocalCompactHealth(options)).ok,true);
 assert.equal((await checkLocalCompactHealth(options)).cached,true);assert.equal(calls,1);
 await fs.appendFile(options.extensionPath,' updated');assert.equal((await checkLocalCompactHealth(options)).cached,false);
 await fs.writeFile(join(options.packageRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.4.1'}));
 assert.equal((await checkLocalCompactHealth(options)).version,'1.4.1');
 await fs.appendFile(options.testPath,' updated');assert.equal((await checkLocalCompactHealth(options)).cached,false);
 assert.equal(calls,4);
 assert.equal(await findPiRoot(join(options.packageRoot,'dist/bundle/cli.js')),options.packageRoot);
});

test('failed result remains visible without rerunning; manual retry can recover',async()=>{
 const options=await fixture();let calls=0;options.runTests=async()=>{calls++;return calls===1?failure:success;};
 assert.equal((await checkLocalCompactHealth(options)).ok,false);
 const cached=await checkLocalCompactHealth(options);assert.equal(cached.ok,false);assert.equal(cached.cached,true);assert.equal(calls,1);
 assert.equal((await checkLocalCompactHealth({...options,force:true})).ok,true);assert.equal(calls,2);
});

test('a missing extension is reported even when the previous check passed',async()=>{
 const options=await fixture();options.runTests=async()=>success;
 await checkLocalCompactHealth(options);
 const result=await checkLocalCompactHealth({...options,extensionPath:join(options.packageRoot,'missing.ts')});
 assert.equal(result.ok,false);assert.match(result.error,/ENOENT/);
});

test('real SDK rejects a broken extension and the check exits without calling a model',async()=>{
 const options=await fixture();
 await fs.writeFile(options.extensionPath,'export default function ( { this is deliberately invalid TypeScript');
 const result=await checkLocalCompactHealth({...options,packageRoot:await findPiRoot(),testPath:sdkSuite});
 assert.equal(result.ok,false);assert.equal(result.tests,9);assert.equal(result.passed,0);
 assert.match(await fs.readFile(options.logPath,'utf8'),/error|Error/);
});

test('startup failure leaves a warning and status; explicit successful retry clears them',async()=>{
 const handlers=new Map(),commands=new Map(),notices=[],statuses=[];let healthy=false;
 registerHealthWatch({on:(name,handler)=>handlers.set(name,handler),registerCommand:(name,command)=>commands.set(name,command)},
  {check:async()=>healthy?{ok:true,version:'1.4.0',passed:9}:{ok:false,logPath:'D:/health.log'}});
 const ctx={ui:{notify:(...args)=>notices.push(args),setStatus:(...args)=>statuses.push(args)}};
 await handlers.get('session_start')({reason:'startup'},ctx);
 assert.equal(notices[0][1],'error');assert.match(statuses[0][1],/NG/);
 healthy=true;await commands.get('compact-check').handler('',ctx);
 assert.equal(statuses.at(-1)[1],undefined);assert.match(notices.at(-1)[0],/9件通過/);
 const count=notices.length;await handlers.get('session_start')({reason:'reload'},ctx);assert.equal(notices.length,count);
});

test('installed watchdog runs on actual SDK startup and reload without model requests',async()=>{
 const packageRoot=await findPiRoot();
 const sdk=await import(pathToFileURL(join(packageRoot,'dist/index.js')));
 const directory=await fs.mkdtemp(join(tmpdir(),'compact-health-session-'));
 const modelsPath=join(directory,'models.json');
 await fs.writeFile(modelsPath,JSON.stringify({providers:{fixture:{baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:8192,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 const runtime=await sdk.ModelRuntime.create({modelsPath,authPath:join(directory,'auth.json'),modelsStorePath:join(directory,'catalog.json'),refreshOnCreate:false});
 const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
 const loader=new sdk.DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:settings,additionalExtensionPaths:[healthExtension],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const {session}=await sdk.createAgentSession({cwd:directory,agentDir:directory,modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,settingsManager:settings,sessionManager:sdk.SessionManager.inMemory(directory)});
 const notices=[],statuses=[];
 try {
  await session.bindExtensions({uiContext:{notify:(...args)=>notices.push(args),setStatus:(...args)=>statuses.push(args)}});
  assert.equal(statuses.length,1);assert.deepEqual(notices,[]);
  await session.reload();assert.equal(statuses.length,2);assert.deepEqual(notices,[]);
 } finally {session.dispose();}
});
