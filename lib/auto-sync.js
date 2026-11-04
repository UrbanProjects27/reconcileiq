const {randomUUID,createHmac,timingSafeEqual}=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {prepareImport,definitions}=require('./import');const {readLargeWorkbook}=require('./bulk-reader');
const {decodeState,encodeState}=require('./state-codec');
const {validateBankCustomers,validateAdviceFields,validateReturnFields}=require('./state');
const supported=['invoices','bank','returns','priceReturns','debitNotes','customerTerms'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const now=()=>new Date().toISOString();const later=ms=>new Date(Date.now()+ms).toISOString();
const nextCheck=()=>new Date((Math.floor(Date.now()/900000)+1)*900000).toISOString();
const headerValues=values=>{const result=values.map(v=>String(v ?? '').trim());while(result.length && !result.at(-1))result.pop();return result;};
function signRun(id,key){return createHmac('sha256',key).update('reconcileiq-auto-sync:'+id).digest('hex');}
function verifyRun(id,value,key){return /^[a-f0-9-]{36}$/i.test(String(id)) && !!key && /^[a-f0-9]{64}$/i.test(String(value)) && timingSafeEqual(Buffer.from(signRun(id,key),'hex'),Buffer.from(value,'hex'));}
function createAutoSync({db,onedrive,bulk,audit=async()=>{},env=process.env,enqueue}){
  const lock=db.kind==='postgres'?' FOR UPDATE':'';
  async function actor(query,id,session){
    const [user]=await query('SELECT id,name,role,active,must_change FROM app_users WHERE id=$1',[id]);
    if(!user?.active || user.must_change || user.role!=='admin')fail(403,'The administrator who enabled this sync no longer has access. Another administrator must save the mapping again.');
    if(session?.token_hash){const [valid]=await query('SELECT user_id FROM app_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at > $3',[session.token_hash,id,now()]);if(!valid)fail(403,'Sign in again before changing synchronization.');}
    return user;
  }
  async function list(){
    const sources=await db.query('SELECT * FROM sync_sources ORDER BY next_run_at');
    const runs=await db.query('SELECT id,source_id,status,summary,error,created_at,updated_at FROM sync_runs ORDER BY created_at DESC LIMIT 30');
    return {sources:sources.map(({config,user_id,lease_until,version,last_tag,...s})=>({...s,config:JSON.parse(config)})),runs:runs.map(r=>({...r,summary:JSON.parse(r.summary)}))};
  }
  async function save(user,input,origin){
    if(!supported.includes(input.type))fail(400,'Automatic sync supports registers with a stable document number. Payment advice must be reviewed and imported manually.');
    const job=await bulk.get(user,input.jobId);if(job.status!=='ready')fail(409,'Prepare a fresh workbook before saving its automatic sync mapping.');
    const sheet=job.info.sheets.find(s=>s.key===input.sheetKey);if(!sheet || sheet.error)fail(400,'Choose a readable worksheet.');
    const projected=await bulk.project(user,input);
    const [current]=await db.query('SELECT data FROM workspace WHERE id=1');
    const preview=prepareImport(projected,decodeState(current.data),{reviewConflicts:true});
    if(preview.counts.invalid)fail(400,preview.errors[0]?.message || 'Fix the mapping before enabling automatic sync.');
    const header=sheet.rows[input.startRow-2];if(!header || input.startRow<2)fail(400,'Automatic sync requires a header row within the first 50 worksheet rows.');
    const mapping=Object.fromEntries(definitions[input.type].fields.filter(f=>Number.isInteger(input.mapping?.[f.key]) && input.mapping[f.key]>=0 && input.mapping[f.key]<100).map(f=>[f.key,input.mapping[f.key]]));
    const config={name:job.info.name,sheetName:sheet.name,type:input.type,mapping,startRow:input.startRow,dateFormat:input.dateFormat || 'dmy',invoiceRows:input.invoiceRows || 'single',headers:headerValues(header)};
    const id=await db.transaction(async query=>{
      await query('SELECT id FROM workspace WHERE id=1'+lock);await actor(query,user.id,user);
      const all=await query('SELECT id,file_id,config FROM sync_sources');
      const existing=all.find(s=>s.file_id===job.file_id && JSON.parse(s.config).sheetName===sheet.name && JSON.parse(s.config).type===input.type);
      if(!existing && all.length>=20)fail(400,'A workspace supports up to 20 automatic sync mappings.');
      const id=existing?.id || randomUUID();
      if(existing)await query('UPDATE sync_sources SET user_id=$1,config=$2,version=$3,enabled=1,last_tag=$4,next_run_at=$5,lease_until=$6,status=$7 WHERE id=$8',[user.id,JSON.stringify(config),randomUUID(),'',now(),'','pending',id]);
      else await query('INSERT INTO sync_sources(id,user_id,file_id,config,version,next_run_at) VALUES($1,$2,$3,$4,$5,$6)',[id,user.id,job.file_id,JSON.stringify(config),randomUUID(),now()]);
      await audit(query,user,'sync.enabled',{sourceId:id,name:config.name,type:config.type});return id;
    });
    await dispatch(origin,id);return {id};
  }
  async function control(user,id,action,origin){
    if(!['pause','resume','run'].includes(action))fail(400,'Choose pause, resume or run.');
    await db.transaction(async query=>{
      await query('SELECT id FROM workspace WHERE id=1'+lock);await actor(query,user.id,user);
      const [source]=await query('SELECT * FROM sync_sources WHERE id=$1',[id]);if(!source)fail(404,'Sync mapping not found.');
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
    let filename;
    try{
      const [source]=await db.query('SELECT * FROM sync_sources WHERE id=$1',[job.source_id]);
      if(!source?.enabled || source.version!==job.source_version)fail(409,'The sync mapping was paused or changed.');
      const user=await actor(db.query,source.user_id);const config=JSON.parse(source.config);
      if(!supported.includes(config.type))fail(400,'Unsupported automatic sync register.');
      const item=await onedrive.sourceFile(source.file_id);const tag=item.cTag || item.eTag || '';
      let result={counts:{added:0,skipped:0,updated:0,review:0,unmatched:0},reviews:[],warnings:[],unchanged:true};
      if(!tag || tag!==source.last_tag){
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
        if(!rows.length)fail(400,'The selected worksheet has no data rows. Existing app records were kept.');
        const latest=await onedrive.sourceFile(source.file_id);
        if(tag && (latest.cTag || latest.eTag || '')!==tag)fail(409,'The source file changed during download. It will be retried at the next check.');
        result={input:{type:config.type,rows,sourceRows,mapping:config.mapping,startRow:config.startRow,dateFormat:config.dateFormat,invoiceRows:config.invoiceRows,bulk:true},unchanged:false};
      }
      await db.transaction(async query=>{
        const [workspace]=await query('SELECT revision,data FROM workspace WHERE id=1'+lock);
        const [currentSource]=await query('SELECT * FROM sync_sources WHERE id=$1',[source.id]);
        if(!currentSource?.enabled || currentSource.version!==job.source_version)fail(409,'The sync mapping was paused or changed.');
        const currentUser=await actor(query,user.id);
        if(result.input){
          const before=decodeState(workspace.data);result=prepareImport(result.input,before,{reviewConflicts:true});
          if(result.counts.invalid)fail(400,result.errors.slice(0,5).map(e=>`${e.row?'Row '+e.row+': ':''}${e.message}`).join(' '));
          if(result.canImport){
            validateBankCustomers(result.state,before);validateAdviceFields(result.state,before);validateReturnFields(result.state,before);
            const encoded=encodeState(result.state);
            await query('INSERT INTO workspace_snapshots(revision,data,created_at) VALUES($1,$2,$3) ON CONFLICT(revision) DO NOTHING',[workspace.revision,workspace.data,now()]);
            await query('UPDATE workspace SET data=$1,revision=revision+1 WHERE id=1',[encoded]);
            await query('DELETE FROM workspace_snapshots WHERE revision < $1',[workspace.revision+1-(encoded.startsWith('gzip:')?20:100)]);
            await audit(query,currentUser,'workspace.auto_synced',{sourceId:source.id,type:config.type,revision:workspace.revision+1,counts:result.counts});
          }
        }
        const review=!!(result.counts.review || result.counts.unmatched),status=review?'review':'success';
        const summary={name:config.name,type:config.type,counts:result.counts,reviews:result.reviews || [],warnings:result.warnings || [],unchanged:!!result.unchanged};
        await query('UPDATE sync_runs SET status=$1,summary=$2,updated_at=$3 WHERE id=$4',[status,JSON.stringify(summary),now(),id]);
        await query('UPDATE sync_sources SET last_tag=$1,last_success=$2,lease_until=$3,status=$4 WHERE id=$5 AND version=$6',[review?'':tag,now(),'',status,source.id,job.source_version]);
      });
    }catch(error){
      const message=error.status?error.message:'Synchronization could not complete. It will retry on the next scheduled check.';
      await db.query('UPDATE sync_runs SET status=$1,error=$2,updated_at=$3 WHERE id=$4',['failed',message.slice(0,2000),now(),id]);
      await db.query('UPDATE sync_sources SET lease_until=$1,status=$2 WHERE id=$3 AND version=$4',['','failed',job.source_id,job.source_version]);
      console.error('Automatic sync failed:',JSON.stringify({id,code:error.status || 'SYNC_FAILED'}));
    }finally{if(filename)try{await fs.unlink(filename);}catch(error){if(error.code!=='ENOENT')console.error('Sync temporary file cleanup failed.');}}
  }
  return {list,save,control,dispatch,run};
}
module.exports={createAutoSync,signRun,verifyRun,headerValues,supported};
