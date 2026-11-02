const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createNetlifyHandler}=require('./lib/netlify-handler');
const {openDatabase,qualifySql,postgresConnectionOptions}=require('./lib/database');
const {createApplication}=require('./server');
const {createUser}=require('./lib/auth');
const {emptyState}=require('./lib/state');

const origin='https://reconcileiq-test.netlify.app';
const context={site:{url:origin},ip:'198.51.100.1',requestId:'test-request'};
test('Netlify Fetch handler preserves authentication cookies, CSRF and shared writes',async t=>{
  const db=await openDatabase({url:'',filename:':memory:'});t.after(()=>db.close());
  await createUser(db,{email:'admin@example.com',name:'Admin',password:'A-long-test-password',role:'admin',mustChange:false});
  const handle=createNetlifyHandler(options=>createApplication({...options,db,skipBootstrap:true}));
  const request=(route,method='GET',data,cookie,csrf)=>handle(new Request(origin+route,{
    method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},
    ...(data===undefined?{}:{body:JSON.stringify(data)}),
  }),context);
  assert.deepEqual(await(await request('/health')).json(),{ok:true});
  assert.equal((await request('/api/state')).status,401);
  const login=await request('/api/login','POST',{email:'admin@example.com',password:'A-long-test-password'});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);
  const {csrf}=await login.json();
  const state=emptyState();state.invoices.push({id:'NETLIFY-1',customer:'Shared Buyer',date:'2026-11-02',amount:150});
  assert.equal((await request('/api/state','PUT',{revision:0,state},cookie.split(';')[0],csrf)).status,200);
  const shared=await(await request('/api/state','GET',undefined,cookie.split(';')[0])).json();
  assert.equal(shared.state.invoices[0].id,'NETLIFY-1');
  assert.equal((await request('/api/state','PUT',{revision:1,state},cookie.split(';')[0],'wrong')).status,403);
  assert.equal((await request('/server.js')).status,404);
});

test('Netlify application initialization is shared across requests and retries failures',async t=>{
  const db=await openDatabase({url:'',filename:':memory:'});t.after(()=>db.close());
  let starts=0;
  const handle=createNetlifyHandler(async options=>{starts++;return createApplication({...options,db,skipBootstrap:true});});
  const responses=await Promise.all([handle(new Request(origin+'/health'),context),handle(new Request(origin+'/health'),context)]);
  assert.equal(starts,1);assert.deepEqual(responses.map(response=>response.status),[200,200]);
  let attempt=0;
  const retry=createNetlifyHandler(async options=>{if(attempt++===0)throw new Error('Unavailable test database');return createApplication({...options,db,skipBootstrap:true});});
  assert.equal((await retry(new Request(origin+'/health'),context)).status,503);
  assert.equal((await retry(new Request(origin+'/health'),context)).status,200);
});

test('private-schema SQL qualifies relations while preserving columns and parameters',()=>{
  assert.equal(qualifySql('SELECT * FROM app_users u JOIN app_sessions s ON s.user_id=u.id WHERE email=$1','reconcileiq'),'SELECT * FROM reconcileiq.app_users u JOIN reconcileiq.app_sessions s ON s.user_id=u.id WHERE email=$1');
  assert.equal(qualifySql('INSERT INTO login_attempts(key,count) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET count=login_attempts.count+1','reconcileiq'),'INSERT INTO reconcileiq.login_attempts(key,count) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET count=login_attempts.count+1');
  assert.throws(()=>qualifySql('SELECT * FROM app_users','bad;schema'));
});

test('Supabase TLS trusts the provider CA and keeps certificate verification enabled',()=>{
  const {X509Certificate}=require('node:crypto');
  const config=postgresConnectionOptions('postgres://user:test@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require',{DATABASE_SSL:'true'});
  assert.equal(config.ssl.rejectUnauthorized,true);
  assert.ok(!new URL(config.connectionString).searchParams.has('sslmode'));
  const certificate=new X509Certificate(config.ssl.ca);
  assert.match(certificate.subject,/Supabase Root 2021 CA/);
  assert.equal(certificate.ca,true);
  const generic=postgresConnectionOptions('postgres://user:test@db.example.com/postgres',{DATABASE_SSL:'true'});
  assert.equal(generic.ssl.ca,undefined);
  assert.equal(generic.ssl.rejectUnauthorized,true);
});

test('Netlify adapter preserves compressed JSON requests and binary gzip responses for large workspaces',async t=>{
  const {gzipSync,gunzipSync}=require('node:zlib');const db=await openDatabase({url:'',filename:':memory:'});t.after(()=>db.close());
  await createUser(db,{email:'gzip@example.com',name:'Gzip Admin',password:'A-long-test-password',role:'admin',mustChange:false});
  const handle=createNetlifyHandler(options=>createApplication({...options,db,skipBootstrap:true}));
  const login=await handle(new Request(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'gzip@example.com',password:'A-long-test-password'})}),context);
  const {csrf}=await login.json();const cookie=login.headers.get('set-cookie').split(';')[0];
  const state=emptyState();state.invoices=Array.from({length:10001},(_,i)=>({id:`GZIP-${i}`,customer:'Gzip Buyer',date:'2026-11-03',amount:100}));
  const result=await handle(new Request(origin+'/api/state',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify({__reconcileiqGzip:gzipSync(JSON.stringify({revision:0,state})).toString('base64')})}),context);
  assert.equal(result.status,200);assert.equal(result.headers.get('content-encoding'),'gzip');const decoded=JSON.parse(gunzipSync(Buffer.from(await result.arrayBuffer())).toString('utf8'));assert.equal(decoded.state.invoices.length,10001);
});
