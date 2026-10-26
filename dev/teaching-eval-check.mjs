import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, prepareEvaluation, runEvaluation, inspectTurn, CASES, RUBRICS } from './teaching-eval.mjs'
import { nativePermissionArgs, evaluationPolicy } from './teaching-eval-guard.mjs'

test('教学验收默认只显示帮助；付费运行需要明确模式且限制场次', () => {
  assert.equal(parseArgs([]).mode, 'help')
  assert.equal(parseArgs(['--prepare']).mode, 'prepare')
  assert.deepEqual(parseArgs(['--run', 'prepared', '--case', 'repair']), { mode: 'run', directory: 'prepared', caseId: 'repair' })
  assert.deepEqual(parseArgs(['--run', 'prepared', '--case', 'contest']), { mode: 'run', directory: 'prepared', caseId: 'contest' })
  for (const args of [['--run'], ['--case', 'unknown'], ['--prepare', '--run', 'x'], ['--unknown']]) assert.throws(() => parseArgs(args))
})

test('每个教学场景都有独立判分项，且只能从合法场次进入', () => {
  assert.deepEqual(CASES, ['continuity', 'repair', 'replan', 'contest', 'decide', 'retarget', 'integrate', 'gap'])
  for (const id of CASES) {
    assert.ok(Array.isArray(RUBRICS[id]) && RUBRICS[id].length === 4, `${id}: rubric required`)
    assert.deepEqual(parseArgs(['--run', 'prepared', '--case', id]).caseId, id)
  }
})

test('真实已有junction不能把run内写入穿透到外部；直接HTTP不得绕过bank门禁', () => {
  const root = mkdtempSync(join(tmpdir(), 'coach-eval-alias-'))
  const run = join(root, 'run'), external = join(root, 'external'); mkdirSync(run); mkdirSync(external)
  const script = `const fs=require('fs'), http=require('http'), https=require('https'); const checks=[];
    (async()=>{for(const op of [()=>fs.writeFileSync(process.argv[1], 'bad'),
      ()=>http.request('http://127.0.0.1:1/fixture'),
      ()=>http.request(new URL('http://127.0.0.1:1/fixture'), {hostname:'localhost',headers:{host:'fixture.invalid'}}),
      ()=>https.get(new URL('https://fixture.invalid/fixture'), {hostname:'localhost',port:1}),
      ()=>fs.cpSync(process.argv[2], process.argv[3], {recursive:true}),
      ()=>fs.cp(process.argv[2], process.argv[3], {recursive:true}, ()=>{}),
      ()=>fs.promises.cp(process.argv[2], process.argv[3], {recursive:true})]) {
      try { await op(); checks.push(false) } catch { checks.push(true) }
    } console.log(JSON.stringify(checks));})().catch(e=>{console.error(e.message);process.exitCode=1});`
  try {
    symlinkSync(external, join(run, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const source = join(run, 'source'), destination = join(run, 'destination'); mkdirSync(join(source, 'nested'), {recursive:true}); mkdirSync(destination)
    writeFileSync(join(source, 'nested/copied.txt'), 'fixture')
    symlinkSync(external, join(destination, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
    const env = { ...process.env, COACH_EVAL_GUARD: '1', COACH_EVAL_ROOT: run, DSH_HOME: join(run, 'home'), COACH_DATA_DIR: join(run, 'home/knowledge'), COACH_DB: join(run, 'training.db'), HINDSIGHT_BANK: 'coach-eval-00000000-0000-4000-8000-000000000000', HINDSIGHT_URL: 'http://127.0.0.1:18888', COACH_EVAL_MODEL_URL: 'https://api.deepseek.com/anthropic' }
    const r = spawnSync(process.execPath, [...nativePermissionArgs(run), '-e', script, join(run, 'alias/bad.txt'), source, destination], { encoding: 'utf8', windowsHide: true, env })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), [true, true, true, true, true, true, true])
    assert.equal(existsSync(join(external, 'bad.txt')), false)
    assert.equal(existsSync(join(external, 'copied.txt')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('验收子进程使用原生权限：仅run目录可写，SQLite和子进程也不能越界', () => {
  const root = mkdtempSync(join(tmpdir(), 'coach-eval-boundary-'))
  const run = join(root, 'run'); mkdirSync(run)
  const script = `const fs=require('fs'), {DatabaseSync}=require('node:sqlite'), cp=require('child_process');
    const denied=[]; fs.writeFileSync(process.argv[1], 'inside');
    for(const operation of [()=>fs.writeFileSync(process.argv[2], 'outside'), ()=>new DatabaseSync(process.argv[3]), ()=>cp.spawnSync(process.execPath, ['-v'])]) {
      try { operation(); denied.push(false) } catch(e) { denied.push(e.code==='ERR_ACCESS_DENIED') }
    } console.log(JSON.stringify(denied));`
  try {
    const env = { ...process.env, COACH_EVAL_GUARD: '1', COACH_EVAL_ROOT: run, DSH_HOME: join(run, 'home'), COACH_DATA_DIR: join(run, 'home/knowledge'), COACH_DB: join(run, 'training.db'), HINDSIGHT_BANK: 'coach-eval-00000000-0000-4000-8000-000000000000', HINDSIGHT_URL: 'http://127.0.0.1:18888', COACH_EVAL_MODEL_URL: 'https://api.deepseek.com/anthropic' }
    const r = spawnSync(process.execPath, [...nativePermissionArgs(run), '-e', script, join(run, 'safe.txt'), join(root, 'outside.txt'), join(root, 'outside.db')], { encoding: 'utf8', windowsHide: true, env })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), [true, true, true])
    assert.equal(readFileSync(join(run, 'safe.txt'), 'utf8'), 'inside')
    assert.equal(existsSync(join(root, 'outside.txt')), false)
    assert.equal(existsSync(join(root, 'outside.db')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('验收policy只允许明确模型origin和本场bank，配置不能指向外部目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'coach-eval-policy-'))
  const config = {root, home:join(root,'home'), data:join(root,'knowledge'), db:join(root,'training.db'), bank:'coach-eval-00000000-0000-4000-8000-000000000000', memoryURL:'http://127.0.0.1:1', modelURL:'https://model.fixture.invalid'}
  try {
    const policy = evaluationPolicy(config)
    assert.doesNotThrow(()=>policy.assertURL(`${config.memoryURL}/v1/default/banks/${config.bank}/recall`))
    assert.doesNotThrow(()=>policy.assertURL(`${config.modelURL}/v1/messages`))
    for (const url of [`${config.memoryURL}/v1/default/banks/formal/recall`, `${config.memoryURL}/v1/default/banks/${config.bank}-other/recall`, 'https://other.fixture.invalid/v1/messages']) assert.throws(()=>policy.assertURL(url))
    assert.throws(()=>evaluationPolicy({...config, formalBank:config.bank}))
    assert.throws(()=>evaluationPolicy({...config, db:join(root,'../outside.db')}))
    assert.throws(()=>policy.assertWrite(join(root,'../outside.txt')))
  } finally { rmSync(root, {recursive:true,force:true}) }
})

test('SQLite原生authorizer拒绝ATTACH、VACUUM INTO、目录PRAGMA，允许本场正常建表', () => {
  const root = mkdtempSync(join(tmpdir(), 'coach-eval-sql-'))
  const run = join(root,'run'); mkdirSync(run)
  const script = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE fixture (n INTEGER)'); const denied=[];
    for(const sql of ["ATTACH/**/DATABASE ':memory:' AS extra", "VACUUM INTO '"+process.argv[2].replaceAll("'","''")+"'", "PRAGMA temp_store_directory='"+process.argv[3].replaceAll("'","''")+"'"]) {
      try { db.exec(sql); denied.push(false) } catch { denied.push(true) }
    } try { db.setAuthorizer(()=>0); denied.push(false) } catch { denied.push(true) } db.close(); console.log(JSON.stringify(denied));`
  try {
    const env = {...process.env,COACH_EVAL_GUARD:'1',COACH_EVAL_ROOT:run,DSH_HOME:join(run,'home'),COACH_DATA_DIR:join(run,'knowledge'),COACH_DB:join(run,'training.db'),HINDSIGHT_BANK:'coach-eval-00000000-0000-4000-8000-000000000000',HINDSIGHT_URL:'http://127.0.0.1:1',COACH_EVAL_MODEL_URL:'https://model.fixture.invalid'}
    const result = spawnSync(process.execPath,[...nativePermissionArgs(run),'-e',script,env.COACH_DB,join(root,'outside.db'),root],{encoding:'utf8',windowsHide:true,env})
    assert.equal(result.status,0,result.stderr)
    assert.deepEqual(JSON.parse(result.stdout),[true,true,true,true])
    assert.equal(existsSync(join(root,'outside.db')),false)
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('完成事件与最终回复只证明机械完整性，证据不保留密钥和思维链', () => {
  const evidence = inspectTurn({ records: [
    { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, data: { message: { source: { kind: 'model', replayState: { private: 'hidden' } }, content: [
      { type: 'reasoning', text: 'hidden-reasoning' }, { type: 'text', text: 'fixture-secret 最终答复' },
    ] } } } },
    { type: 'event', event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } } },
  ] }, 0, ['fixture-secret'])
  assert.deepEqual(evidence.mechanical, { completed: true, hasReply: true, studentInputs: 1 })
  assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret|hidden-reasoning|replayState/)
  assert.equal(evidence.teaching, undefined)
  assert.equal(inspectTurn({ records: [] }).mechanical.completed, false)
})

test('公开prepare/run经原生RPC形状的离线夹具验证新会话续课，普通测试不调用模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coach-eval-rpc-fixture-'))
  const keys = ['DSH_EVAL_CLI', 'DSH_APP_NODE_MODULES', 'DEEPSEEK_API_KEY', 'HINDSIGHT_URL']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    const cli = join(root, 'fixture-cli.mjs'), modules = join(root, 'modules')
    mkdirSync(join(modules, '@deepseek-ai/dsh-base'), { recursive: true })
    writeFileSync(join(modules, '@deepseek-ai/dsh-base/package.json'), '{"name":"@deepseek-ai/dsh-base"}')
    mkdirSync(join(modules, '@deepseek-ai/dsh-tools'), { recursive: true })
    writeFileSync(join(modules, '@deepseek-ai/dsh-tools/package.json'), '{"name":"@deepseek-ai/dsh-tools"}')
    symlinkSync(modules, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(cli, `import http from 'node:http';
      const port=Number(process.argv[process.argv.indexOf('--port')+1]), sessions=new Map(); let next=0;
      const server=http.createServer(async(req,res)=>{
        if(req.method==='GET'){res.writeHead(303,{'Set-Cookie':'fixture-cookie=fixture-cookie-value; HttpOnly','Location':'/'});res.end();return}
        let body='';for await(const chunk of req)body+=chunk;
        const data=JSON.parse(body), args=data.payload.args, request=args.request||args._request;let value;
        if(data.method==='session/create'){const id='fixture-session-'+(++next);sessions.set(id,{seq:0,events:[]});value={sessionId:id}}
        if(data.method==='session/list')value={items:[...sessions].map(([id,s])=>({id,running:false,projections:{asOfSeq:s.seq,values:{inbox:{}}}}))};
        if(data.method==='session/prompt'){const s=sessions.get(request.sessionId);s.events=[
          {type:'event',event:{type:'user/message',seq:++s.seq,data:{source:{kind:'user'},content:request.content}}},
          {type:'event',event:{type:'assistant/message',seq:++s.seq,data:{message:{source:{kind:'model'},content:[
            {type:'text',text:'中途讲解状态定义 fixture-model-key'}, {type:'reasoning',text:'hidden-teaching-thought'},
            {type:'tool-call',name:'fixture-tool',arguments:'fixture-private-arguments'},
          ]}}}},
          {type:'event',event:{type:'assistant/message',seq:++s.seq,data:{message:{source:{kind:'model'},content:[{type:'text',text:'离线RPC夹具回复，不是模型教学评分'}]}}}},
          {type:'event',event:{type:'turn/end',seq:++s.seq,data:{reason:{kind:'completed'}}}}];value={accepted:true}}
        if(data.method==='session/page')value={records:sessions.get(request.address.sessionId).events};
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result:{ok:true,value}}));
      });server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?token=fixture-token-value'));
    `)
    Object.assign(process.env, { DSH_EVAL_CLI: cli, DSH_APP_NODE_MODULES: modules, DEEPSEEK_API_KEY: 'fixture-model-key', HINDSIGHT_URL: 'http://127.0.0.1:1' })
    const prepared = await prepareEvaluation(root)
    const profile = JSON.parse(readFileSync(join(prepared, 'continuity/home/profiles/web/package.json'), 'utf8'))
    assert.ok(existsSync(join(prepared, 'decide/home/knowledge/TARGET.yaml')), '拍板场景需要目标夹具')
    assert.ok(existsSync(join(prepared, 'decide/home/knowledge/CURRICULUM.yaml')), '拍板场景需要课程夹具')
    assert.ok(existsSync(join(prepared, 'retarget/home/knowledge/CURRICULUM.yaml')), '目标变更场景需要课程夹具')
    assert.ok(!existsSync(join(prepared, 'integrate/home/knowledge/CURRICULUM.yaml')), '融合场景不该有课程夹具')
    assert.equal(typeof profile.version, 'string', '原生DeepSeek包清单扩展要求profile有version')
    try { await runEvaluation(prepared, 'continuity') }
    catch (error) { throw new Error(`${error.message}\n${readFileSync(join(prepared, 'continuity/server.log'), 'utf8')}`) }
    const result = JSON.parse(readFileSync(join(prepared, 'continuity/result.json'), 'utf8'))
    assert.equal(result.mechanical.finished, true)
    assert.equal(result.mechanical.studentInputs, 2)
    assert.notEqual(result.turns[0].sessionId, result.turns[1].sessionId, '续课必须进入真正的新session')
    assert.equal(result.turns[0].ledger.before['PROGRESS.yaml'].exists, true)
    assert.equal(result.turns[1].ledger.after['CURRICULUM.yaml'].exists, false)
    assert.equal(result.teaching.status, 'not-scored')
    assert.doesNotMatch(JSON.stringify(result), /fixture-model-key|fixture-token-value|fixture-cookie-value/)
    const readableReport = readFileSync(join(prepared, 'report.md'), 'utf8')
    assert.match(readableReport, /中途讲解状态定义/, '人工报告必须包含工具调用前给学生的讲解，而非仅最后一句收尾')
    assert.doesNotMatch(readableReport, /fixture-model-key|hidden-teaching-thought|fixture-private-arguments/)
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    rmSync(root, { recursive: true, force: true })
  }
})
