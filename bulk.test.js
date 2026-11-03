const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const fsp=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {readLargeWorkbook}=require('./lib/bulk-reader');const {createBulkImport,signature,verifySignature}=require('./lib/bulk-import');const {openDatabase,postgresSchema,qualifySql,initialize}=require('./lib/database');const {createUser}=require('./lib/auth');const {encodeState,decodeState}=require('./lib/state-codec');const {emptyState,validateState}=require('./lib/state');const {prepareImport}=require('./lib/import');
const key='1'.repeat(64),password='Secure-bulk-test-password';
async function temp(t){const folder=await fsp.mkdtemp(path.join(os.tmpdir(),'reconcileiq-test-'));t.after(async()=>{for(const name of await fsp.readdir(folder))await fsp.unlink(path.join(folder,name));await fsp.rmdir(folder);});return folder;}
function largeXlsx(filename,rows,paddingMB=0,brokenSummary=false){
  const {Zip,ZipPassThrough,ZipDeflate,strToU8}=require('fflate');const handle=fs.openSync(filename,'wx');const zip=new Zip((error,data)=>{if(error)throw error;fs.writeSync(handle,data);});
  function entry(name,text){const part=new ZipDeflate(name,{level:6});zip.add(part);part.push(strToU8(text),true);}
  entry('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  entry('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+(brokenSummary?'<sheet name="Summary" r:id="rId0"/>':'')+'<sheet name="Invoices" r:id="rId1"/></sheets></workbook>');
  entry('xl/_rels/workbook.xml.rels','<Relationships>'+(brokenSummary?'<Relationship Id="rId0" Target="worksheets/summary.xml"/>':'')+'<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  if(brokenSummary)entry('xl/worksheets/summary.xml','<worksheet><sheetData><row r="1"><c r="A1" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>');
  const sheet=new ZipDeflate('xl/worksheets/sheet1.xml',{level:6});zip.add(sheet);sheet.push(strToU8('<worksheet><sheetData>'));
  const cell=(column,row,value)=>`<c r="${column}${row}" t="inlineStr"><is><t>${value}</t></is></c>`;
  for(let i=1;i<=rows+1;i++)sheet.push(strToU8(`<row r="${i}">${i===1?['Invoice','Customer','Date','Amount'].map((v,j)=>cell('ABCD'[j],i,v)).join(''):[`INV-${i-1}`,'Acme','2026-11-03','100'].map((v,j)=>cell('ABCD'[j],i,v)).join('')}</row>`));
  sheet.push(strToU8('</sheetData></worksheet>'),true);
  if(paddingMB){const media=new ZipPassThrough('xl/media/large-image.bin');zip.add(media);const chunk=new Uint8Array(1024*1024);for(let i=0;i<paddingMB;i++)media.push(chunk,i===paddingMB-1);}
  zip.end();fs.closeSync(handle);
}
test('bulk worker signatures are scoped to the job and do not accept arbitrary input',()=>{
  const id='12345678-1234-1234-1234-123456789abc';assert.equal(verifySignature(id,signature(id,key),key),true);assert.equal(verifySignature(id,signature(id,'2'.repeat(64)),key),false);assert.equal(verifySignature('bad','bad',key),false);
});
test('streaming reader processes a 70 MB Excel workbook with more than 20,000 rows',async t=>{
  const folder=await temp(t),filename=path.join(folder,'large.xlsx');largeXlsx(filename,25001,70);assert.ok((await fsp.stat(filename)).size>70*1024*1024);
  let total=0,largestBatch=0,last;const sheets=[];
  await readLargeWorkbook(filename,async sheet=>sheets.push(sheet),async(key,rows)=>{total+=rows.length;largestBatch=Math.max(largestBatch,rows.length);last=rows.at(-1);});
  assert.equal(total,25002);assert.equal(sheets[0].name,'Invoices');assert.equal(last.v[0],'INV-25001');assert.ok(largestBatch<2000);
});
test('an Excel error in a summary is reported per worksheet and valid worksheets remain readable',async t=>{
  const folder=await temp(t),filename=path.join(folder,'summary-error.xlsx');largeXlsx(filename,3,0,true);const sheets=[],failures=[];let rows=0;
  await readLargeWorkbook(filename,async sheet=>sheets.push(sheet),async(key,chunk)=>{assert.equal(key,'1');rows+=chunk.length;},async()=>{},async(key,message)=>failures.push({key,message}));
  assert.equal(failures.length,1);assert.equal(failures[0].key,'0');assert.match(failures[0].message,/Excel error/);assert.equal(sheets[1].name,'Invoices');assert.equal(rows,4);
  await assert.rejects(()=>readLargeWorkbook(filename,async()=>{},async()=>{}),/Excel error/);
});
test('staging removes partial error worksheets and rejects selecting them for import',async t=>{
  const folder=await temp(t),filename=path.join(folder,'source.xlsx');largeXlsx(filename,3,0,true);
  const {unzipSync,zipSync,strToU8}=require('fflate');const entries=unzipSync(await fsp.readFile(filename));
  entries['xl/worksheets/summary.xml']=strToU8('<worksheet><sheetData>'+Array.from({length:1200},(_,i)=>`<row r="${i+1}"><c r="A${i+1}" t="inlineStr"><is><t>Summary row ${i}</t></is></c></row>`).join('')+'<row r="1201"><c r="A1201" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>');await fsp.writeFile(filename,zipSync(entries));
  const db=await openDatabase({url:'',filename:':memory:'});t.after(()=>db.close());const user=await createUser(db,{email:'worksheet@example.com',name:'Worksheet Admin',password,role:'admin',mustChange:false});
  const service=createBulkImport({db,env:{ONEDRIVE_TOKEN_KEY:key},enqueue:async()=>{},onedrive:{sourceFile:async()=>({name:'source.xlsx',size:1000}),downloadTo:async(id,target)=>fsp.copyFile(filename,target)}});
  const job=await service.start(user,'source-file','http://localhost');await service.run(job.id);const prepared=await service.get(user,job.id);
  assert.equal(prepared.status,'ready');assert.match(prepared.info.sheets[0].error,/Excel error/);assert.equal(prepared.info.sheets[0].rowCount,0);assert.equal((await db.query('SELECT * FROM import_chunks WHERE job_id=$1 AND sheet_key=$2',[job.id,'0'])).length,0);
  const input={jobId:job.id,sheetKey:'0',type:'invoices',mapping:{id:0,customer:1,date:2,amount:3},startRow:2,dateFormat:'iso'};await assert.rejects(()=>service.project(user,input),/worksheet is unavailable/);
  const projected=await service.project(user,{...input,sheetKey:'1'});assert.equal(prepareImport(projected,emptyState()).counts.added,3);
});
test('large financial states round-trip in compressed storage and validate 25,001 invoices',()=>{
  const state=emptyState();state.invoices=Array.from({length:25001},(_,i)=>({id:`INV-${i}`,customer:'Acme',date:'2026-11-03',amount:100}));
  const valid=validateState(state),encoded=encodeState(valid);assert.ok(encoded.startsWith('gzip:'));assert.equal(decodeState(encoded).invoices.length,25001);
  const preview=prepareImport({type:'customerTerms',bulk:true,rows:[['Acme',60]],mapping:{customer:0,creditDays:1},startRow:2},valid);assert.equal(preview.state.customerTerms[0].creditDays,60);
});
for(const engine of ['sqlite','postgres'])test(`bulk staging is private, resumable, cancellable and separate from financial saves [${engine}]`,async t=>{
  let db;
  if(engine==='postgres'){const {PGlite}=require('@electric-sql/pglite');const pg=await PGlite.create();await pg.exec(postgresSchema('reconcileiq'));db={kind:'postgres',query:async(sql,p=[])=> (await pg.query(qualifySql(sql,'reconcileiq'),p)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,p=[])=> (await tx.query(qualifySql(sql,'reconcileiq'),p)).rows)),close:()=>pg.close()};await initialize(db);}else db=await openDatabase({url:'',filename:':memory:'});t.after(()=>db.close());
  const user=await createUser(db,{email:'bulk@example.com',name:'Bulk Admin',password,role:'admin',mustChange:false});let downloads=0;const queued=[];
  const service=createBulkImport({db,env:{ONEDRIVE_TOKEN_KEY:key},enqueue:async id=>queued.push(id),onedrive:{sourceFile:async()=>({name:'source.csv',size:70*1024*1024}),downloadTo:async(id,filename)=>{downloads++;await fsp.writeFile(filename,'Invoice,Customer,Date,Amount\nINV-1,Acme,2026-11-03,100\nINV-2,Acme,2026-11-03,200');}}});
  const job=await service.start(user,'source-file','http://localhost');assert.equal(queued[0],job.id);assert.equal((await service.get(user,job.id)).status,'queued');
  await assert.rejects(()=>service.get({id:'another-user'},job.id),/unavailable/);
  await assert.rejects(()=>service.start(user,'source-file','http://localhost'),/Another bulk import/);
  await service.run(job.id);assert.equal((await service.get(user,job.id)).status,'ready');assert.equal((await service.get(user,job.id)).info.sheets[0].rowCount,3);
  const [workspace]=await db.query('SELECT revision,data FROM workspace WHERE id=1');assert.equal(workspace.revision,0);assert.equal(JSON.parse(workspace.data).invoices.length,0);
  const projected=await service.project(user,{jobId:job.id,sheetKey:'0',type:'invoices',mapping:{id:0,customer:1,date:2,amount:3},startRow:2,dateFormat:'iso'});assert.equal(projected.rows.length,2);assert.deepEqual(projected.sourceRows,[2,3]);assert.equal(prepareImport(projected,emptyState()).counts.added,2);
  await db.transaction(query=>service.imported(query,user,job.id));assert.equal((await service.get(user,job.id)).status,'imported');assert.equal((await db.query('SELECT * FROM import_chunks')).length,0);
  await assert.rejects(()=>service.project(user,{jobId:job.id}),/already imported/);
  const cancelled=await service.start(user,'source-file','http://localhost');await service.cancel(user,cancelled.id);await service.run(cancelled.id);assert.equal(downloads,1);
  await db.query('UPDATE import_jobs SET expires_at=$1 WHERE id=$2',['2000-01-01T00:00:00.000Z',job.id]);await assert.rejects(()=>service.get(user,job.id),/expired/);
});
