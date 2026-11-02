const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { openDatabase, schema, initialize } = require('./lib/database');
const { createUser, digest } = require('./lib/auth');
const { emptyState, validateState } = require('./lib/state');
const { createApplication } = require('./server');
const password = 'A-long-test-password-2026';

function integrationTest(name, fn) {
  for (const engine of ['sqlite','postgres']) test(`${name} [${engine}]`, t => fn(t, engine));
}
async function fixture(t, engine) {
  let db;
  if(engine === 'postgres') {
    const {PGlite} = require('@electric-sql/pglite');
    const pg = await PGlite.create();
    await pg.exec(schema);
    db = {kind:'postgres', query:async(sql,params=[]) => (await pg.query(sql,params)).rows,
      transaction:fn=>pg.transaction(tx=>fn(async(sql,params=[]) => (await tx.query(sql,params)).rows)), close:()=>pg.close()};
    await initialize(db);
  } else db = await openDatabase({url:'',filename:':memory:'});
  const admin = await createUser(db,{email:'admin@example.com',name:'Admin',password,role:'admin',mustChange:false});
  const {server} = await createApplication({db,production:false,skipBootstrap:true});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
  async function request(route, method='GET', data, session, overrides={}) {
    const response=await fetch(base+route,{
      method,headers:{Origin:base,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...overrides},
      ...(data===undefined?{}:{body:JSON.stringify(data)}),
    });
    const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}
    return {status:response.status,body,headers:response.headers};
  }
  async function login(email='admin@example.com', pass=password) {
    const result=await request('/api/login','POST',{email,password:pass});
    assert.equal(result.status,200,JSON.stringify(result.body));
    return {...result.body,cookie:result.headers.get('set-cookie').split(';')[0]};
  }
  return {db,admin,request,login};
}

integrationTest('anonymous API access is blocked and only public assets are served', async (t, engine)=>{
  const {request}=await fixture(t, engine);
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/backup')).status,401);
  for(const resource of ['/server.js','/.env','/lib/auth.js','/package.json','/data/reconcileiq.sqlite','/%2e%2e/server.js']) {
    assert.equal((await request(resource)).status,404,resource);
  }
  assert.equal((await request('/')).status,200);
  assert.deepEqual((await request('/health')).body,{ok:true});
});

integrationTest('sign-in uses hashed passwords, hashed sessions and HttpOnly SameSite cookies', async (t, engine)=>{
  const {db,request,login}=await fixture(t, engine);
  assert.equal((await request('/api/login','POST',{email:'admin@example.com',password:'wrong'})).status,401);
  const session=await login();
  const [user]=await db.query('SELECT password_hash FROM app_users');
  assert.ok(user.password_hash.startsWith('scrypt:'));assert.ok(!user.password_hash.includes(password));
  const [stored]=await db.query('SELECT token_hash FROM app_sessions');
  assert.equal(stored.token_hash,digest(session.cookie.split('=')[1]));
  const result=await request('/api/login','POST',{email:'admin@example.com',password});
  assert.match(result.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/session','GET',undefined,session)).body.user.role,'admin');
  assert.equal((await request('/api/logout','POST',{},session)).status,200);
  assert.equal((await request('/api/state','GET',undefined,session)).status,401);
});

integrationTest('viewer/editor/admin access and request forgery are enforced on the server', async (t, engine)=>{
  const {db,request,login}=await fixture(t, engine);
  await createUser(db,{email:'viewer@example.com',name:'Viewer',password,role:'viewer',mustChange:false});
  await createUser(db,{email:'editor@example.com',name:'Editor',password,role:'editor',mustChange:false});
  const viewer=await login('viewer@example.com');const editor=await login('editor@example.com');const admin=await login();
  assert.equal((await request('/api/state','GET',undefined,viewer)).status,200);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},viewer)).status,403);
  assert.equal((await request('/api/users','GET',undefined,editor)).status,403);
  assert.equal((await request('/api/backup','GET',undefined,editor)).status,403);
  assert.equal((await request('/api/restore','POST',{revision:0,state:emptyState()},editor)).status,403);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},admin,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},admin,{Origin:'https://other.example'})).status,403);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},editor)).status,200);
  assert.equal((await request('/api/users','GET',undefined,admin)).status,200);
});

integrationTest('two users cannot overwrite a revision; audit, backup and recovery preserve data', async (t, engine)=>{
  const {request,login}=await fixture(t, engine);
  const first=await login();const second=await login();
  const state=emptyState();state.invoices.push({id:'INV-1',customer:'Test Buyer',date:'2026-11-02',amount:500});
  const changed=structuredClone(state);changed.invoices[0].amount=900;
  const results=await Promise.all([
    request('/api/state','PUT',{revision:0,state},first),
    request('/api/state','PUT',{revision:0,state:changed},second),
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const latest=await request('/api/state','GET',undefined,second);
  assert.equal(latest.body.revision,1);assert.equal(latest.body.state.invoices.length,1);
  const backup=await request('/api/backup','GET',undefined,first);
  assert.deepEqual(backup.body.state,latest.body.state);
  assert.ok(!JSON.stringify(backup.body).includes('password_hash'));
  assert.ok(!JSON.stringify(backup.body).includes('token_hash'));
  const previous=await request('/api/snapshots/0','GET',undefined,first);
  assert.deepEqual(previous.body.state,emptyState());
  const restored=await request('/api/restore','POST',{revision:1,state:previous.body.state},first);
  assert.equal(restored.status,200);assert.equal(restored.body.revision,2);
  assert.equal(restored.body.state.invoices.length,0);
  const audit=await request('/api/audit','GET',undefined,first);
  assert.equal(audit.body.events.filter(event=>event.action==='workspace.saved').length,1);
  assert.equal(audit.body.events.filter(event=>event.action==='workspace.restored').length,1);
});

integrationTest('temporary passwords must change; changing roles and passwords revokes sessions', async (t, engine)=>{
  const {request,login}=await fixture(t, engine);const admin=await login();
  const result=await request('/api/users','POST',{email:'new@example.com',name:'New User',password,role:'editor'},admin);
  assert.equal(result.status,201);const id=result.body.user.id;
  const temporary=await login('new@example.com');assert.equal(temporary.user.mustChange,true);
  assert.equal((await request('/api/state','GET',undefined,temporary)).status,403);
  const nextPassword='A-different-test-password';
  assert.equal((await request('/api/password','POST',{currentPassword:password,password:nextPassword},temporary)).status,200);
  assert.equal((await request('/api/session','GET',undefined,temporary)).status,401);
  const user=await login('new@example.com',nextPassword);assert.equal(user.user.mustChange,false);
  assert.equal((await request(`/api/users/${id}`,'PATCH',{role:'viewer'},admin)).status,200);
  assert.equal((await request('/api/state','GET',undefined,user)).status,401);
  assert.equal((await login('new@example.com',nextPassword)).user.role,'viewer');
  assert.equal((await request(`/api/users/${id}`,'PATCH',{active:false},admin)).status,200);
  assert.equal((await request('/api/login','POST',{email:'new@example.com',password:nextPassword})).status,401);
  assert.equal((await request(`/api/users/${admin.user.id}`,'PATCH',{active:false},admin)).status,400);
});

integrationTest('validation rejects malformed data, duplicate invoices and mismatched buyers without advancing revision', async (t, engine)=>{
  const {request,login}=await fixture(t, engine);const admin=await login();
  const state=emptyState();state.invoices.push({id:'I1',customer:'Buyer',date:'2026-11-02',amount:100});
  for(const mutate of [
    s=>s.invoices.push({...s.invoices[0]}),
    s=>s.invoices[0].amount=-10,
    s=>s.invoices[0].date='2026-02-30',
    s=>s.invoices[0].customer='<script>alert(1)</script>',
    s=>s.customerTerms.push({customer:'Buyer',creditDays:-1}),
    s=>s.advice.push({id:'PA1',customer:'Other',invoice:'I1',date:'2026-11-02',amount:100,type:'Payment',utr:'UTR1'}),
  ]){
    const input=structuredClone(state);mutate(input);
    assert.equal((await request('/api/state','PUT',{revision:0,state:input},admin)).status,400);
  }
  assert.equal((await request('/api/state','PUT',null,admin)).status,400);
  assert.equal((await request('/api/state','GET',undefined,admin)).body.revision,0);
  const valid=await request('/api/state','PUT',{revision:0,state},admin);
  assert.equal(valid.status,200);assert.equal(valid.body.state.customerTerms[0].creditDays,45);
});

test('legacy invoice credit terms are migrated to one shared customer mapping',()=>{
  const state=emptyState();delete state.customerTerms;
  state.invoices=[{id:'I1',customer:'Buyer',date:'2026-11-02',amount:100,creditDays:60},{id:'I2',customer:' buyer ',date:'2026-11-02',amount:100,creditDays:15}];
  const migrated=validateState(state);
  assert.equal(migrated.customerTerms.length,1);assert.equal(migrated.customerTerms[0].creditDays,60);
  assert.ok(!('creditDays' in migrated.invoices[0]));
});

integrationTest('expired sessions are refused and concurrent access changes keep one administrator',async(t,engine)=>{
  const {db,request,login}=await fixture(t,engine);
  const first=await login();
  const secondUser=await createUser(db,{email:'admin2@example.com',name:'Admin Two',password,role:'admin',mustChange:false});
  const second=await login('admin2@example.com');
  const results=await Promise.all([
    request(`/api/users/${secondUser.id}`,'PATCH',{active:false},first),
    request(`/api/users/${first.user.id}`,'PATCH',{active:false},second),
  ]);
  assert.equal(results.filter(result=>result.status===200).length,1);
  const [active]=await db.query("SELECT COUNT(*) AS count FROM app_users WHERE active=1 AND role='admin'");
  assert.equal(Number(active.count),1);
  const survivor=await login(results[0].status===200?'admin@example.com':'admin2@example.com');
  await db.query('UPDATE app_sessions SET expires_at=$1',['2000-01-01T00:00:00.000Z']);
  assert.equal((await request('/api/state','GET',undefined,survivor)).status,401);
});

test('local shared data survives a database restart',async()=>{
  const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reconcileiq-test-'));
  const filename=path.join(directory,'workspace.sqlite');
  let db;
  try {
    db=await openDatabase({url:'',filename});
    const state=emptyState();state.invoices.push({id:'PERSIST',customer:'Buyer',date:'2026-11-02',amount:300});
    await db.query('UPDATE workspace SET data=$1,revision=1 WHERE id=1',[JSON.stringify(state)]);
    await db.close();db=await openDatabase({url:'',filename});
    const [saved]=await db.query('SELECT revision,data FROM workspace WHERE id=1');
    assert.equal(saved.revision,1);assert.equal(JSON.parse(saved.data).invoices[0].id,'PERSIST');
  }finally{
    if(db)await db.close();
    for(const suffix of ['','-wal','-shm'])fs.rmSync(filename+suffix,{force:true});
    fs.rmdirSync(directory);
  }
});

integrationTest('repeated login failures are throttled',async (t, engine)=>{
  const {request}=await fixture(t, engine);
  for(let index=0;index<10;index++) assert.equal((await request('/api/login','POST',{email:'missing@example.com',password})).status,401);
  assert.equal((await request('/api/login','POST',{email:'missing@example.com',password})).status,429);
});
