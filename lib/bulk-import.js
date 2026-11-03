const {randomUUID,createHmac,timingSafeEqual}=require('node:crypto');const {gzipSync,gunzipSync}=require('node:zlib');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {readLargeWorkbook}=require('./bulk-reader');const {definitions}=require('./import');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const validId=id=>/^[a-f0-9-]{36}$/i.test(String(id));
function signature(id,key){return createHmac('sha256',key).update('reconcileiq-bulk-import:'+id).digest('hex');}
function verifySignature(id,value,key){if(!validId(id)||!key||!/^[a-f0-9]{64}$/i.test(String(value)))return false;return timingSafeEqual(Buffer.from(signature(id,key),'hex'),Buffer.from(value,'hex'));}
function createBulkImport({db,onedrive,env=process.env,enqueue}){
  const cleanup=async()=>{
    const stale=await db.query('UPDATE import_jobs SET status=$1,error=$2 WHERE status IN ($3,$4) AND updated_at < $5 RETURNING id',['failed','The preparation timed out. Prepare the file again.','queued','processing',new Date(Date.now()-16*60*1000).toISOString()]);
    for(const job of stale)await db.query('DELETE FROM import_chunks WHERE job_id=$1',[job.id]);
    await db.query('DELETE FROM import_jobs WHERE expires_at < $1',[new Date().toISOString()]);
  };
  async function start(user,fileId,origin){
    if(!env.ONEDRIVE_TOKEN_KEY)fail(503,'OneDrive must be configured before preparing a bulk import.');
    const source=await onedrive.sourceFile(fileId);await cleanup();const id=randomUUID(),now=new Date().toISOString();
    await db.transaction(async query=>{
      await query('SELECT id FROM workspace WHERE id=1'+(db.kind==='postgres'?' FOR UPDATE':''));
      const [active]=await query('SELECT COUNT(*) AS count FROM import_jobs WHERE status IN ($1,$2)',['queued','processing']);
      if(Number(active.count)>=1)fail(409,'Another bulk import is being prepared. Open Bulk imports to resume it or wait for it to finish.');
      await query('DELETE FROM import_jobs WHERE id IN (SELECT id FROM import_jobs WHERE user_id=$1 AND status NOT IN ($2,$3) ORDER BY created_at DESC LIMIT 1000 OFFSET 2)',[user.id,'queued','processing']);
      await query('INSERT INTO import_jobs(id,user_id,file_id,status,info,error,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,user.id,fileId,'queued',JSON.stringify({name:source.name,size:source.size,progress:'Queued',sheets:[]}),'',now,now,new Date(Date.now()+6*60*60*1000).toISOString()]);
    });
    try{
      if(enqueue)await enqueue(id);
      else{
        const response=await fetch(new URL('/.netlify/functions/import-worker',origin),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,signature:signature(id,env.ONEDRIVE_TOKEN_KEY)}),signal:AbortSignal.timeout(15000),redirect:'error'});
        if(response.status!==202)fail(503,'The background importer could not start. Try again shortly.');
      }
    }catch(error){await db.query('UPDATE import_jobs SET status=$1,error=$2 WHERE id=$3',['failed','The background importer could not start. Try again shortly.',id]);fail(503,'The background importer could not start. Try again shortly.');}
    return {id};
  }
  async function list(user){await cleanup();return {jobs:(await db.query('SELECT id,status,info,error,created_at,updated_at FROM import_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5',[user.id])).map(row=>{const info=JSON.parse(row.info);return {...row,info:{name:info.name,size:info.size,progress:info.progress}};})};}
  async function get(user,id){
    if(!validId(id))fail(400,'Invalid bulk import.');await cleanup();
    const [row]=await db.query('SELECT * FROM import_jobs WHERE id=$1 AND user_id=$2',[id,user.id]);if(!row)fail(404,'This bulk import expired or is unavailable. Prepare the file again.');
    if(['queued','processing'].includes(row.status) && Date.parse(row.updated_at)<Date.now()-16*60*1000){await db.query('UPDATE import_jobs SET status=$1,error=$2 WHERE id=$3',['failed','The preparation timed out. Try again, or export only the required worksheet.',id]);await db.query('DELETE FROM import_chunks WHERE job_id=$1',[id]);row.status='failed';row.error='The preparation timed out. Try again, or export only the required worksheet.';}
    return {...row,info:JSON.parse(row.info)};
  }
  async function cancel(user,id){await get(user,id);await db.transaction(async query=>{await query('UPDATE import_jobs SET status=$1,updated_at=$2 WHERE id=$3 AND status IN ($4,$5,$6)',['cancelled',new Date().toISOString(),id,'queued','processing','ready']);await query('DELETE FROM import_chunks WHERE job_id=$1',[id]);});return {ok:true};}
  async function run(id){
    const [job]=await db.query('UPDATE import_jobs SET status=$1,updated_at=$2 WHERE id=$3 AND status=$4 RETURNING *',['processing',new Date().toISOString(),id,'queued']);if(!job)return;
    const info=JSON.parse(job.info);const filename=path.join(os.tmpdir(),`reconcileiq-${id}${/\.csv$/i.test(info.name)?'.csv':'.xlsx'}`);let lastUpdate=0,rawBytes=0,storedBytes=0;
    async function actor(){const [user]=await db.query('SELECT id FROM app_users WHERE id=$1 AND role=$2 AND active=1 AND must_change=0',[job.user_id,'admin']);if(!user)fail(403,'Administrator access ended. Sign in again to prepare the file.');}
    async function update(progress,force=false){
      if(!force && Date.now()-lastUpdate<2000)return;lastUpdate=Date.now();
      const [current]=await db.query('SELECT status FROM import_jobs WHERE id=$1',[id]);if(current?.status!=='processing')fail(409,'Preparation cancelled.');
      info.progress=progress;await db.query('UPDATE import_jobs SET info=$1,updated_at=$2 WHERE id=$3 AND status=$4',[JSON.stringify(info),new Date().toISOString(),id,'processing']);
    }
    try{
      await actor();await update('Downloading from OneDrive',true);
      await onedrive.downloadTo(job.file_id,filename,(size,total)=>update(`Downloading ${Math.round(size/1024/1024)} MB of ${Math.round(total/1024/1024)} MB`));
      const sheets=new Map();
      const stageRows=async(key,rows)=>{
        const sheet=sheets.get(key);const text=JSON.stringify(rows);rawBytes+=Buffer.byteLength(text);if(rawBytes>256*1024*1024)fail(400,'The worksheet values exceed the 256 MB staging capacity. Export only the required columns or worksheet.');
        if(Buffer.byteLength(text)>4*1024*1024 && rows.length>1){rawBytes-=Buffer.byteLength(text);const middle=Math.ceil(rows.length/2);await stageRows(key,rows.slice(0,middle));await stageRows(key,rows.slice(middle));return;}
        const data=gzipSync(text);storedBytes+=data.length;if(storedBytes>64*1024*1024)fail(400,'The source exceeds the staging capacity. Export only the required worksheet.');
        const encoded=data.toString('base64');
        await db.query('INSERT INTO import_chunks(job_id,sheet_key,chunk_index,data) VALUES($1,$2,$3,$4)',[id,key,sheet.chunks++,encoded]);
        for(const row of rows){sheet.rowCount++;sheet.maxRow=Math.max(sheet.maxRow,row.n);sheet.columnCount=Math.max(sheet.columnCount,row.v.length);if(row.n<=50){while(sheet.rows.length<row.n)sheet.rows.push([]);sheet.rows[row.n-1]=row.v.map(value=>typeof value==='string'&&value.length>200?value.slice(0,200)+'…':value);}}
        await update(`Reading ${sheet.name}: ${sheet.rowCount.toLocaleString('en-IN')} rows`);
      };
      await readLargeWorkbook(filename,async sheet=>{const metadata={...sheet,rows:[],rowCount:0,maxRow:0,columnCount:0,chunks:0};sheets.set(sheet.key,metadata);info.sheets.push(metadata);},stageRows,progress=>update(progress),async(key,message)=>{
        await db.query('DELETE FROM import_chunks WHERE job_id=$1 AND sheet_key=$2',[id,key]);
        Object.assign(sheets.get(key),{error:message,rows:[],rowCount:0,maxRow:0,columnCount:0,chunks:0});
      });
      if(!info.sheets.some(sheet=>!sheet.error))fail(400,'No worksheet could be prepared. '+(info.sheets[0]?.error || 'Check the workbook in Excel.'));
      await actor();await update('Ready for column mapping',true);
      await db.query('UPDATE import_jobs SET status=$1,info=$2,updated_at=$3 WHERE id=$4 AND status=$5',['ready',JSON.stringify(info),new Date().toISOString(),id,'processing']);
    }catch(error){
      const message=error.status?error.message:'The workbook could not be prepared. Recalculate and save it in Excel, or export the required worksheet as CSV.';
      await db.query('DELETE FROM import_chunks WHERE job_id=$1',[id]);await db.query('UPDATE import_jobs SET status=$1,error=$2,updated_at=$3 WHERE id=$4 AND status=$5',['failed',message,new Date().toISOString(),id,'processing']);
      console.error('Bulk import preparation failed:',JSON.stringify({id,code:/^[\w]{1,80}$/.test(error.code || '')?error.code:'SOURCE_PROCESSING_FAILED'}));
    }finally{try{await fs.unlink(filename);}catch(error){if(error.code!=='ENOENT')console.error('Bulk import temporary file cleanup failed.');}}
  }
  async function project(user,input){
    if(!input.jobId)return input;
    const job=await get(user,input.jobId);if(job.status!=='ready')fail(409,job.status==='imported'?'This preparation was already imported. Refresh shared data.':'Wait until the workbook preparation is ready.');
    const sheet=job.info.sheets.find(s=>s.key===input.sheetKey);if(!sheet)fail(400,'Choose a prepared worksheet.');
    if(sheet.error)fail(400,'This worksheet is unavailable: '+sheet.error);
    if(!Number.isInteger(input.startRow)||input.startRow<1||input.startRow>1048576)fail(400,'Invalid first data row.');
    if(!Object.hasOwn(definitions,input.type))fail(400,'Choose a supported data type.');
    const entries=definitions[input.type].fields.filter(f=>Number.isInteger(input.mapping?.[f.key])&&input.mapping[f.key]>=0&&input.mapping[f.key]<100).map(f=>[f.key,input.mapping[f.key]]);
    if(new Set(entries.map(([,column])=>column)).size!==entries.length)fail(400,'Map each source column to only one field.');
    const rows=[],sourceRows=[];let selectedBytes=0;const chunks=await db.query('SELECT data FROM import_chunks WHERE job_id=$1 AND sheet_key=$2 ORDER BY chunk_index',[job.id,sheet.key]);
    for(const chunk of chunks){const data=JSON.parse(gunzipSync(Buffer.from(chunk.data,'base64'),{maxOutputLength:16*1024*1024}).toString('utf8'));for(const row of data){if(row.n<input.startRow)continue;const selected=entries.map(([,column])=>row.v[column] ?? '');selectedBytes+=Buffer.byteLength(JSON.stringify(selected));if(selectedBytes>40*1024*1024)fail(400,'The selected columns exceed the 40 MB import-data capacity. Import only the required fields.');rows.push(selected);sourceRows.push(row.n);}}
    return {...input,rows,sourceRows,mapping:Object.fromEntries(entries.map(([key],i)=>[key,i])),bulk:true};
  }
  async function imported(query,user,id){
    if(!id)return;const [job]=await query('SELECT status FROM import_jobs WHERE id=$1 AND user_id=$2'+(db.kind==='postgres'?' FOR UPDATE':''),[id,user.id]);
    if(job?.status!=='ready')fail(409,'The prepared source changed. Review the import again.');
    await query('UPDATE import_jobs SET status=$1,updated_at=$2 WHERE id=$3',['imported',new Date().toISOString(),id]);await query('DELETE FROM import_chunks WHERE job_id=$1',[id]);
  }
  return {start,list,get,cancel,run,project,imported};
}
module.exports={createBulkImport,signature,verifySignature};
