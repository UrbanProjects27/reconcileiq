const { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } = require('node:crypto');
const { digest } = require('./auth');
const scopes = ['https://graph.microsoft.com/Files.Read'];
const callbackPath = '/api/onedrive/callback';
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function authorizationFailure(error) {
  // Never log MSAL's raw error/message/response: they may include credentials,
  // claims or tokens. Retain only constrained diagnostic identifiers.
  const candidate = error?.errorCode || error?.code || error?.name || '';
  const code = /^[a-z0-9_]{1,80}$/i.test(candidate) ? candidate : 'authorization_failed';
  const reference = String(error?.errorMessage || '').match(/\bAADSTS\d{4,12}\b/)?.[0] || '';
  const correlation = guid.test(error?.correlationId || '') ? error.correlationId : '';
  const help = {
    invalid_client:'Microsoft rejected the app credentials. Update ONEDRIVE_CLIENT_SECRET in Netlify with the client secret Value from this app registration, then redeploy.',
    invalid_grant:'Microsoft rejected the sign-in code. Start a fresh connection from Settings; if it repeats, check the Web redirect URI and PKCE configuration.',
    invalid_request:'Microsoft rejected the app registration settings. Check that the callback is registered under the Web platform and start a fresh connection.',
    unauthorized_client:'Microsoft has not authorized this app. Check the client ID, tenant and allowed account types in the registration.',
    interaction_required:'Microsoft requires another sign-in or administrator approval. Start a fresh connection from Settings.',
    consent_required:'Your Microsoft 365 administrator must approve the requested OneDrive permissions before connecting.',
  };
  const detail = reference || code;
  return {diagnostic:{code,reference,correlation},message:(help[code] || 'Microsoft could not complete the connection. Your app administrator can use the support code to check the deployment and registration.')+` Support code: ${detail}.`};
}
function configuration(env = process.env) {
  const missing = ['ONEDRIVE_CLIENT_ID','ONEDRIVE_TENANT_ID','ONEDRIVE_CLIENT_SECRET','ONEDRIVE_TOKEN_KEY'].filter(key => !env[key]);
  const invalid = [];
  for (const key of ['ONEDRIVE_CLIENT_ID','ONEDRIVE_TENANT_ID']) if (env[key] && !guid.test(env[key])) invalid.push(key);
  if (env.ONEDRIVE_TOKEN_KEY && !/^[a-f0-9]{64}$/i.test(env.ONEDRIVE_TOKEN_KEY)) invalid.push('ONEDRIVE_TOKEN_KEY');
  return {ready:!missing.length && !invalid.length, missing, invalid};
}
// Authenticated encryption protects the complete MSAL cache, including refresh tokens.
function encrypt(value, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key,'hex'), iv);
  cipher.setAAD(Buffer.from('reconcileiq-onedrive-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');
}
function decrypt(value, key) {
  const [version,iv,tag,data] = value.split('.');
  if (version !== 'v1') throw new Error('Invalid connector record.');
  const cipher = createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(iv,'base64url'));
  cipher.setAAD(Buffer.from('reconcileiq-onedrive-v1')); cipher.setAuthTag(Buffer.from(tag,'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString('utf8'));
}
function microsoftNetwork() {
  const deadline = Date.now()+20000;
  const send = async (url,method,options={}) => {
    const response = await fetch(url,{method,headers:options.headers,body:options.body,redirect:'error',signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
    return {status:response.status,headers:Object.fromEntries(response.headers),body:await response.json()};
  };
  return {sendGetRequestAsync:(url,options)=>send(url,'GET',options),sendPostRequestAsync:(url,options)=>send(url,'POST',options)};
}
function createOneDrive({db, audit, env = process.env, fetcher = fetch, clientFactory, logger = diagnostic => console.error('OneDrive authorization failed:',JSON.stringify(diagnostic))}) {
  const config = () => configuration(env);
  const requireConfig = () => { if (!config().ready) fail(503,'OneDrive setup is incomplete. Ask your administrator to finish the Microsoft registration and Netlify variables.'); };
  const seal = value => encrypt(value,env.ONEDRIVE_TOKEN_KEY);
  const unseal = value => { try { return decrypt(value,env.ONEDRIVE_TOKEN_KEY); } catch { fail(503,'OneDrive credentials could not be opened. Restore the original token key or disconnect and reconnect.'); } };
  const client = () => {
    requireConfig();
    const options = {auth:{clientId:env.ONEDRIVE_CLIENT_ID,authority:`https://login.microsoftonline.com/${env.ONEDRIVE_TENANT_ID}`,clientSecret:env.ONEDRIVE_CLIENT_SECRET},system:{networkClient:microsoftNetwork(),disableInternalRetries:true,loggerOptions:{piiLoggingEnabled:false,loggerCallback:()=>{}}}};
    return clientFactory ? clientFactory(options) : new (require('@azure/msal-node').ConfidentialClientApplication)(options);
  };
  const ensure = () => db.query('INSERT INTO onedrive_connections(id,generation,data) VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING',[randomUUID(),'']);
  const lock = db.kind === 'postgres' ? ' FOR UPDATE' : '';
  async function status() {
    const settings = config();
    if (!settings.ready) return {...settings,connected:false};
    const [row] = await db.query('SELECT data FROM onedrive_connections WHERE id=1');
    if (!row?.data) return {...settings,connected:false};
    let record;
    try { record = unseal(row.data); }
    catch { return {...settings,connected:false,credentialError:true}; }
    return {...settings,connected:true,account:record.username,connectedAt:record.connectedAt};
  }
  async function start(session, origin) {
    requireConfig(); await ensure();
    const state = randomBytes(32).toString('base64url'); const binding = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const [connection] = await db.query('SELECT generation FROM onedrive_connections WHERE id=1');
    const auth = client();
    const url = await auth.getAuthCodeUrl({scopes,redirectUri:origin+callbackPath,state,responseMode:'query',prompt:'select_account',codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256'});
    await db.query('DELETE FROM onedrive_oauth WHERE expires_at < $1',[new Date().toISOString()]);
    await db.query('INSERT INTO onedrive_oauth(state_hash,data,expires_at) VALUES($1,$2,$3)',[digest(state),seal({binding:digest(binding),verifier,session:session.token_hash,userId:session.id,generation:connection.generation,redirectUri:origin+callbackPath}),new Date(Date.now()+10*60*1000).toISOString()]);
    return {url,binding};
  }
  async function callback(params, binding) {
    requireConfig();
    const state = params.get('state') || '';
    if (!/^[\w-]{43}$/.test(state) || !binding) fail(400,'The OneDrive sign-in has expired. Start again from Settings.');
    // Consume state once. The additional SameSite=Lax cookie binds a cross-site
    // callback to the browser without relaxing the normal Strict app cookie.
    const pending = await db.transaction(async query => {
      const [row] = await query('SELECT data,expires_at FROM onedrive_oauth WHERE state_hash=$1'+lock,[digest(state)]);
      if (!row || row.expires_at < new Date().toISOString()) fail(400,'The OneDrive sign-in has expired. Start again from Settings.');
      const saved = unseal(row.data);
      if (digest(binding) !== saved.binding) fail(400,'OneDrive browser verification failed. Start again from Settings.');
      await query('DELETE FROM onedrive_oauth WHERE state_hash=$1',[digest(state)]);
      return saved;
    });
    if (params.has('error')) fail(400,'Microsoft sign-in was cancelled or permission was denied.');
    const code = params.get('code'); if (!code || code.length > 16000) fail(400,'Microsoft did not return a valid authorization code.');
    const activeAdmin = async query => {
      const [user] = await query('SELECT u.* FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > $2 AND u.active=1 AND u.role=$3 AND u.must_change=0',[pending.session,new Date().toISOString(),'admin']);
      if (!user || user.id !== pending.userId) fail(403,'Your administrator session ended. Sign in and connect OneDrive again.');
      return user;
    };
    await activeAdmin(db.query);
    const auth = client(); let result;
    try { result = await auth.acquireTokenByCode({scopes,code,redirectUri:pending.redirectUri,codeVerifier:pending.verifier}); }
    catch (error) {
      const failure = authorizationFailure(error);
      logger(failure.diagnostic);
      fail(400,failure.message);
    }
    if (!result?.account || result.account.tenantId?.toLowerCase() !== env.ONEDRIVE_TENANT_ID.toLowerCase()) fail(403,'Connect an account from the configured Microsoft 365 tenant.');
    await db.transaction(async query => {
      const [connection] = await query('SELECT generation FROM onedrive_connections WHERE id=1'+lock);
      if (connection.generation !== pending.generation) fail(409,'The connection changed while signing in. Start again from Settings.');
      const user = await activeAdmin(query);
      await query('UPDATE onedrive_connections SET generation=$1,data=$2 WHERE id=1',[randomUUID(),seal({cache:auth.getTokenCache().serialize(),accountId:result.account.homeAccountId,username:result.account.username,connectedAt:new Date().toISOString()})]);
      await audit(query,user,'onedrive.connected',{account:result.account.username});
    });
  }
  async function disconnect(session) {
    await ensure();
    await db.transaction(async query => {
      await query('SELECT generation FROM onedrive_connections WHERE id=1'+lock);
      await query('UPDATE onedrive_connections SET generation=$1,data=$2 WHERE id=1',[randomUUID(),'']);
      await query('DELETE FROM onedrive_oauth');
      await audit(query,session,'onedrive.disconnected',{});
    });
  }
  async function accessToken() {
    requireConfig();
    // Serialize silent refreshes across serverless instances to preserve rotated
    // refresh tokens. Disconnect uses the same row lock.
    return db.transaction(async query => {
      const [row] = await query('SELECT data FROM onedrive_connections WHERE id=1'+lock);
      if (!row?.data) fail(409,'Connect Microsoft OneDrive from Settings first.');
      const record = unseal(row.data); const auth = client();
      auth.getTokenCache().deserialize(record.cache);
      const account = await auth.getTokenCache().getAccountByHomeId(record.accountId);
      if (!account) fail(409,'Reconnect OneDrive from Settings.');
      let result;
      try { result = await auth.acquireTokenSilent({scopes,account}); }
      catch { fail(409,'Microsoft authorization expired or was revoked. Reconnect OneDrive from Settings.'); }
      if (!result?.accessToken) fail(409,'Reconnect OneDrive from Settings.');
      record.cache = auth.getTokenCache().serialize();
      await query('UPDATE onedrive_connections SET data=$1 WHERE id=1',[seal(record)]);
      return result.accessToken;
    });
  }
  async function files(folder = 'root', page = '') {
    if (!/^[a-zA-Z0-9!_.-]{1,250}$/.test(folder) || page.length > 4000) fail(400,'Invalid OneDrive folder or page.');
    const path = folder === 'root' ? '/me/drive/root/children' : `/me/drive/items/${encodeURIComponent(folder)}/children`;
    const url = new URL('https://graph.microsoft.com/v1.0'+path);
    url.searchParams.set('$select','id,name,size,folder,file,webUrl,lastModifiedDateTime'); url.searchParams.set('$top','100');
    if (page) url.searchParams.set('$skiptoken',page);
    const token = await accessToken(); let response;
    try { response = await fetcher(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:'error'}); }
    catch { fail(502,'OneDrive could not be reached. Try again shortly.'); }
    if (!response.ok) {
      if (response.status === 401) fail(409,'Reconnect OneDrive from Settings.');
      if (response.status === 404) fail(404,'This folder is unavailable. Check that your Microsoft 365 account has OneDrive provisioned.');
      if (response.status === 429) fail(429,'Microsoft is limiting requests. Wait a moment and try again.');
      fail(502,'Microsoft could not list this folder. Check access and consent, then try again.');
    }
    const data = await response.json();
    let nextPage = '';
    if (data['@odata.nextLink']) nextPage = new URL(data['@odata.nextLink']).searchParams.get('$skiptoken') || '';
    return {items:(data.value || []).map(item => ({id:item.id,name:item.name,size:item.size,folder:!!item.folder,modified:item.lastModifiedDateTime,webUrl:safeWebUrl(item.webUrl)})),nextPage};
  }
  async function sourceFile(id) {
    if(!/^[a-zA-Z0-9!_.-]{1,250}$/.test(id))fail(400,'Invalid OneDrive file.');
    const token=await accessToken();let response;
    try {response=await fetcher(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000),redirect:'error'});}
    catch {fail(502,'OneDrive could not be reached. Try again.');}
    if(!response.ok)fail(response.status===401?409:502,response.status===401?'Reconnect OneDrive from Settings.':'Microsoft could not read this file. Check its access permissions.');
    const item=await response.json();
    if(!item.file || !/\.(xlsx|csv)$/i.test(item.name || ''))fail(400,'Choose an .xlsx or .csv file.');
    if(item.size>100*1024*1024)fail(400,'The bulk importer supports files up to 100 MB.');
    return item;
  }
  async function download(item,limit,consume,timeout=20000) {
    const signal=AbortSignal.timeout(timeout);let location=item['@microsoft.graph.downloadUrl'];let response;
    try {
      for(let hop=0;hop<4;hop++){
        const target=new URL(location);
        if(target.protocol!=='https:' || target.username || target.password || target.port || !['.sharepoint.com','.1drv.com','.sharepointonline.com'].some(host=>target.hostname.endsWith(host)))fail(502,'Microsoft returned an unsupported file download address.');
        // Preauthenticated Microsoft download URLs never receive our Graph token.
        response=await fetcher(target,{signal,redirect:'manual'});
        if([301,302,303,307,308].includes(response.status)){location=new URL(response.headers.get('location'),target).href;continue;}
        if(!response.ok){
          const candidate=response.headers.get('x-ms-error-code') || '';const providerCode=/^[a-zA-Z0-9_]{1,80}$/.test(candidate)?candidate:'';
          console.error('OneDrive download failed:',JSON.stringify({status:response.status,providerCode}));
          fail(502,`Microsoft could not download this file (HTTP ${response.status}). Try again, or check the file's download permissions.`);
        }
        if(Number(response.headers.get('content-length'))>limit)fail(400,'The source file exceeds this import size limit.');
        let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>limit)fail(400,'The source file exceeds this import size limit.');await consume(chunk,size);}
        return;
      }
      fail(502,'Microsoft returned too many download redirects.');
    }catch(error){if(error.status)throw error;fail(502,'This OneDrive file could not be downloaded. Try again shortly.');}
  }
  async function workbook(id) {
    const item=await sourceFile(id);const {parseWorkbook,maxBytes}=require('./workbook');
    // XLSX can contain many rows, formulas and lookup sheets even when its ZIP
    // is small. Use the same bounded streaming reader for every Excel workbook.
    if(/\.xlsx$/i.test(item.name) || item.size>maxBytes)return {large:true,fileId:id,name:item.name,size:item.size};
    const chunks=[];await download(item,maxBytes,chunk=>chunks.push(Buffer.from(chunk)));
    try{return await parseWorkbook(item.name,Buffer.concat(chunks));}
    catch(error){if(error.status===400 && /too large|5,000|100,000|exceeds 2 MB/.test(error.message))return {large:true,fileId:id,name:item.name,size:item.size};throw error;}
  }
  async function downloadTo(id,filename,onProgress=async()=>{}) {
    const item=await sourceFile(id);const handle=await require('node:fs/promises').open(filename,'wx');
    try {await download(item,100*1024*1024,async(chunk,size)=>{await handle.write(chunk);await onProgress(size,item.size);},180000);}
    finally {await handle.close();}
    return {name:item.name,size:item.size};
  }
  return {status,start,callback,disconnect,files,workbook,downloadTo,sourceFile};
}
function safeWebUrl(value) {
  try { const url = new URL(value); if (url.protocol === 'https:' && (url.hostname.endsWith('.sharepoint.com') || url.hostname === 'onedrive.live.com')) return url.href; } catch {}
  return '';
}
module.exports = {createOneDrive,configuration,encrypt,decrypt,callbackPath,authorizationFailure};
