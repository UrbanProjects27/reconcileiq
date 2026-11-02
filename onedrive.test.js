const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {openDatabase,postgresSchema,qualifySql,initialize}=require('./lib/database');
const {createUser}=require('./lib/auth');
const {createApplication}=require('./server');
const {configuration,encrypt,decrypt,authorizationFailure}=require('./lib/onedrive');
const tenant='1770cbe0-4866-4e34-97d2-978a89b96e92';
const env={ONEDRIVE_CLIENT_ID:'782d5d1c-6640-42f5-9ac7-ed3634562088',ONEDRIVE_TENANT_ID:tenant,ONEDRIVE_CLIENT_SECRET:'test-secret',ONEDRIVE_TOKEN_KEY:randomBytes(32).toString('hex')};
const account={homeAccountId:'account-id',username:'finance@example.com',tenantId:tenant};
const password='Secure-test-password-2026';
async function fixture(t,engine) {
  let db;
  if(engine==='postgres'){
    const {PGlite}=require('@electric-sql/pglite');const pg=await PGlite.create();await pg.exec(postgresSchema('reconcileiq'));
    db={kind:'postgres',query:async(s,p=[])=> (await pg.query(qualifySql(s,'reconcileiq'),p)).rows,transaction:fn=>pg.transaction(tx=>fn(async(s,p=[])=> (await tx.query(qualifySql(s,'reconcileiq'),p)).rows)),close:()=>pg.close()};await initialize(db);
  }else db=await openDatabase({url:'',filename:':memory:'});
  await createUser(db,{email:'admin@example.com',name:'Admin',password,role:'admin',mustChange:false});
  await createUser(db,{email:'viewer@example.com',name:'Viewer',password,role:'viewer',mustChange:false});
  const observed={codes:[],graph:[],tenant};
  const factory=()=>{
    let cache='refresh-token-sensitive';
    return {getAuthCodeUrl:async p=>'https://login.microsoftonline.com/'+tenant+'/oauth2/v2.0/authorize?'+new URLSearchParams(p),acquireTokenByCode:async p=>{observed.codes.push(p);return {account:{...account,tenantId:observed.tenant}};},getTokenCache:()=>({serialize:()=>cache,deserialize:s=>{cache=s;},getAccountByHomeId:async()=>account}),acquireTokenSilent:async()=>({accessToken:'access-token-sensitive'})};
  };
  const {server}=await createApplication({db,skipBootstrap:true,production:false,onedrive:{env,clientFactory:factory,fetcher:async(url,options)=>{observed.graph.push({url:String(url),options});if(observed.mockFetch)return observed.mockFetch(url,options);return {ok:true,json:async()=>({value:[{id:'folder-1',name:'Finance',folder:{}},{id:'file-1',name:'Invoices.xlsx',webUrl:'https://company.sharepoint.com/invoices.xlsx','@microsoft.graph.downloadUrl':'DO-NOT-EXPOSE'},{id:'file-2',name:'Unexpected',webUrl:'https://evil.example.com/'}],'@odata.nextLink':String(url)+'&$skiptoken=next-page'})};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
  const request=(route,method='GET',session,data)=>fetch(base+route,{method,redirect:'manual',headers:{Origin:base,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
  const login=async(email='admin@example.com')=>{const r=await request('/api/login','POST',null,{email,password});const body=await r.json();return {csrf:body.csrf,cookie:r.headers.get('set-cookie').split(';')[0]};};
  const start=async(session)=>{const r=await request('/api/onedrive/connect','POST',session,{});assert.equal(r.status,200);const {url}=await r.json();return {url:new URL(url),cookie:r.headers.get('set-cookie').split(';')[0]};};
  const callback=(flow,binding=flow.cookie)=>request('/api/onedrive/callback?'+new URLSearchParams({state:flow.url.searchParams.get('state'),code:'test-code'}),'GET',{cookie:binding,csrf:''});
  return {db,base,request,login,start,callback,observed};
}
test('connector configuration and authenticated encryption reject invalid settings and tampering',()=>{
  assert.equal(configuration(env).ready,true);assert.equal(configuration({...env,ONEDRIVE_TENANT_ID:'common'}).ready,false);
  const sealed=encrypt({secret:'refresh-token'},env.ONEDRIVE_TOKEN_KEY);assert.ok(!sealed.includes('refresh-token'));
  assert.deepEqual(decrypt(sealed,env.ONEDRIVE_TOKEN_KEY),{secret:'refresh-token'});
  assert.throws(()=>decrypt(sealed,randomBytes(32).toString('hex')));
  const parts=sealed.split('.');parts[2]=randomBytes(16).toString('base64url');assert.throws(()=>decrypt(parts.join('.'),env.ONEDRIVE_TOKEN_KEY));
});
test('Microsoft authorization failures expose only safe diagnostic identifiers',()=>{
  const failure=authorizationFailure({errorCode:'invalid_client',errorMessage:'AADSTS7000215: bad secret secret-sensitive-value',correlationId:tenant,clientSecret:'secret-sensitive-value',accessToken:'access-sensitive-value'});
  assert.match(failure.message,/client secret Value/);assert.match(failure.message,/AADSTS7000215/);
  assert.deepEqual(failure.diagnostic,{code:'invalid_client',reference:'AADSTS7000215',correlation:tenant});
  assert.ok(!JSON.stringify(failure).includes('sensitive-value'));
  const untrusted=authorizationFailure({errorCode:'bad code <secret>',errorMessage:'secret text',correlationId:'secret text'});
  assert.equal(untrusted.diagnostic.code,'authorization_failed');assert.ok(!JSON.stringify(untrusted).includes('secret text'));
  assert.match(authorizationFailure({code:'MODULE_NOT_FOUND'}).message,/MODULE_NOT_FOUND/);
});
for(const engine of ['sqlite','postgres']){
  test(`OneDrive imports download only from Microsoft and never forward Graph credentials [${engine}]`,async t=>{
    const f=await fixture(t,engine);const admin=await f.login();await f.callback(await f.start(admin));
    let target='https://company.sharepoint.com/download?preauthenticated=value';let size=100;let downloads=0;
    f.observed.mockFetch=(url,options)=>{
      if(String(url).startsWith('https://graph.microsoft.com/'))return Response.json({file:{},name:'invoices.csv',size,'@microsoft.graph.downloadUrl':target});
      downloads++;assert.equal(options.headers,undefined);return new Response('Invoice,Customer,Date,Amount\nINV-1,Acme,2026-11-03,100');
    };
    const workbook=await f.request('/api/onedrive/workbook?id=file-1','GET',admin);assert.equal(workbook.status,200);const parsed=await workbook.json();assert.equal(parsed.sheets[0].rows[1][0],'INV-1');assert.ok(!JSON.stringify(parsed).includes('preauthenticated'));assert.equal(downloads,1);
    target='https://evil.example.com/secret';assert.equal((await f.request('/api/onedrive/workbook?id=file-1','GET',admin)).status,502);assert.equal(downloads,1);
    target='https://company.sharepoint.com/download';size=70*1024*1024;const large=await f.request('/api/onedrive/workbook?id=file-1','GET',admin);assert.equal(large.status,200);assert.equal((await large.json()).large,true);assert.equal(downloads,1);
    size=101*1024*1024;assert.equal((await f.request('/api/onedrive/workbook?id=file-1','GET',admin)).status,400);assert.equal(downloads,1);
    assert.equal((await f.request('/api/onedrive/workbook?id=..%2f..','GET',admin)).status,400);
  });
  test(`OneDrive requires admin, CSRF, one-time browser-bound state and encrypted cache [${engine}]`,async t=>{
    const f=await fixture(t,engine);const admin=await f.login(),viewer=await f.login('viewer@example.com');
    assert.equal((await f.request('/api/onedrive/status')).status,401);
    assert.equal((await f.request('/api/onedrive/status','GET',viewer)).status,403);
    assert.equal((await f.request('/api/onedrive/connect','POST',{...admin,csrf:'wrong'},{})).status,403);
    const flow=await f.start(admin);assert.equal(flow.url.searchParams.get('codeChallengeMethod'),'S256');
    const bad=await f.callback(flow,'riq_onedrive=wrong');assert.match(bad.headers.get('location'),/onedrive=error/);assert.equal(f.observed.codes.length,0);
    const good=await f.callback(flow);assert.equal(good.status,303);assert.equal(good.headers.get('location'),'/?onedrive=connected');
    assert.match(good.headers.get('set-cookie'),/Max-Age=0/);assert.ok(f.observed.codes[0].codeVerifier);
    const [stored]=await f.db.query('SELECT data FROM onedrive_connections WHERE id=1');assert.ok(!stored.data.includes('refresh-token-sensitive'));
    const replay=await f.callback(flow);assert.match(replay.headers.get('location'),/onedrive=error/);assert.equal(f.observed.codes.length,1);
    const status=await(await f.request('/api/onedrive/status','GET',admin)).json();assert.equal(status.connected,true);assert.equal(status.account,account.username);assert.ok(!JSON.stringify(status).includes('token'));
    const files=await(await f.request('/api/onedrive/files?folder=root','GET',admin)).json();assert.equal(files.items[0].folder,true);assert.equal(files.items[2].webUrl,'');assert.equal(files.nextPage,'next-page');assert.ok(!JSON.stringify(files).includes('DO-NOT-EXPOSE'));
    assert.equal(f.observed.graph[0].options.headers.Authorization,'Bearer access-token-sensitive');
    assert.equal((await f.request('/api/onedrive/files?folder=..%2F..','GET',admin)).status,400);
    assert.equal((await f.request('/api/onedrive/files','GET',viewer)).status,403);
    const pending=await f.start(admin);await f.request('/api/onedrive/disconnect','POST',admin,{});
    assert.match((await f.callback(pending)).headers.get('location'),/onedrive=error/);
    assert.equal((await(await f.request('/api/onedrive/status','GET',admin)).json()).connected,false);
    assert.equal((await f.request('/api/onedrive/files','GET',admin)).status,409);
  });
  test(`OneDrive rejects expired state, wrong tenant and revoked administrator session [${engine}]`,async t=>{
    const f=await fixture(t,engine);const admin=await f.login();const expired=await f.start(admin);
    await f.db.query('UPDATE onedrive_oauth SET expires_at=$1',['2000-01-01T00:00:00.000Z']);
    assert.match((await f.callback(expired)).headers.get('location'),/onedrive=error/);assert.equal(f.observed.codes.length,0);
    const wrongTenant=await f.start(admin);f.observed.tenant='00000000-0000-0000-0000-000000000000';
    assert.match((await f.callback(wrongTenant)).headers.get('location'),/onedrive=error/);
    assert.equal((await(await f.request('/api/onedrive/status','GET',admin)).json()).connected,false);
    const loggedOut=await f.start(admin);await f.request('/api/logout','POST',admin,{});
    assert.match((await f.callback(loggedOut)).headers.get('location'),/onedrive=error/);assert.equal(f.observed.codes.length,1);
  });
}
