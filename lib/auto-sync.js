const {randomUUID,createHmac,timingSafeEqual,createHash}=require('node:crypto');
const access=require('./customer-access');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {prepareImport,definitions}=require('./import');const {readLargeWorkbook}=require('./bulk-reader');
const {decodeState,encodeState}=require('./state-codec');
const {validateBankCustomers,validateAdviceFields,validateReturnFields,validateDebitFields}=require('./state');
const supported=['invoices','bank','returns','priceReturns','debitNotes','customerTerms','vendorSales','vendorRTV'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const now=()=>new Date().toISOString();const later=ms=>new Date(Date.now()+ms).toISOString();
const nextCheck=()=>new Date((Math.floor(Date.now()/900000)+1)*900000).toISOString();
const headerValues=values=>{const result=values.map(v=>String(v ?? '').trim());while(result.length && !result.at(-1))result.pop();return result;};
function signRun(id,key){return createHmac('sha256',key).update('reconcileiq-auto-sync:'+id).digest('hex');}
function verifyRun(id,value,key){return /^[a-f0-9-]{36}$/i.test(String(id)) && !!key && /^[a-f0-9]{64}$/i.test(String(value)) && timingSafeEqual(Buffer.from(signRun(id,key),'hex'),Buffer.from(value,'hex'));}
function createAutoSync({db,onedrive,bulk,audit=async()=>{},env=process.env,enqueue}){
  const lock=db.kind==='postgres'?' FOR UPDATE':'';
  async function actor(query,id,session){
    const [user]=await query('SELECT id,name,role,active,must_change,buyer_group_ids FROM app_users WHERE id=$1',[id]);
    if(!user?.active || user.must_change || !['admin','editor'].includes(user.role))fail(403,'The user who enabled this sync no longer has access. An administrator or editor must save the mapping again.');
    if(session?.token_hash){const [valid]=await query('SELECT user_id FROM app_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at > $3',[session.token_hash,id,now()]);if(!valid)fail(403,'Sign in again before changing synchronization.');}
    return user;
  }
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scopeHash=(user,state)=>access.restricted(user)?digest([...access.customerKeys(user,state)].sort()):'';
  const checkpoint=(item,user,state,config)=>{const tag=item.cTag || item.eTag || '';if(!tag || !access.restricted(user))return tag;const invoices=['returns','priceReturns'].includes(config.type)?digest(access.filterState(state,user).invoices.map(row=>row.id).sort()):'';return tag+'|'+scopeHash(user,state)+'|'+invoices;};
  async function approved(query,config){
    if(!config.approvedSourceId)fail(403,'Choose an approved mapping for your buyer groups.');
    const [source]=await query('SELECT * FROM sync_sources WHERE id=$1',[config.approvedSourceId]);
    if(!source || source.version!==config.approvedVersion || JSON.parse(source.config).approvedSourceId)fail(409,'The approved mapping changed. Enable it again from Automatic sync.');
    const owner=await actor(query,source.user_id);if(access.restricted(owner))fail(403,'The shared mapping requires approval from an account with all-customer access.');
    return source;
  }
  async function list(user){
    const current=await actor(db.query,user.id,user),scoped=access.restricted(current);
    const all=await db.query('SELECT * FROM sync_sources ORDER BY next_run_at');
    const sources=scoped?all.filter(s=>s.user_id===current.id && JSON.parse(s.config).approvedSourceId):all;
    let runs=(await db.query('SELECT id,source_id,status,summary,error,created_at,updated_at FROM sync_runs ORDER BY created_at DESC LIMIT 30')).map(r=>({...r,summary:JSON.parse(r.summary)}));
    const templates=[];
    if(scoped){
      const [workspace]=await db.query('SELECT data FROM workspace WHERE id=1');const hash=scopeHash(current,decodeState(workspace.data)),ids=new Set(sources.map(s=>s.id));
      runs=runs.filter(r=>ids.has(r.source_id) && r.summary.scopedHash===hash);
      for(const s of all){const config=JSON.parse(s.config);if(config.approvedSourceId)continue;try{const owner=await actor(db.query,s.user_id);if(!access.restricted(owner))templates.push({id:s.id,name:config.name,sheetName:config.sheetName,type:config.type});}catch{}}
    }
    return {scoped,templates,sources:sources.map(({config,user_id,lease_until,version,last_tag,...s})=>({...s,config:JSON.parse(config)})),runs};
  }
  async function save(user,input,origin){
    const requester=await actor(db.query,user.id,user),scoped=access.restricted(requester);let config,fileId;
    if(scoped){
      if(typeof input.approvedSourceId!=='string')fail(403,'Choose an approved mapping for your buyer groups.');
      const [source]=await db.query('SELECT * FROM sync_sources WHERE id=$1',[input.approvedSourceId]);if(!source)fail(404,'Approved mapping not found.');
      config={...JSON.parse(source.config),approvedSourceId:source.id,approvedVersion:source.version};await approved(db.query,config);fileId=source.file_id;
    }else{
      if(!supported.includes(input.type))fail(400,'Automatic sync supports registers with a stable document number. Payment advice must be reviewed and imported manually.');
      const job=await bulk.get(user,input.jobId);if(job.status!=='ready')fail(409,'Prepare a fresh workbook before saving its automatic sync mapping.');
      const sheet=job.info.sheets.find(s=>s.key===input.sheetKey);if(!sheet || sheet.error)fail(400,'Choose a readable worksheet.');
      const projected=await bulk.project(user,input);const [current]=await db.query('SELECT data FROM workspace WHERE id=1');
      const vendorType=['vendorSales','vendorRTV'].includes(input.type);
      if(vendorType && input.vendorName!==undefined && (typeof input.vendorName!=='string' || input.vendorName.length>2000 || /[<>\x00-\x08\x0b-\x1f]/.test(input.vendorName)))fail(400,'Use a valid plain-text vendor name.');
      if(vendorType){const columns=Object.values(input.mapping || {});if(new Set(columns).size!==columns.length || definitions[input.type].fields.some(field=>field.required && !(field.key==='vendor' && input.vendorName?.trim()) && (!Number.isInteger(input.mapping?.[field.key]) || input.mapping[field.key]<0 || input.mapping[field.key]>=100)))fail(400,'Map all required vendor source columns.');}
      const preview=vendorType && !projected.rows.length?{counts:{invalid:0}}:prepareImport(projected,decodeState(current.data),{reviewConflicts:true});if(preview.counts.invalid)fail(400,preview.errors[0]?.message || 'Fix the mapping before enabling automatic sync.');
      const header=sheet.rows[input.startRow-2];if(!header || input.startRow<2)fail(400,'Automatic sync requires a header row within the first 50 worksheet rows.');
      const mapping=Object.fromEntries(definitions[input.type].fields.filter(f=>Number.isInteger(input.mapping?.[f.key]) && input.mapping[f.key]>=0 && input.mapping[f.key]<100).map(f=>[f.key,input.mapping[f.key]]));
      config={name:job.info.name,sheetName:sheet.name,type:input.type,mapping,startRow:input.startRow,dateFormat:input.dateFormat || 'dmy',invoiceRows:input.invoiceRows || 'single',...(vendorType?{vendorName:input.vendorName || ''}:{}),headers:headerValues(header)};fileId=job.file_id;
    }
    const id=await db.transaction(async query=>{
      await query('SELECT id FROM workspace WHERE id=1'+lock);await actor(query,user.id,user);
      if(scoped)await approved(query,config);
      const all=await query('SELECT id,user_id,file_id,config FROM sync_sources');
      const existing=all.find(s=>{const c=JSON.parse(s.config);return s.file_id===fileId && c.sheetName===config.sheetName && c.type===config.type && (scoped?s.user_id===user.id && c.approvedSourceId===config.approvedSourceId:!c.approvedSourceId);});
      if(!existing && all.length>=20)fail(400,'A workspace supports up to 20 automatic sync mappings.');
      const id=existing?.id || randomUUID();
      if(existing)await query('UPDATE sync_sources SET user_id=$1,config=$2,version=$3,enabled=1,last_tag=$4,next_run_at=$5,lease_until=$6,status=$7 WHERE id=$8',[user.id,JSON.stringify(config),randomUUID(),'',now(),'','pending',id]);
      else await query('INSERT INTO sync_sources(id,user_id,file_id,config,version,next_run_at) VALUES($1,$2,$3,$4,$5,$6)',[id,user.id,fileId,JSON.stringify(config),randomUUID(),now()]);
      await audit(query,user,'sync.enabled',{sourceId:id,name:config.name,type:config.type});return id;
    });
    await dispatch(origin,id);return {id};
  }
  async function control(user,id,action,origin){
    if(!['pause','resume','run'].includes(action))fail(400,'Choose pause, resume or run.');
    await db.transaction(async query=>{
      await query('SELECT id FROM workspace WHERE id=1'+lock);const requester=await actor(query,user.id,user);
      const [source]=await query('SELECT * FROM sync_sources WHERE id=$1',[id]);if(!source)fail(404,'Sync mapping not found.');
      if(access.restricted(requester) && (source.user_id!==requester.id || !JSON.parse(source.config).approvedSourceId))fail(403,'You can control only your buyer-group sync mappings.');
      if(action!=='run')await query('UPDATE sync_sources SET enabled=$1,user_id=$2,version=$3,last_tag=$4,next_run_at=$5,status=$6,lease_until=$7 WHERE id=$8',[action==='pause'?0:1,user.id,randomUUID(),'',now(),action==='pause'?'paused':'pending','',id]);
      else {if(!source.enabled)fail(409,'Resume this mapping before running it.');await query('UPDATE sync_sources SET next_run_at=$1,last_tag=$2 WHERE id=$3',[now(),'',id]);}
      await audit(query,user,'sync.'+action,{sourceId:id});
    });
    if(action!=='pause')await dispatch(origin,id);return {ok:true};
  }
  async function dispatch(origin,onlyId){
    if(!env.ONEDRIVE_TOKEN_KEY)fail(503,'OneDrive must be configured before synchronization.');
    const jobs=await db.transaction(async query=>{
      await query('SELECT id FROM workspace WHERE id=1'+lock);
      await query('UPDATE sync_runs SET status=$1,error=$2,updated_at=$3 WHERE status IN ($4,$5) AND created_at < $6',['failed','Sync timed out; it will retry on the next scheduled check.',now(),'queued','processing',later(-16*60*1000)]);
      const due=await query('SELECT * FROM sync_sources WHERE enabled=1 AND next_run_at <= $1 AND lease_until < $2'+(onlyId?' AND id=$3':'')+' ORDER BY next_run_at LIMIT 20',[now(),now(),...(onlyId?[onlyId]:[])]);
      const jobs=[];
      for(const source of due){
        const id=randomUUID();await query('UPDATE sync_sources SET lease_until=$1,next_run_at=$2,status=$3 WHERE id=$4',[later(16*60*1000),nextCheck(),'queued',source.id]);
        await query('INSERT INTO sync_runs(id,source_id,source_version,status,summary,error,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,source.id,source.version,'queued','{}','',now(),now()]);jobs.push({id,sourceId:source.id,version:source.version});
      }
      await query('DELETE FROM sync_runs WHERE created_at < $1 AND status NOT IN ($2,$3)',[later(-30*86400000),'queued','processing']);
      return jobs;
    });
    await Promise.all(jobs.map(async job=>{
      try{
        if(enqueue)await enqueue(job.id);
        else {const response=await fetch(new URL('/.netlify/functions/sync-worker',origin),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:job.id,signature:signRun(job.id,env.ONEDRIVE_TOKEN_KEY)}),redirect:'error',signal:AbortSignal.timeout(5000)});if(response.status!==202)throw Error('Background sync could not start.');}
      }catch{
        await db.query('UPDATE sync_runs SET status=$1,error=$2,updated_at=$3 WHERE id=$4 AND status=$5',['failed','Background sync could not start; it will retry at the next scheduled check.',now(),job.id,'queued']);
        await db.query('UPDATE sync_sources SET lease_until=$1,status=$2 WHERE id=$3 AND version=$4',['','failed',job.sourceId,job.version]);
      }
    }));return {queued:jobs.length};
  }
  async function run(id){
    const [job]=await db.query('UPDATE sync_runs SET status=$1,updated_at=$2 WHERE id=$3 AND status=$4 RETURNING *',['processing',now(),id,'queued']);if(!job)return;
    let filename,runScopeHash='';
    try{
      const [source]=await db.query('SELECT * FROM sync_sources WHERE id=$1',[job.source_id]);
      if(!source?.enabled || source.version!==job.source_version)fail(409,'The sync mapping was paused or changed.');
      const user=await actor(db.query,source.user_id);const config=JSON.parse(source.config);
      if(!supported.includes(config.type))fail(400,'Unsupported automatic sync register.');
      const [initialWorkspace]=await db.query('SELECT data FROM workspace WHERE id=1');const initialState=decodeState(initialWorkspace.data);runScopeHash=scopeHash(user,initialState);
      if(access.restricted(user))await approved(db.query,config);
      const item=await onedrive.sourceFile(source.file_id);const tag=item.cTag || item.eTag || '';
      const initialCheckpoint=checkpoint(item,user,initialState,config);
      let result={counts:{added:0,skipped:0,updated:0,review:0,unmatched:0},reviews:[],warnings:[],unchanged:true};
      if(!initialCheckpoint || initialCheckpoint!==source.last_tag){
        filename=path.join(os.tmpdir(),'reconcileiq-sync-'+id+(/\.csv$/i.test(item.name)?'.csv':'.xlsx'));
        await onedrive.downloadTo(source.file_id,filename);
        let selectedKey,found=false,header,bytes=0;const rows=[],sourceRows=[];
        await readLargeWorkbook(filename,async sheet=>{if(sheet.name===config.sheetName){selectedKey=sheet.key;found=true;}},async(key,batch)=>{
          if(key!==selectedKey)return;
          for(const row of batch){
            if(row.n===config.startRow-1)header=headerValues(row.v);
            if(row.n<config.startRow)continue;
            const values=[];for(const column of Object.values(config.mapping))values[column]=row.v[column] ?? '';
            for(let i=0;i<values.length;i++)values[i]??='';bytes+=Buffer.byteLength(JSON.stringify(values));
            if(bytes>40*1024*1024)fail(400,'The selected sync columns exceed the 40 MB capacity.');rows.push(values);sourceRows.push(row.n);
          }
        },async()=>{},async(key,message)=>{if(key===selectedKey)fail(400,message);});
        if(!found)fail(400,'The saved worksheet is missing. Prepare the workbook and save its mapping again.');
        if(JSON.stringify(header)!==JSON.stringify(config.headers))fail(400,'The worksheet headers changed. Review and save the column mapping again.');
        if(!rows.length && !['vendorSales','vendorRTV'].includes(config.type))fail(400,'The selected worksheet has no data rows. Existing app records were kept.');
        const latest=await onedrive.sourceFile(source.file_id);
        if(tag && (latest.cTag || latest.eTag || '')!==tag)fail(409,'The source file changed during download. It will be retried at the next check.');
        result={input:{type:config.type,rows,sourceRows,mapping:config.mapping,startRow:config.startRow,dateFormat:config.dateFormat,invoiceRows:config.invoiceRows,vendorName:config.vendorName,bulk:true},unchanged:false};
      }
      await db.transaction(async query=>{
        const [workspace]=await query('SELECT revision,data FROM workspace WHERE id=1'+lock);
        const [currentSource]=await query('SELECT * FROM sync_sources WHERE id=$1',[source.id]);
        if(!currentSource?.enabled || currentSource.version!==job.source_version)fail(409,'The sync mapping was paused or changed.');
        const currentUser=await actor(query,user.id);
        const before=decodeState(workspace.data);const scoped=access.restricted(currentUser);if(scoped)await approved(query,config);
        const currentCheckpoint=checkpoint(item,currentUser,before,config);runScopeHash=scopeHash(currentUser,before);
        if(result.unchanged && currentCheckpoint!==initialCheckpoint)fail(409,'Access or invoices changed during the check. The next check will retry.');
        if(result.input){
          let input=result.input;
          if(scoped && !['vendorSales','vendorRTV'].includes(config.type)){
            const keys=access.customerKeys(currentUser,before),invoiceIds=new Set(access.filterState(before,currentUser).invoices.map(row=>row.id));
            const rows=[],sourceRows=[];for(let index=0;index<input.rows.length;index++){const row=input.rows[index];const allowed=['returns','priceReturns'].includes(config.type)?invoiceIds.has(String(row[input.mapping.invoice] || '').trim()):keys.has(String(row[input.mapping.customer] || '').trim().toLowerCase());if(allowed){rows.push(row);sourceRows.push(input.sourceRows[index]);}}
            input={...input,rows,sourceRows};
          }
          result=input.rows.length?prepareImport(input,access.filterState(before,currentUser),{reviewConflicts:true}):{counts:{added:0,skipped:0,updated:0,invalid:0,review:0,unmatched:0},reviews:[],warnings:[],canImport:false};
          if(result.counts.invalid)fail(400,result.errors.slice(0,5).map(e=>`${e.row?'Row '+e.row+': ':''}${e.message}`).join(' '));
          if(result.canImport){
            access.assertImportScope(result.state,currentUser,before);result.state=access.mergeState(before,result.state,currentUser);
            validateBankCustomers(result.state,before);validateAdviceFields(result.state,before);validateReturnFields(result.state,before);validateDebitFields(result.state,before);
            const encoded=encodeState(result.state);
            await query('INSERT INTO workspace_snapshots(revision,data,created_at) VALUES($1,$2,$3) ON CONFLICT(revision) DO NOTHING',[workspace.revision,workspace.data,now()]);
            await query('UPDATE workspace SET data=$1,revision=revision+1 WHERE id=1',[encoded]);
            await query('DELETE FROM workspace_snapshots WHERE revision < $1',[workspace.revision+1-(encoded.startsWith('gzip:')?20:100)]);
            await audit(query,currentUser,'workspace.auto_synced',{sourceId:source.id,type:config.type,revision:workspace.revision+1,counts:result.counts});
          }
        }
        const review=!!(result.counts.review || result.counts.unmatched),status=review?'review':'success';
        const summary={name:config.name,type:config.type,counts:result.counts,reviews:result.reviews || [],warnings:result.warnings || [],unchanged:!!result.unchanged,scopedHash:runScopeHash};
        await query('UPDATE sync_runs SET status=$1,summary=$2,updated_at=$3 WHERE id=$4',[status,JSON.stringify(summary),now(),id]);
        await query('UPDATE sync_sources SET last_tag=$1,last_success=$2,lease_until=$3,status=$4 WHERE id=$5 AND version=$6',[review?'':currentCheckpoint,now(),'',status,source.id,job.source_version]);
      });
    }catch(error){
      const message=error.status?error.message:'Synchronization could not complete. It will retry on the next scheduled check.';
      await db.query('UPDATE sync_runs SET status=$1,error=$2,updated_at=$3,summary=$4 WHERE id=$5',['failed',message.slice(0,2000),now(),JSON.stringify({scopedHash:runScopeHash}),id]);
      await db.query('UPDATE sync_sources SET lease_until=$1,status=$2 WHERE id=$3 AND version=$4',['','failed',job.source_id,job.source_version]);
      console.error('Automatic sync failed:',JSON.stringify({id,code:error.status || 'SYNC_FAILED'}));
    }finally{if(filename)try{await fs.unlink(filename);}catch(error){if(error.code!=='ENOENT')console.error('Sync temporary file cleanup failed.');}}
  }
  return {list,save,control,dispatch,run};
}
module.exports={createAutoSync,signRun,verifyRun,headerValues,supported};
