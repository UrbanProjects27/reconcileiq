const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { openDatabase } = require('./lib/database');
const { emptyState, validateState, validateBankCustomers, validateAdviceFields, validateReturnFields } = require('./lib/state');
const { digest, publicUser, hashPassword, verifyPassword, createUser } = require('./lib/auth');
const { createOneDrive, callbackPath } = require('./lib/onedrive');
const {definitions:importDefinitions,prepareImport} = require('./lib/import');
const {createBulkImport}=require('./lib/bulk-import');
const {createPasswordReset,revokePasswordResets}=require('./lib/password-reset');
const {encodeState,decodeState,maxStateBytes}=require('./lib/state-codec');
const {requireAdminForRemovals,deleteRecord}=require('./lib/records');
const {gzipSync,gunzipSync}=require('node:zlib');

const staticFiles = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','application/javascript; charset=utf-8']],
  ['/auth.js', ['auth.js','application/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css','text/css; charset=utf-8']],
  ['/overrides.css', ['overrides.css','text/css; charset=utf-8']],
]);
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const json = (response, status, body) => { const text=JSON.stringify(body);const compressed=Buffer.byteLength(text)>64*1024;response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8',...(compressed?{'Content-Encoding':'gzip','Vary':'Accept-Encoding'}:{}) }); response.end(compressed?gzipSync(text):text); };
async function body(request,expandedLimit=4*1024*1024) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) fail(413, 'Request exceeds 4 MB.');
    chunks.push(chunk);
  }
  try {
    let data=Buffer.concat(chunks);if(request.headers['content-encoding'] && !['gzip','identity'].includes(request.headers['content-encoding']))fail(415,'Unsupported request encoding.');
    if(data[0]===0x1f && data[1]===0x8b)data=gunzipSync(data,{maxOutputLength:expandedLimit});
    if(data.length>expandedLimit)fail(413,'Expanded request exceeds the data limit.');let value=JSON.parse(data.toString('utf8'));
    if(value && typeof value.__reconcileiqGzip==='string' && Object.keys(value).length===1){
      if(!/^[a-zA-Z0-9+/]*={0,2}$/.test(value.__reconcileiqGzip))fail(400,'Invalid compressed JSON request.');
      value=JSON.parse(gunzipSync(Buffer.from(value.__reconcileiqGzip,'base64'),{maxOutputLength:expandedLimit}).toString('utf8'));
    }
    if(!value || typeof value!=='object' || Array.isArray(value))fail(400,'JSON object required.');return value;
  }
  catch (error) { if(error.status)throw error;if(error.code==='ERR_BUFFER_TOO_LARGE')fail(413,'Expanded request exceeds the data limit.');fail(400, 'Invalid JSON request.'); }
}
const readWorkspace = async db => {
  const [row] = await db.query('SELECT revision,data FROM workspace WHERE id=1');
  return { revision: row.revision, state: decodeState(row.data) };
};
async function audit(query, user, action, detail) {
  await query('INSERT INTO audit_events(id,actor_id,actor_name,action,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(),user.id,user.name,action,JSON.stringify(detail),new Date().toISOString()]);
}
function changeSummary(before, after) {
  const summary = {};
  for (const key of Object.keys(emptyState())) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) summary[key] = { before: before[key].length, after: after[key].length };
  }
  return summary;
}
async function createApplication(options = {}) {
  const db = options.db || await openDatabase();
  const production = options.production === undefined ? process.env.NODE_ENV === 'production' : options.production;
  const configuredOrigin = options.origin || process.env.APP_ORIGIN || process.env.URL;
  if (production && !configuredOrigin) throw new Error('APP_ORIGIN is required for production.');
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  const onedrive = createOneDrive({db,audit,...options.onedrive});
  const bulk=createBulkImport({db,onedrive,...options.bulk});
  const passwordReset=createPasswordReset({db,audit});
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !options.skipBootstrap) {
    const [count] = await db.query('SELECT COUNT(*) AS count FROM app_users');
    if (Number(count.count) === 0) await createUser(db, {email:process.env.ADMIN_EMAIL,name:process.env.ADMIN_NAME || 'Workspace Admin',password:process.env.ADMIN_PASSWORD,role:'admin',mustChange:true});
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Referrer-Policy','same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (production) response.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = url.pathname; const method = request.method;
      if (route === '/health' && method === 'GET') { await db.query('SELECT 1'); return json(response,200,{ok:true}); }
      if (!route.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(method)) fail(405,'Method not allowed.');
        const file = staticFiles.get(route);
        if (!file) fail(404,'Not found.');
        const contents = await fs.readFile(path.join(__dirname,file[0]));
        response.writeHead(200,{'Content-Type':file[1]}); return response.end(method === 'HEAD' ? undefined : contents);
      }
      if (!['GET','HEAD'].includes(method)) {
        const origin = configuredOrigin || `http://${request.headers.host}`;
        if (request.headers.origin !== new URL(origin).origin) fail(403,'Request origin is not allowed.');
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) fail(415,'Use application/json.');
      }
      if (route === callbackPath && method === 'GET') {
        const binding = String(request.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('riq_onedrive='))?.slice('riq_onedrive='.length) || '';
        response.setHeader('Set-Cookie',`riq_onedrive=; HttpOnly; SameSite=Lax; Path=${callbackPath}; Max-Age=0${production?'; Secure':''}`);
        try {
          await onedrive.callback(url.searchParams,binding);
          response.writeHead(303,{Location:'/?onedrive=connected'}); return response.end();
        } catch (error) {
          const message = error.status ? error.message : 'OneDrive connection failed. Start again from Settings.';
          response.writeHead(303,{Location:'/?onedrive=error&message='+encodeURIComponent(message)}); return response.end();
        }
      }
      if(route==='/api/password-reset/request' && method==='POST'){
        const input=await body(request);return json(response,202,await passwordReset.request(input.email,request.socket.remoteAddress || 'unknown'));
      }
      if(route==='/api/password-reset/complete' && method==='POST'){
        const input=await body(request);const result=await passwordReset.complete(input.token,input.password,request.socket.remoteAddress || 'unknown');
        response.setHeader('Set-Cookie',`riq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production?'; Secure':''}`);return json(response,200,result);
      }
      if (route === '/api/login' && method === 'POST') {
        const input = await body(request);
        const email = String(input.email || '').trim().toLowerCase().slice(0,254);
        const now = new Date(); const cutoff = new Date(now.getTime()-15*60*1000).toISOString();
        const keys = [[`email:${digest(email)}`,10],[`ip:${digest(request.socket.remoteAddress || '')}`,100]];
        for (const [key,limit] of keys) {
          const [attempt] = await db.query('INSERT INTO login_attempts(key,count,window_start) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_attempts.window_start < $3 THEN 1 ELSE login_attempts.count+1 END, window_start=CASE WHEN login_attempts.window_start < $4 THEN $5 ELSE login_attempts.window_start END RETURNING count', [key,now.toISOString(),cutoff,cutoff,now.toISOString()]);
          if (attempt.count > limit) fail(429,'Too many sign-in attempts. Try again in 15 minutes.');
        }
        await db.query('DELETE FROM login_attempts WHERE window_start < $1',[new Date(now.getTime()-24*60*60*1000).toISOString()]);
        const [user] = await db.query('SELECT * FROM app_users WHERE email=$1',[email]);
        const valid = await verifyPassword(input.password,user ? user.password_hash : dummyHash);
        if (!user || !user.active || !valid) fail(401,'Email or password is incorrect.');
        const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
        await db.query('DELETE FROM app_sessions WHERE expires_at < $1',[now.toISOString()]);
        await db.query('INSERT INTO app_sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)',[digest(token),user.id,csrf,new Date(now.getTime()+8*60*60*1000).toISOString()]);
        await audit(db.query,user,'login',{});
        response.setHeader('Set-Cookie',`riq_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production?'; Secure':''}`);
        return json(response,200,{user:publicUser(user),csrf});
      }
      const cookie = String(request.headers.cookie || '').split(';').map(value=>value.trim()).find(value=>value.startsWith('riq_session='));
      const token = cookie ? cookie.slice('riq_session='.length) : '';
      const [session] = await db.query('SELECT s.csrf,s.token_hash,u.* FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > $2 AND u.active=1',[digest(token),new Date().toISOString()]);
      if (!session) fail(401,'Please sign in.');
      if (!['GET','HEAD'].includes(method) && request.headers['x-csrf-token'] !== session.csrf) fail(403,'Session verification failed. Reload and try again.');
      if (route === '/api/session' && method === 'GET') return json(response,200,{user:publicUser(session),csrf:session.csrf});
      if (route === '/api/logout' && method === 'POST') {
        await db.query('DELETE FROM app_sessions WHERE token_hash=$1',[session.token_hash]);
        response.setHeader('Set-Cookie',`riq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production?'; Secure':''}`);
        return json(response,200,{ok:true});
      }
      if (route === '/api/password' && method === 'POST') {
        const input = await body(request);
        if (!await verifyPassword(input.currentPassword,session.password_hash)) fail(400,'Current password is incorrect.');
        const hash = await hashPassword(input.password);
        await db.transaction(async query=>{
          await query('SELECT id FROM workspace WHERE id=1'+(db.kind==='postgres'?' FOR UPDATE':''));
          const [current]=await query('SELECT u.password_hash,u.active FROM app_users u JOIN app_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at > $3',[session.id,session.token_hash,new Date().toISOString()]);
          if(!current?.active || current.password_hash!==session.password_hash)fail(409,'Your password changed. Sign in again before continuing.');
          await query('UPDATE app_users SET password_hash=$1,must_change=0 WHERE id=$2',[hash,session.id]);
          await query('DELETE FROM app_sessions WHERE user_id=$1',[session.id]);
          await revokePasswordResets(query,session.id);
          await audit(query,session,'password.changed',{});
        });
        return json(response,200,{ok:true});
      }
      if (session.must_change) fail(403,'Change your temporary password before continuing.');
      const admin = () => { if (session.role !== 'admin') fail(403,'Administrator access required.'); };
      if(route==='/api/password-reset/requests' && method==='GET'){admin();return json(response,200,await passwordReset.requests());}
      const resetAction=route.match(/^\/api\/users\/([^/]+)\/(reset-link|reset-password)$/);
      if(resetAction && method==='POST'){
        admin();const input=await body(request);const origin=new URL(configuredOrigin || `http://${request.headers.host}`).origin;
        return json(response,200,resetAction[2]==='reset-link'?await passwordReset.issue(session,resetAction[1],origin):await passwordReset.temporary(session,resetAction[1],input.password));
      }
      if(route==='/api/import-jobs'){
        admin();if(method==='GET')return json(response,200,await bulk.list(session));
        if(method==='POST'){const input=await body(request);const origin=new URL(configuredOrigin || `http://${request.headers.host}`).origin;return json(response,202,await bulk.start(session,input.fileId,origin));}
      }
      if(/^\/api\/import-jobs\/[a-f0-9-]{36}$/i.test(route)){
        admin();const id=route.split('/').pop();if(method==='GET')return json(response,200,await bulk.get(session,id));if(method==='DELETE')return json(response,200,await bulk.cancel(session,id));
      }
      if (route.startsWith('/api/onedrive/')) {
        admin();
        if (route === '/api/onedrive/status' && method === 'GET') return json(response,200,await onedrive.status());
        if (route === '/api/onedrive/connect' && method === 'POST') {
          const origin = new URL(configuredOrigin || `http://${request.headers.host}`).origin;
          const {url:authorizeUrl,binding} = await onedrive.start(session,origin);
          response.setHeader('Set-Cookie',`riq_onedrive=${binding}; HttpOnly; SameSite=Lax; Path=${callbackPath}; Max-Age=600${production?'; Secure':''}`);
          return json(response,200,{url:authorizeUrl});
        }
        if (route === '/api/onedrive/disconnect' && method === 'POST') { await onedrive.disconnect(session); return json(response,200,{ok:true}); }
        if (route === '/api/onedrive/files' && method === 'GET') return json(response,200,await onedrive.files(url.searchParams.get('folder') || 'root',url.searchParams.get('page') || ''));
        if (route === '/api/onedrive/workbook' && method === 'GET') return json(response,200,await onedrive.workbook(url.searchParams.get('id') || ''));
        fail(404,'Not found.');
      }
      if (route === '/api/state' && method === 'GET') return json(response,200,await readWorkspace(db));
      if (route === '/api/import/definitions' && method === 'GET') {admin();return json(response,200,{definitions:importDefinitions});}
      if (route === '/api/import/preview' && method === 'POST') {
        admin();const input=await bulk.project(session,await body(request));const current=await readWorkspace(db);const {state:unused,...preview}=prepareImport(input,current.state);
        if(unused)encodeState(unused);
        return json(response,200,{...preview,revision:current.revision});
      }
      if ((route === '/api/state' && method === 'PUT') || (route === '/api/restore' && method === 'POST') || (route === '/api/import' && method === 'POST') || (route==='/api/records/delete' && method==='POST')) {
        if (session.role === 'viewer') fail(403,'Viewers cannot change workspace data.');
        if (route === '/api/restore') admin();
        if (route === '/api/import') admin();
        if (route === '/api/records/delete') admin();
        let input = await body(request,route==='/api/import'?4*1024*1024:maxStateBytes);
        if(route==='/api/import')input=await bulk.project(session,input);
        if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision>2147483647) fail(400,'A valid workspace revision is required.');
        let next = ['/api/import','/api/records/delete'].includes(route) ? null : validateState(input.state);
        const result = await db.transaction(async query=>{
          const [previous] = await query('SELECT revision,data FROM workspace WHERE id=1' + (db.kind === 'postgres' ? ' FOR UPDATE' : ''));
          const [actor]=await query('SELECT u.role,u.active,u.must_change FROM app_users u JOIN app_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at > $3',[session.id,session.token_hash,new Date().toISOString()]);
          const allowed=route==='/api/state'?['admin','editor']:['admin'];
          if(!actor?.active || actor.must_change || !allowed.includes(actor.role))fail(403,'Your access changed. Sign in again before saving.');
          if(previous.revision!==input.revision)fail(409,'Another user saved changes. Review the latest data and save again.');
          let imported,deleted;const before=decodeState(previous.data);
          if(route==='/api/records/delete'){const result=deleteRecord(before,input);next=result.state;deleted=result.deleted;}
          if(route === '/api/import'){
            if(previous.revision!==input.revision)fail(409,'The workspace changed. Review a fresh import preview before saving.');
            imported=prepareImport(input,decodeState(previous.data));
            if(!imported.canImport)fail(400,imported.errors[0]?.message || 'There are no new or changed records to import.');
            next=imported.state;
          }
          // Historical backups may predate newly required fields. Their schema
          // is still validated; new-record rules apply to regular writes/imports.
          requireAdminForRemovals(before,next,actor.role);
          if(!['/api/restore','/api/records/delete'].includes(route)){
            validateBankCustomers(next,before);validateAdviceFields(next,before);validateReturnFields(next,before);
          }
          const encoded=encodeState(next);
          const updated = await query('UPDATE workspace SET data=$1,revision=revision+1 WHERE id=1 AND revision=$2 RETURNING revision',[encoded,input.revision]);
          if (!updated.length) fail(409,'Another user saved changes. Your input is still open; review the latest data and save again.');
          const revision = updated[0].revision;
          await query('INSERT INTO workspace_snapshots(revision,data,created_at) VALUES($1,$2,$3) ON CONFLICT(revision) DO NOTHING',[previous.revision,previous.data,new Date().toISOString()]);
          await query('DELETE FROM workspace_snapshots WHERE revision < $1',[revision-(encoded.startsWith('gzip:')?20:100)]);
          if(imported)await bulk.imported(query,session,input.jobId);
          await audit(query,session,deleted?'record.deleted':route === '/api/import'?'workspace.imported':route === '/api/restore' ? 'workspace.restored' : 'workspace.saved',{revision,changes:changeSummary(before,next),...(imported?{type:input.type,counts:imported.counts}:{}),...(deleted?{deleted}:{})});
          return {revision,state:next,...(deleted?{deleted}:{})};
        });
        return json(response,200,result);
      }
      if (route === '/api/users' && method === 'GET') { admin(); return json(response,200,{users:(await db.query('SELECT * FROM app_users ORDER BY created_at')).map(publicUser)}); }
      if (route === '/api/users' && method === 'POST') {
        admin(); const input = await body(request);
        const user = await db.transaction(async query=>{
          await query('SELECT id FROM workspace WHERE id=1'+(db.kind==='postgres'?' FOR UPDATE':''));
          const [actor]=await query('SELECT u.role,u.active,u.must_change FROM app_users u JOIN app_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at > $3',[session.id,session.token_hash,new Date().toISOString()]);
          if(!actor?.active || actor.must_change || actor.role!=='admin')fail(403,'Administrator access has changed. Sign in again.');
          const created = await createUser({query},{...input,mustChange:true});
          await audit(query,session,'user.created',{userId:created.id,email:created.email,role:created.role}); return created;
        });
        return json(response,201,{user});
      }
      if (route.startsWith('/api/users/') && method === 'PATCH') {
        admin(); const id = route.slice('/api/users/'.length); const input = await body(request);
        if (id === session.id) fail(400,'Use Change password for your account. Another administrator must change your role or access.');
        const [user] = await db.query('SELECT * FROM app_users WHERE id=$1',[id]);
        if (!user) fail(404,'User not found.');
        const role = input.role === undefined ? user.role : input.role;
        const active = input.active === undefined ? !!user.active : input.active;
        if (!['admin','editor','viewer'].includes(role) || typeof active !== 'boolean') fail(400,'Invalid role or access.');
        const hash = input.password === undefined ? null : await hashPassword(input.password);
        await db.transaction(async query=>{
          // Serialize admin access changes so two admins cannot concurrently
          // disable each other and leave the workspace without an administrator.
          await query('SELECT id FROM workspace WHERE id=1' + (db.kind === 'postgres' ? ' FOR UPDATE' : ''));
          const [actor] = await query('SELECT u.active,u.role,u.must_change FROM app_users u JOIN app_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at > $3',[session.id,session.token_hash,new Date().toISOString()]);
          if (!actor?.active || actor.role !== 'admin' || actor.must_change) fail(403,'Administrator access has changed. Sign in again.');
          const [target] = await query('SELECT * FROM app_users WHERE id=$1',[id]);
          const nextRole=input.role===undefined?target.role:role,nextActive=input.active===undefined?!!target.active:active;
          const [admins] = await query("SELECT COUNT(*) AS count FROM app_users WHERE role='admin' AND active=1");
          if (target.active && target.role === 'admin' && (!nextActive || nextRole !== 'admin') && Number(admins.count) <= 1) fail(409,'At least one active administrator is required.');
          await query('UPDATE app_users SET role=$1,active=$2,password_hash=$3,must_change=$4 WHERE id=$5',[nextRole,nextActive?1:0,hash || target.password_hash,hash ? 1 : target.must_change,id]);
          await query('DELETE FROM app_sessions WHERE user_id=$1',[id]);
          await revokePasswordResets(query,id,!!hash || !nextActive);
          await audit(query,session,'user.updated',{userId:id,role:nextRole,active:nextActive,passwordReset:!!hash});
        });
        return json(response,200,{ok:true});
      }
      if (route === '/api/audit' && method === 'GET') {
        admin(); const events = await db.query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200');
        return json(response,200,{events:events.map(event=>({...event,detail:JSON.parse(event.detail)}))});
      }
      if (route === '/api/backup' && method === 'GET') {
        admin(); const snapshot = await db.transaction(async query=>{
          const [row] = await query('SELECT revision,data FROM workspace WHERE id=1');
          const events = await query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 1000');
          await audit(query,session,'backup.downloaded',{revision:row.revision});
          return {format:'reconcileiq-backup-v1',createdAt:new Date().toISOString(),revision:row.revision,state:decodeState(row.data),audit:events};
        });
        response.setHeader('Content-Disposition','attachment; filename="reconcileiq-backup.json"');
        return json(response,200,snapshot);
      }
      if (route === '/api/snapshots' && method === 'GET') { admin(); return json(response,200,{snapshots:await db.query('SELECT revision,created_at FROM workspace_snapshots ORDER BY revision DESC LIMIT 100')}); }
      if (/^\/api\/snapshots\/\d+$/.test(route) && method === 'GET') {
        admin();const revision=Number(route.split('/').pop());if(!Number.isSafeInteger(revision) || revision>2147483647)fail(400,'Invalid snapshot revision.');
        const [row] = await db.query('SELECT revision,data FROM workspace_snapshots WHERE revision=$1',[revision]);
        if (!row) fail(404,'Snapshot not found.');
        return json(response,200,{revision:row.revision,state:decodeState(row.data)});
      }
      fail(404,'API endpoint not found.');
    } catch (error) {
      if (response.headersSent) return response.end();
      if (!error.status) console.error('Request failed:',error.message);
      json(response,error.status || 500,{error:error.status ? error.message : 'Server could not complete the request. Please try again.'});
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return {server,db};
}
if (require.main === module) {
  createApplication().then(({server,db})=>{
    const port = Number(process.env.PORT || 4173); const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
    server.listen(port,host,()=>console.log(`ReconcileIQ is running on ${host}:${port}`));
    const stop = () => { server.close(async()=>{await db.close();process.exit(0);}); setTimeout(()=>process.exit(1),10000).unref(); };
    process.on('SIGTERM',stop); process.on('SIGINT',stop);
  }).catch(error=>{console.error('Startup failed:',error.message);process.exit(1);});
}
module.exports = {createApplication};
