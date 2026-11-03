const {randomBytes,randomUUID}=require('node:crypto');
const {digest,hashPassword}=require('./auth');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const invalidLink=()=>fail(400,'This reset link is invalid or has expired. Ask an administrator for a new link.');
const requestMessage='If this email belongs to an active account, a reset request is now available to your workspace administrators. Ask an administrator to share a reset link with you.';
async function revokePasswordResets(query,userId,clearRequest=true){
  await query('DELETE FROM password_reset_tokens WHERE user_id=$1',[userId]);
  if(clearRequest)await query('DELETE FROM password_reset_requests WHERE user_id=$1',[userId]);
}
function createPasswordReset({db,audit}){
  const lock=query=>query('SELECT id FROM workspace WHERE id=1'+(db.kind==='postgres'?' FOR UPDATE':''));
  async function allow(key,limit){
    const now=new Date().toISOString(),cutoff=new Date(Date.now()-15*60*1000).toISOString();
    const [attempt]=await db.query('INSERT INTO login_attempts(key,count,window_start) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_attempts.window_start < $3 THEN 1 ELSE login_attempts.count+1 END, window_start=CASE WHEN login_attempts.window_start < $4 THEN $5 ELSE login_attempts.window_start END RETURNING count',[key,now,cutoff,cutoff,now]);
    return attempt.count<=limit;
  }
  async function request(email,ip){
    email=String(email || '').trim().toLowerCase().slice(0,254);
    if(!await allow('reset-request-ip:'+digest(ip),30))return {message:requestMessage};
    if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))return {message:requestMessage};
    if(!await allow('reset-request-email:'+digest(email),3))return {message:requestMessage};
    const now=new Date().toISOString();
    await db.query('DELETE FROM password_reset_tokens WHERE expires_at < $1',[now]);
    await db.query('INSERT INTO password_reset_requests(id,user_id,requested_at) SELECT $1,id,$2 FROM app_users WHERE email=$3 AND active=1 ON CONFLICT(user_id) DO UPDATE SET requested_at=excluded.requested_at',[randomUUID(),now,email]);
    return {message:requestMessage};
  }
  async function requests(){
    return {requests:await db.query('SELECT r.id,r.user_id AS user_id,r.requested_at,u.name,u.email FROM password_reset_requests r JOIN app_users u ON u.id=r.user_id WHERE u.active=1 ORDER BY r.requested_at DESC')};
  }
  async function activeAdmin(query,actor){const [current]=await query('SELECT u.role,u.active,u.must_change FROM app_users u JOIN app_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at > $3',[actor.id,actor.token_hash,new Date().toISOString()]);if(!current?.active||current.role!=='admin'||current.must_change)fail(403,'Administrator access is required. Sign in again.');}
  async function target(query,actor,id){
    if(id===actor.id)fail(400,'Use Change password for your account. Another administrator can reset it if you forgot the current password.');
    await activeAdmin(query,actor);const [user]=await query('SELECT * FROM app_users WHERE id=$1 AND active=1',[id]);if(!user)fail(404,'Active account not found.');return user;
  }
  async function issue(actor,id,origin){
    const token=randomBytes(32).toString('base64url'),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+30*60*1000).toISOString();
    await db.transaction(async query=>{
      await lock(query);const user=await target(query,actor,id);await revokePasswordResets(query,user.id);
      await query('INSERT INTO password_reset_tokens(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',[digest(token),user.id,createdAt,expiresAt]);
      await audit(query,actor,'password.reset_link_created',{userId:user.id,expiresAt});
    });
    return {url:new URL('/#reset='+token,origin).href,expiresAt};
  }
  async function temporary(actor,id,password){
    const hash=await hashPassword(password);
    await db.transaction(async query=>{
      await lock(query);const user=await target(query,actor,id);
      await query('UPDATE app_users SET password_hash=$1,must_change=1 WHERE id=$2',[hash,user.id]);
      await query('DELETE FROM app_sessions WHERE user_id=$1',[user.id]);await revokePasswordResets(query,user.id);
      await audit(query,actor,'password.reset_by_admin',{userId:user.id});
    });return {ok:true};
  }
  async function complete(token,password,ip){
    if(!await allow('reset-complete-ip:'+digest(ip),30))fail(429,'Too many reset attempts. Try again in 15 minutes.');
    if(typeof token!=='string'||!/^[-_a-zA-Z0-9]{43}$/.test(token))invalidLink();
    const params=[digest(token),new Date().toISOString()];
    const find=query=>query('SELECT u.* FROM password_reset_tokens t JOIN app_users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.expires_at > $2 AND u.active=1',params);
    if(!(await find(db.query)).length)invalidLink();const hash=await hashPassword(password);
    await db.transaction(async query=>{
      await lock(query);params[1]=new Date().toISOString();const [user]=await find(query);if(!user)invalidLink();
      await query('UPDATE app_users SET password_hash=$1,must_change=0 WHERE id=$2',[hash,user.id]);
      await query('DELETE FROM app_sessions WHERE user_id=$1',[user.id]);await revokePasswordResets(query,user.id);
      await audit(query,user,'password.reset',{method:'administrator_link'});
    });return {ok:true};
  }
  return {request,requests,issue,temporary,complete};
}
module.exports={createPasswordReset,revokePasswordResets};
