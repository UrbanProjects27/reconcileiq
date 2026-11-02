const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { openDatabase } = require('./lib/database');
const { emptyState, validateState } = require('./lib/state');
const { digest, publicUser, hashPassword, verifyPassword, createUser } = require('./lib/auth');

const staticFiles = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','application/javascript; charset=utf-8']],
  ['/auth.js', ['auth.js','application/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css','text/css; charset=utf-8']],
  ['/overrides.css', ['overrides.css','text/css; charset=utf-8']],
]);
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
async function body(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) fail(413, 'Request exceeds 8 MB.');
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'JSON object required.'); return value; }
  catch { fail(400, 'Invalid JSON request.'); }
}
const readWorkspace = async db => {
  const [row] = await db.query('SELECT revision,data FROM workspace WHERE id=1');
  return { revision: row.revision, state: JSON.parse(row.data) };
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
  const configuredOrigin = options.origin || process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  if (production && !configuredOrigin) throw new Error('APP_ORIGIN is required for production.');
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
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
          await query('UPDATE app_users SET password_hash=$1,must_change=0 WHERE id=$2',[hash,session.id]);
          await query('DELETE FROM app_sessions WHERE user_id=$1',[session.id]);
          await audit(query,session,'password.changed',{});
        });
        return json(response,200,{ok:true});
      }
      if (session.must_change) fail(403,'Change your temporary password before continuing.');
      const admin = () => { if (session.role !== 'admin') fail(403,'Administrator access required.'); };
      if (route === '/api/state' && method === 'GET') return json(response,200,await readWorkspace(db));
      if ((route === '/api/state' && method === 'PUT') || (route === '/api/restore' && method === 'POST')) {
        if (session.role === 'viewer') fail(403,'Viewers cannot change workspace data.');
        if (route === '/api/restore') admin();
        const input = await body(request);
        if (!Number.isInteger(input.revision) || input.revision < 0) fail(400,'A workspace revision is required.');
        const next = validateState(input.state); const serialized = JSON.stringify(next);
        const result = await db.transaction(async query=>{
          const [previous] = await query('SELECT revision,data FROM workspace WHERE id=1' + (db.kind === 'postgres' ? ' FOR UPDATE' : ''));
          const updated = await query('UPDATE workspace SET data=$1,revision=revision+1 WHERE id=1 AND revision=$2 RETURNING revision',[serialized,input.revision]);
          if (!updated.length) fail(409,'Another user saved changes. Your input is still open; review the latest data and save again.');
          const revision = updated[0].revision;
          await query('INSERT INTO workspace_snapshots(revision,data,created_at) VALUES($1,$2,$3) ON CONFLICT(revision) DO NOTHING',[previous.revision,previous.data,new Date().toISOString()]);
          await query('DELETE FROM workspace_snapshots WHERE revision < $1',[revision-100]);
          await audit(query,session,route === '/api/restore' ? 'workspace.restored' : 'workspace.saved',{revision,changes:changeSummary(JSON.parse(previous.data),next)});
          return {revision,state:next};
        });
        return json(response,200,result);
      }
      if (route === '/api/users' && method === 'GET') { admin(); return json(response,200,{users:(await db.query('SELECT * FROM app_users ORDER BY created_at')).map(publicUser)}); }
      if (route === '/api/users' && method === 'POST') {
        admin(); const input = await body(request);
        const user = await db.transaction(async query=>{
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
          const [actor] = await query('SELECT active,role FROM app_users WHERE id=$1',[session.id]);
          if (!actor.active || actor.role !== 'admin') fail(403,'Administrator access has changed. Sign in again.');
          const [target] = await query('SELECT active,role FROM app_users WHERE id=$1',[id]);
          const [admins] = await query("SELECT COUNT(*) AS count FROM app_users WHERE role='admin' AND active=1");
          if (target.active && target.role === 'admin' && (!active || role !== 'admin') && Number(admins.count) <= 1) fail(409,'At least one active administrator is required.');
          await query('UPDATE app_users SET role=$1,active=$2,password_hash=$3,must_change=$4 WHERE id=$5',[role,active?1:0,hash || user.password_hash,hash ? 1 : user.must_change,id]);
          await query('DELETE FROM app_sessions WHERE user_id=$1',[id]);
          await audit(query,session,'user.updated',{userId:id,role,active,passwordReset:!!hash});
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
          return {format:'reconcileiq-backup-v1',createdAt:new Date().toISOString(),revision:row.revision,state:JSON.parse(row.data),audit:events};
        });
        response.setHeader('Content-Disposition','attachment; filename="reconcileiq-backup.json"');
        return json(response,200,snapshot);
      }
      if (route === '/api/snapshots' && method === 'GET') { admin(); return json(response,200,{snapshots:await db.query('SELECT revision,created_at FROM workspace_snapshots ORDER BY revision DESC LIMIT 100')}); }
      if (/^\/api\/snapshots\/\d+$/.test(route) && method === 'GET') {
        admin(); const [row] = await db.query('SELECT revision,data FROM workspace_snapshots WHERE revision=$1',[Number(route.split('/').pop())]);
        if (!row) fail(404,'Snapshot not found.');
        return json(response,200,{revision:row.revision,state:JSON.parse(row.data)});
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
