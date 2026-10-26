import {createHash, randomUUID} from 'node:crypto';
import {execFile, execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const helperPath=fileURLToPath(import.meta.url);
const packageRoot=resolve(dirname(helperPath),'..');
const extensionDir=join(packageRoot,'extensions');
const stateDir=join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(),'.pi','agent'),'local-compact');
const packageName='@earendil-works/pi-coding-agent';
const defaults={
  extensionPath:join(extensionDir,'local-compact.ts'),
  testPath:join(packageRoot,'test','compact-sdk.test.mjs'),
  cachePath:join(stateDir,'health.json'),
  logPath:join(stateDir,'health.log'),
};

function globalPiRootCandidates() {
  const candidates=[process.env.LOCAL_COMPACT_PI_ROOT];
  if(process.env.APPDATA)candidates.push(join(process.env.APPDATA,'npm/node_modules',packageName));
  try{candidates.push(join(execFileSync('npm',['root','-g'],{encoding:'utf8',shell:process.platform==='win32',windowsHide:true}).trim(),packageName));}catch{}
  return candidates.filter(Boolean);
}

export async function findPiRoot(entry=process.argv[1]) {
  if(entry) {
    let directory=dirname(resolve(entry));
    while(true) {
      try {
        if(JSON.parse(await fs.readFile(join(directory,'package.json'),'utf8')).name===packageName)return directory;
      } catch {}
      const parent=dirname(directory);if(parent===directory)break;directory=parent;
    }
  }
  for(const candidate of globalPiRootCandidates()) {
    try {
      if(JSON.parse(await fs.readFile(join(candidate,'package.json'),'utf8')).name===packageName)return candidate;
    } catch {}
  }
  throw new Error('piのインストール先を確認できません');
}

async function fingerprint(options) {
  const hash=createHash('sha256');hash.update(process.version);hash.update(options.packageRoot);
  const manifest=JSON.parse(await fs.readFile(join(options.packageRoot,'package.json'),'utf8'));
  const files=[options.extensionPath,options.testPath,helperPath,join(extensionDir,'local-compact-health.ts'),
    join(options.packageRoot,'package.json'),join(options.packageRoot,'dist/index.js'),
    join(options.packageRoot,'dist/core/compaction/compaction.js')];
  for(const file of files){hash.update(file);hash.update(await fs.readFile(file));}
  // バンドルの再インストールも拾う一方、毎起動の巨大ファイル読み込みは避ける。
  for(const file of [join(options.packageRoot,'dist/bundle/cli.js'),join(options.packageRoot,'node_modules/@earendil-works/pi-ai/package.json'),join(options.packageRoot,'node_modules/@earendil-works/pi-agent-core/package.json')]){
    try{const stat=await fs.stat(file);hash.update(`${file}:${stat.size}:${stat.mtimeMs}`);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {fingerprint:hash.digest('hex'),version:manifest.version};
}

function runTests(options) {
  return new Promise(resolveResult=>{
    const env={...process.env,LOCAL_COMPACT_EXTENSION:options.extensionPath,LOCAL_COMPACT_PI_ROOT:options.packageRoot};
    // 検査自体をnode:testから試す場合も、子の独立したテスト実行を再帰扱いで省略させない。
    delete env.NODE_TEST_CONTEXT;
    execFile(process.execPath,['--test',options.testPath],{
      windowsHide:true,timeout:30000,maxBuffer:1024*1024,
      env,
    },(error,stdout,stderr)=>resolveResult({code:error?error.code:0,output:`${stdout}\n${stderr}${error?`\n${error.message}`:''}`}));
  });
}

export async function checkLocalCompactHealth(input={}) {
  const options={...defaults,...input};
  try {
    options.packageRoot??=await findPiRoot();
    const identity=await fingerprint(options);
    if(!options.force) {
      try {
        const cached=JSON.parse(await fs.readFile(options.cachePath,'utf8'));
        if(cached.fingerprint===identity.fingerprint&&typeof cached.ok==='boolean')return {...cached,cached:true};
      } catch {}
    }
    const started=performance.now();
    const execution=await (options.runTests ?? runTests)(options);
    const tests=Number(execution.output.match(/^# tests (\d+)$/m)?.[1] ?? 0);
    const passed=Number(execution.output.match(/^# pass (\d+)$/m)?.[1] ?? 0);
    const failed=Number(execution.output.match(/^# fail (\d+)$/m)?.[1] ?? -1);
    const result={...identity,ok:execution.code===0&&tests>=9&&passed===tests&&failed===0,tests,passed,
      checkedAt:new Date().toISOString(),seconds:(performance.now()-started)/1000,logPath:options.logPath};
    await fs.mkdir(dirname(options.logPath),{recursive:true});
    await fs.writeFile(options.logPath,`pi ${identity.version}\n${result.checkedAt}\n${execution.output}`,'utf8');
    await fs.mkdir(dirname(options.cachePath),{recursive:true});
    const temporary=`${options.cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try{await fs.writeFile(temporary,JSON.stringify(result,null,2),'utf8');await fs.rename(temporary,options.cachePath);}
    finally{await fs.unlink(temporary).catch(()=>{});}
    return {...result,cached:false};
  } catch(error) {
    return {ok:false,cached:false,error:error instanceof Error?error.message:String(error),logPath:options.logPath};
  }
}

export function registerHealthWatch(pi,options={}) {
  let pending;
  async function check(ctx,force) {
    pending??=(options.check ?? checkLocalCompactHealth)({...options,force}).finally(()=>{pending=undefined;});
    const result=await pending;
    if(result.ok) {
      ctx.ui.setStatus?.('local-compact-health',undefined);
      if(force)ctx.ui.notify(`Compact互換チェックOK: pi ${result.version} / ${result.passed}件通過（モデル未使用）`,'info');
    } else {
      const label='Compact互換性NG';
      ctx.ui.setStatus?.('local-compact-health',ctx.ui.theme?.fg?.('error',label) ?? label);
      ctx.ui.notify(`Compact拡張の互換チェックに失敗。thinking OFF・キャッシュ再利用は要確認。/compact-check で再検査。${result.error ?? `詳細: ${result.logPath}`}`,'error');
    }
    return result;
  }
  pi.on('session_start',async(_event,ctx)=>{await check(ctx,false);});
  pi.registerCommand('compact-check',{description:'compact拡張の互換性をモデルを使わず再検査',handler:async(_args,ctx)=>{await check(ctx,true);}});
}
