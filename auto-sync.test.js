const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');
const {openDatabase,postgresSchema,qualifySql,initialize}=require('./lib/database');const {createUser}=require('./lib/auth');
const {createAutoSync,signRun,verifyRun}=require('./lib/auto-sync');const {emptyState}=require('./lib/state');const {decodeState}=require('./lib/state-codec');
const config={name:'bank.csv',sheetName:'CSV',type:'bank',mapping:{ref:3,date:1,amount:4,customer:5,narration:2,bankName:0},startRow:2,dateFormat:'iso',invoiceRows:'single',headers:['Bank','Date','Narration','Transaction ID','Amount','Customer Name']};
const header=config.headers.join(',');const row=(ref,amount=100,buyer='Buyer')=>`ICICI,2026-11-04,NEFT transfer,${ref},${amount},${buyer}`;
async function fixture(t,engine){
  let db;if(engine==='postgres'){const {PGlite}=require('@electric-sql/pglite');const pg=await PGlite.create();await pg.exec(postgresSchema('reconcileiq'));db={kind:'postgres',query:async(sql,p=[])=> (await pg.query(qualifySql(sql,'reconcileiq'),p)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,p=[])=> (await tx.query(qualifySql(sql,'reconcileiq'),p)).rows)),close:()=>pg.close()};await initialize(db);}else db=await openDatabase({url:'',filename:':memory:'});t.after(()=>db.close());
  const user=await createUser(db,{email:'sync@example.com',name:'Sync admin',password:'Safe-sync-test-password',role:'admin',mustChange:false});
  let contents=header+'\n'+row('SYNC-1'),tag='v1',downloads=0;const queued=[];
  const bulk={get:async()=>({status:'ready',file_id:'file-test',info:{name:'bank.csv',sheets:[{key:'0',name:'CSV',rows:[config.headers]}]}}),project:async(user,input)=>({...input,rows:[['ICICI','2026-11-04','NEFT transfer','SYNC-1',100,'Buyer']],bulk:true})};
  const service=createAutoSync({db,bulk,env:{ONEDRIVE_TOKEN_KEY:'1'.repeat(64)},enqueue:async id=>queued.push(id),onedrive:{sourceFile:async()=>({name:'bank.csv',cTag:tag}),downloadTo:async(id,filename)=>{downloads++;await fs.writeFile(filename,contents);}}});
  await db.query('INSERT INTO sync_sources(id,user_id,file_id,config,version,next_run_at) VALUES($1,$2,$3,$4,$5,$6)',['source-test',user.id,'file-test',JSON.stringify(config),'version-1','2000-01-01']);
  const due=()=>db.query('UPDATE sync_sources SET next_run_at=$1 WHERE id=$2',['2000-01-01','source-test']);
  const run=async()=>{await due();await service.dispatch('http://localhost');await service.run(queued.at(-1));};
  const state=async()=>decodeState((await db.query('SELECT data FROM workspace WHERE id=1'))[0].data);
  return {db,user,service,queued,due,run,state,change:(text,nextTag)=>{contents=text;tag=nextTag;},downloads:()=>downloads};
}
test('automatic sync signatures cannot be replayed as bulk-import signatures',()=>{
  const id=require('node:crypto').randomUUID(),key='1'.repeat(64);assert.equal(verifyRun(id,signRun(id,key),key),true);assert.equal(verifyRun(id,require('./lib/bulk-import').signature(id,key),key),false);assert.equal(verifyRun(id,'invalid',key),false);
});
for(const engine of ['sqlite','postgres']){
  test(`editors manage automatic sync and buyer-group editors sync only approved customer rows [${engine}]`,async t=>{
    const f=await fixture(t,engine);const initial=emptyState();initial.invoices=[{id:'PRIVATE',customer:'Other',date:'2026-11-01',amount:300}];initial.buyerGroups=[{id:'G',name:'Buyer group',customers:['Buyer']}];await f.db.query('UPDATE workspace SET data=$1 WHERE id=1',[JSON.stringify(initial)]);
    const editor=await createUser(f.db,{email:'scoped-sync@example.com',name:'Editor',password:'Safe-sync-test-password',role:'editor',mustChange:false,buyerGroupIds:['G']});
    f.change(header+'\n'+row('OWN',100,'Buyer')+'\n'+row('PRIVATE-RECEIPT',200,'Other'),'v2');
    await assert.rejects(()=>f.service.save(editor,{jobId:'test',type:'bank'},'http://localhost'),/approved mapping/);
    const saved=await f.service.save(editor,{approvedSourceId:'source-test'},'http://localhost');await f.service.run(f.queued.at(-1));
    const state=await f.state();assert.equal(state.bank.length,1);assert.equal(state.bank[0].ref,'OWN');assert.equal(state.invoices[0].id,'PRIVATE');
    const listing=await f.service.list(editor);assert.equal(listing.sources.length,1);assert.equal(listing.sources[0].id,saved.id);assert.equal(listing.templates.length,1);assert.equal(listing.runs[0].summary.counts.added,1);assert.ok(!JSON.stringify(listing).includes('PRIVATE-RECEIPT'));
    await assert.rejects(()=>f.service.control(editor,'source-test','pause','http://localhost'),/only your buyer-group/);
    await f.service.control(editor,saved.id,'pause','http://localhost');await f.service.control(editor,saved.id,'resume','http://localhost');await f.service.run(f.queued.at(-1));assert.equal((await f.state()).bank.length,1);
    const expanded=await f.state();expanded.buyerGroups[0].customers.push('Other');await f.db.query('UPDATE workspace SET data=$1 WHERE id=1',[JSON.stringify(expanded)]);
    await f.db.query('UPDATE sync_sources SET next_run_at=$1 WHERE id=$2',['2000-01-01',saved.id]);await f.service.dispatch('http://localhost',saved.id);await f.service.run(f.queued.at(-1));assert.equal((await f.state()).bank.length,2);
    const narrowed=await f.state();narrowed.buyerGroups[0].customers=['Buyer'];await f.db.query('UPDATE workspace SET data=$1 WHERE id=1',[JSON.stringify(narrowed)]);assert.equal((await f.service.list(editor)).runs.some(r=>r.summary.counts?.added===1 && r.summary.scopedHash!==(listing.runs[0].summary.scopedHash)),false);
    await f.db.query('UPDATE app_users SET role=$1 WHERE id=$2',['editor',f.user.id]);assert.equal((await f.service.list(f.user)).sources.length,2);await f.service.control(f.user,'source-test','run','http://localhost');await f.service.run(f.queued.at(-1));assert.equal((await f.state()).bank.length,2);
    await f.db.query('UPDATE sync_sources SET version=$1 WHERE id=$2',['changed','source-test']);await f.service.control(editor,saved.id,'run','http://localhost');await f.service.run(f.queued.at(-1));assert.match((await f.service.list(editor)).runs[0].error,/approved mapping changed/);
  });
  test(`saving sync mappings validates fields, reuses the file mapping and invalidates stale versions [${engine}]`,async t=>{
    const f=await fixture(t,engine);const input={jobId:'test-job',sheetKey:'0',...config,mapping:{...config.mapping,unknownField:99999999}};
    const saved=await f.service.save(f.user,input,'http://localhost');assert.equal(saved.id,'source-test');
    assert.equal((await f.service.list(f.user)).sources.length,1);assert.equal((await f.service.list(f.user)).sources[0].config.mapping.unknownField,undefined);
    await f.service.run(f.queued.at(-1));assert.equal((await f.state()).bank.length,1);
    await assert.rejects(()=>f.service.save(f.user,{...input,type:'advice'},'http://localhost'),/stable document/);
    await assert.rejects(()=>f.service.save(f.user,{...input,mapping:{date:1,amount:4,customer:5}},'http://localhost'),/Map Bank reference/);
  });
  test(`automatic bank sync imports new rows, skips duplicate files and reviews changes without overwriting allocations [${engine}]`,async t=>{
    const f=await fixture(t,engine);await f.run();assert.equal((await f.state()).bank.length,1);assert.equal((await f.service.list(f.user)).runs[0].status,'success');
    await f.run();assert.equal(f.downloads(),1);assert.equal((await f.db.query('SELECT revision FROM workspace WHERE id=1'))[0].revision,1);
    f.change(header+'\n'+row('SYNC-1',200)+'\n'+row('SYNC-2',50),'v2');await f.run();
    const state=await f.state();assert.equal(state.bank.length,2);assert.equal(state.bank.find(r=>r.ref==='SYNC-1').amount,100);
    const last=(await f.service.list(f.user)).runs[0];assert.equal(last.status,'review');assert.equal(last.summary.counts.review,1);assert.equal(last.summary.counts.added,1);assert.equal(last.summary.reviews[0].identifier,'SYNC-1');
    assert.equal(last.summary.reviews[0].changes[0].source,200);await f.run();assert.equal((await f.state()).bank.length,2);
  });
  test(`sync rejects shifted headers and invalid rows, retains removed records and checks fresh admin access [${engine}]`,async t=>{
    const f=await fixture(t,engine);await f.run();f.change(header.replace('Narration','Different header')+'\n'+row('SYNC-2'),'v2');await f.run();
    assert.equal((await f.state()).bank.length,1);assert.match((await f.service.list(f.user)).runs[0].error,/headers changed/);
    f.change(header+'\n'+row('SYNC-2',0),'v3');await f.run();assert.equal((await f.state()).bank.length,1);assert.equal((await f.service.list(f.user)).runs[0].status,'failed');
    f.change(header+'\n'+row('SYNC-2',50),'v4');await f.run();assert.equal((await f.state()).bank.length,2);
    await f.db.query('UPDATE app_users SET role=$1 WHERE id=$2',['viewer',f.user.id]);f.change(header+'\n'+row('SYNC-3'),'v5');await f.run();assert.equal((await f.state()).bank.length,2);await assert.rejects(()=>f.service.list(f.user),/no longer has access/);assert.match((await f.db.query('SELECT error FROM sync_runs ORDER BY created_at DESC LIMIT 1'))[0].error,/no longer has access/);
  });
  test(`sync queue leases, pause and version checks prevent duplicate or cancelled commits [${engine}]`,async t=>{
    const f=await fixture(t,engine);await f.service.dispatch('http://localhost');
    assert.equal(Date.parse((await f.db.query('SELECT next_run_at FROM sync_sources'))[0].next_run_at)%900000,0);
    await f.due();await f.service.dispatch('http://localhost');assert.equal(f.queued.length,1);
    await f.service.control(f.user,'source-test','pause','http://localhost');await f.service.run(f.queued[0]);assert.equal((await f.state()).bank.length,0);
    await f.db.query('UPDATE sync_sources SET lease_until=$1 WHERE id=$2',['','source-test']);await f.service.control(f.user,'source-test','resume','http://localhost');await f.service.run(f.queued.at(-1));await f.service.run(f.queued.at(-1));assert.equal((await f.state()).bank.length,1);
    assert.equal((await f.db.query('SELECT revision FROM workspace WHERE id=1'))[0].revision,1);
  });
}
