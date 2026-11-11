const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { openDatabase, postgresSchema, qualifySql, initialize } = require('./lib/database');
const { createUser, digest } = require('./lib/auth');
const { emptyState, validateState } = require('./lib/state');
const { createApplication } = require('./server');
const password = 'A-long-test-password-2026';

function integrationTest(name, fn) {
  for (const engine of ['sqlite','postgres']) test(`${name} [${engine}]`, t => fn(t, engine));
}
async function fixture(t, engine) {
  let db;
  if(engine === 'postgres') {
    const {PGlite} = require('@electric-sql/pglite');
    const pg = await PGlite.create();
    await pg.exec(postgresSchema('reconcileiq'));
    db = {kind:'postgres', query:async(sql,params=[]) => (await pg.query(qualifySql(sql,'reconcileiq'),params)).rows,
      transaction:fn=>pg.transaction(tx=>fn(async(sql,params=[]) => (await tx.query(qualifySql(sql,'reconcileiq'),params)).rows)), close:()=>pg.close()};
    await initialize(db);
  } else db = await openDatabase({url:'',filename:':memory:'});
  const admin = await createUser(db,{email:'admin@example.com',name:'Admin',password,role:'admin',mustChange:false});
  const {server} = await createApplication({db,production:false,skipBootstrap:true});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
  async function request(route, method='GET', data, session, overrides={}) {
    const response=await fetch(base+route,{
      method,headers:{Origin:base,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...overrides},
      ...(data===undefined?{}:{body:JSON.stringify(data)}),
    });
    const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}
    return {status:response.status,body,headers:response.headers};
  }
  async function login(email='admin@example.com', pass=password) {
    const result=await request('/api/login','POST',{email,password:pass});
    assert.equal(result.status,200,JSON.stringify(result.body));
    return {...result.body,cookie:result.headers.get('set-cookie').split(';')[0]};
  }
  return {db,admin,request,login,base};
}

integrationTest('automatic sync history and controls allow editors and require CSRF',async(t,engine)=>{
  const {request,login,db,admin:owner}=await fixture(t,engine);const admin=await login();
  assert.equal((await request('/api/sync-sources')).status,401);
  assert.equal((await request('/api/sync-sources','GET',undefined,admin)).status,200);
  assert.equal((await request('/api/sync-sources','POST',{},admin,{'X-CSRF-Token':'wrong'})).status,403);
  await db.query('UPDATE app_users SET role=$1 WHERE id=$2',['editor',owner.id]);
  assert.equal((await request('/api/sync-sources','GET',undefined,admin)).status,200);
  assert.equal((await request('/api/sync-sources','POST',{},admin)).status,400);
});
integrationTest('editors can import advice and debit notes but cannot import other registers or manage connections or deletions',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const user=await createUser(db,{email:'import-editor@example.com',name:'Editor',password,role:'editor',mustChange:false});const editor=await login(user.email);
  const state=emptyState();state.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:1000}];state.bank=[{ref:'U',customer:'Buyer',date:'2026-11-02',amount:100,status:'unmatched'}];
  await db.query('UPDATE workspace SET data=$1 WHERE id=1',[JSON.stringify(state)]);
  const definitions=await request('/api/import/definitions','GET',undefined,editor);assert.equal(definitions.status,200);assert.ok(definitions.body.definitions.advice);assert.ok(definitions.body.definitions.debitNotes);
  const advice={type:'advice',rows:[['Buyer','I','Payment',50,'Receipt','U']],mapping:{customer:0,invoice:1,type:2,amount:3,description:4,utr:5},startRow:2,dateFormat:'iso'};
  const preview=await request('/api/import/preview','POST',advice,editor);assert.equal(preview.status,200);assert.equal(preview.body.canImport,true);
  assert.equal((await request('/api/import','POST',{...advice,revision:0},editor,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await request('/api/import','POST',{...advice,revision:0},editor)).status,200);
  const debit={type:'debitNotes',rows:[['D','Buyer','2026-11-03',25,'I','EPC']],mapping:{id:0,customer:1,date:2,amount:3,invoice:4,type:5},startRow:2,dateFormat:'iso'};
  assert.equal((await request('/api/import/preview','POST',debit,editor)).status,200);assert.equal((await request('/api/import','POST',{...debit,revision:1},editor)).status,200);
  for(const type of ['invoices','bank','returns','customerTerms']){
    assert.equal((await request('/api/import/preview','POST',{...debit,type},editor)).status,403);
    assert.equal((await request('/api/import','POST',{...debit,type,revision:2},editor)).status,403);
  }
  assert.equal((await request('/api/import-jobs','GET',undefined,editor)).status,200);
  for(const route of ['/api/onedrive/connect','/api/onedrive/disconnect','/api/records/delete'])assert.equal((await request(route,'POST',{},editor)).status,403);
  await db.query('UPDATE app_users SET role=$1 WHERE id=$2',['viewer',user.id]);
  assert.equal((await request('/api/import/preview','POST',advice,editor)).status,403);assert.equal((await request('/api/import-jobs','GET',undefined,editor)).status,403);
  assert.equal((await db.query('SELECT revision FROM workspace WHERE id=1'))[0].revision,2);
});
integrationTest('DN CN workflow persists editor updates, derives settlement and blocks cross-buyer invoice links',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine),admin=await login(),state=emptyState();state.invoices=[{id:'I-DN',customer:'Buyer',date:'2026-11-01',amount:5000},{id:'I-OTHER',customer:'Other',date:'2026-11-01',amount:5000}];
  assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const user=await createUser(db,{email:'dn-editor@example.com',name:'Editor',password,role:'editor',mustChange:false}),editor=await login(user.email);
  const draft=(await request('/api/state','GET',undefined,editor)).body;draft.state.debitNotes.push({id:'DN-NEW',customer:'Buyer',customerCode:'C001',date:'2026-11-11',invoice:'I-DN',amount:1000,type:'EPC',settlementMode:'creditNote',creditNoteNumber:'',creditNoteAmount:0,status:'Settled'});
  const created=await request('/api/state','PUT',draft,editor);assert.equal(created.status,200);assert.equal(created.body.state.debitNotes[0].status,'Unsettled');assert.equal(require('./finance').debitNote(created.body.state.debitNotes[0]).difference,1000);
  const cn=structuredClone(created.body);cn.state.debitNotes[0].creditNoteNumber='CN-NEW';cn.state.debitNotes[0].creditNoteAmount=700;cn.state.debitNotes[0].status='Unsettled';const saved=await request('/api/state','PUT',cn,editor);assert.equal(saved.status,200);assert.equal(saved.body.state.debitNotes[0].status,'Settled');assert.equal(require('./finance').debitNote(saved.body.state.debitNotes[0]).difference,300);
  const foreign=structuredClone(saved.body);foreign.state.debitNotes[0].invoice='I-OTHER';assert.equal((await request('/api/state','PUT',foreign,editor)).status,400);
  assert.equal((await request('/api/records/delete','POST',{collection:'debitNotes',index:0,identifier:'DN-NEW',revision:saved.body.revision},editor)).status,403);
});

integrationTest('customer opening balances persist, allocate partially, enforce buyer scope and retain admin-only deletion',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine),admin=await login();const state=emptyState();
  state.invoices=[{id:'OB-TEST',recordType:'openingBalance',customer:'Alpha',date:'2026-04-01',openingDueDate:'2026-03-01',openingReference:'Earlier dues',amount:1000}];
  state.bank=[{ref:'U-TEST',customer:'Alpha',date:'2026-11-01',amount:1000,status:'unmatched'}];state.buyerGroups=[{id:'G',name:'Assigned',customers:['Alpha']}];
  assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const user=await createUser(db,{email:'opening-editor@example.com',name:'Editor',password,role:'editor',mustChange:false,buyerGroupIds:['G']}),editor=await login(user.email);
  const current=(await request('/api/state','GET',undefined,editor)).body;assert.equal(current.state.invoices[0].openingDueDate,'2026-03-01');
  current.state.advice.push({id:'PA',customer:'Alpha',date:'2026-11-01',invoice:'OB-TEST',amount:600,type:'Payment',utr:'U-TEST',description:'Earlier dues'});
  const saved=await request('/api/state','PUT',current,editor);assert.equal(saved.status,200);assert.equal(require('./finance').rows(saved.body.state)[0].pendingToMatch,400);
  const forged=structuredClone(saved.body);forged.state.invoices.push({...state.invoices[0],id:'OB-FOREIGN',customer:'Other'});assert.equal((await request('/api/state','PUT',forged,editor)).status,403);
  assert.equal((await request('/api/records/delete','POST',{collection:'invoices',index:0,identifier:'OB-TEST',revision:2},editor)).status,403);
  assert.equal((await request('/api/records/delete','POST',{collection:'invoices',index:0,identifier:'OB-TEST',revision:2},admin)).status,409);
  const removed=structuredClone(saved.body);removed.state.invoices=[];removed.state.advice=[];assert.equal((await request('/api/state','PUT',removed,editor)).status,403);
  const edited=structuredClone(saved.body);edited.state.invoices[0].amount=1200;edited.state.invoices[0].openingDueDate='2026-02-01';edited.state.invoices[0].openingReference='Corrected earlier dues';
  assert.equal((await request('/api/state','PUT',edited,editor)).status,403);
  const changed=await request('/api/state','PUT',edited,admin);assert.equal(changed.status,200);assert.equal(changed.body.state.invoices[0].id,'OB-TEST');assert.equal(changed.body.state.invoices[0].amount,1200);assert.equal(changed.body.state.advice[0].invoice,'OB-TEST');assert.equal(require('./finance').rows(changed.body.state)[0].pendingToMatch,400);
  const wrongCustomer=structuredClone(changed.body);wrongCustomer.state.invoices[0].customer='Other';assert.equal((await request('/api/state','PUT',wrongCustomer,admin)).status,400);
  const comment=structuredClone(changed.body);comment.state.invoices[0].remarks='Editor follow-up';assert.equal((await request('/api/state','PUT',comment,editor)).status,200);
  const conversion=structuredClone(changed.body);conversion.state.invoices[0].recordType='invoice';delete conversion.state.invoices[0].openingDueDate;delete conversion.state.invoices[0].openingReference;conversion.revision=4;assert.equal((await request('/api/state','PUT',conversion,editor)).status,403);
});
test('opening balance validation rejects missing or invalid due dates and invalid receivable types',()=>{
  const state=emptyState();state.invoices=[{id:'OB',recordType:'openingBalance',customer:'Alpha',date:'2026-04-01',openingDueDate:'2026-03-01',amount:1000}];assert.equal(validateState(state).invoices[0].recordType,'openingBalance');
  for(const openingDueDate of [undefined,'2026-02-31','not-a-date']){const invalid=structuredClone(state);invalid.invoices[0].openingDueDate=openingDueDate;assert.throws(()=>validateState(invalid));}
  state.invoices[0].recordType='other';assert.throws(()=>validateState(state),/receivable type/);
});
integrationTest('buyer groups persist through old clients and imports, validate members and restrict group deletion to admins',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();const user=await createUser(db,{email:'group-editor@example.com',name:'Editor',password,role:'editor',mustChange:false});const editor=await login(user.email);
  const state=emptyState();state.buyerGroups=[{id:'GROUP',name:'Group',customers:['Alpha','Beta']}];
  const saved=await request('/api/state','PUT',{state,revision:0},admin);assert.equal(saved.status,200);assert.equal(saved.body.state.buyerGroups[0].customers.length,2);
  const legacy=structuredClone(saved.body.state);delete legacy.buyerGroups;
  assert.equal((await request('/api/state','PUT',{state:legacy,revision:1},editor)).body.state.buyerGroups.length,1);
  const removed=structuredClone(saved.body.state);removed.buyerGroups=[];assert.equal((await request('/api/state','PUT',{state:removed,revision:2},editor)).status,403);
  for(const customers of [['Alpha',' alpha '],[{customer:'Alpha'}],['<unsafe>']]){const invalid=structuredClone(saved.body.state);invalid.buyerGroups[0].customers=customers;assert.equal((await request('/api/state','PUT',{state:invalid,revision:2},editor)).status,400);}
  const imported=await request('/api/import','POST',{type:'invoices',rows:[['I','Alpha','2026-11-04',100]],mapping:{id:0,customer:1,date:2,amount:3},startRow:2,dateFormat:'iso',revision:2},admin);assert.equal(imported.status,200);assert.equal(imported.body.state.buyerGroups.length,1);
  const final=structuredClone(imported.body.state);final.buyerGroups=[];assert.equal((await request('/api/state','PUT',{state:final,revision:3},admin)).status,200);assert.equal((await db.query('SELECT revision FROM workspace WHERE id=1'))[0].revision,4);
});
integrationTest('buyer-group assignments limit reads, writes and imports, preserve other customers and revoke stale sessions',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();const state=emptyState();
  state.invoices=['Alpha','Beta','Other'].map((customer,i)=>({id:'I'+i,customer,date:'2026-11-01',amount:100*(i+1)}));state.bank=state.invoices.map(i=>({ref:'U'+i.id,customer:i.customer,date:'2026-11-02',amount:i.amount,status:'unmatched'}));
  state.buyerGroups=[{id:'G1',name:'Buyer 1',customers:['Alpha','Beta']},{id:'G2',name:'Buyer 2',customers:['Other']}];state.logs=[{event:'Private other-customer activity',detail:'Other',time:'now',kind:'ok'}];
  assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const viewerUser=await createUser(db,{email:'scoped-viewer@example.com',name:'Scoped viewer',password,role:'viewer',mustChange:false,buyerGroupIds:['G2']});const scopedViewer=await login(viewerUser.email);
  assert.equal((await request('/api/state','GET',undefined,scopedViewer)).body.state.invoices.length,1);assert.equal((await request('/api/state','PUT',{state,revision:1},scopedViewer)).status,403);
  const user=await createUser(db,{email:'scoped-editor@example.com',name:'Scoped',password,role:'editor',mustChange:false,buyerGroupIds:['G1']});let scoped=await login(user.email);
  let view=await request('/api/state','GET',undefined,scoped);assert.equal(view.body.state.invoices.length,2);assert.equal(view.body.state.bank.length,2);assert.equal(view.body.state.buyerGroups.length,1);assert.equal(view.body.state.logs.length,0);assert.ok(!JSON.stringify(view.body.state).includes('Other'));
  view.body.state.invoices[0].amount=125;view.body.state.invoices[0].remarks='Follow up with customer';let saved=await request('/api/state','PUT',{state:view.body.state,revision:1},scoped);assert.equal(saved.status,200);assert.equal(saved.body.state.invoices.length,2);assert.equal(saved.body.state.invoices[0].remarks,'Follow up with customer');
  const whole=await request('/api/state','GET',undefined,admin);assert.equal(whole.body.state.invoices.find(i=>i.customer==='Other').amount,300);
  const forged=structuredClone(saved.body.state);forged.invoices.push({id:'FORGED',customer:'Other',date:'2026-11-01',amount:1});assert.equal((await request('/api/state','PUT',{state:forged,revision:2},scoped)).status,403);
  const expanded=structuredClone(saved.body.state);expanded.buyerGroups[0].customers.push('Other');assert.equal((await request('/api/state','PUT',{state:expanded,revision:2},scoped)).status,403);
  for(const route of ['/api/onedrive/files','/api/import-jobs','/api/backup','/api/users'])assert.equal((await request(route,'GET',undefined,scoped)).status,403);
  const csv=Buffer.from('Customer name,Invoice number,Transaction type,Amount,Transaction description,UTR\nAlpha,I0,Payment,10,Receipt,UI0').toString('base64');assert.equal((await request('/api/import/file','POST',{name:'advice.csv',data:csv},scoped)).status,200);
  const debit={type:'debitNotes',mapping:{id:0,customer:1,date:2,amount:3,type:4},rows:[['D','Other','2026-11-04',10,'EPC']],startRow:2,dateFormat:'iso'};
  assert.equal((await request('/api/import/preview','POST',debit,scoped)).status,403);debit.rows[0][1]='Alpha';assert.equal((await request('/api/import/preview','POST',debit,scoped)).status,200);
  const imported=await request('/api/import','POST',{...debit,revision:2},scoped);assert.equal(imported.status,200);assert.ok(!JSON.stringify(imported.body.state).includes('Other'));
  assert.equal((await request(`/api/users/${user.id}`,'PATCH',{buyerGroupIds:['MISSING']},admin)).status,400);
  assert.equal((await request(`/api/users/${user.id}`,'PATCH',{buyerGroupIds:['G1','G2']},admin)).status,200);assert.equal((await request('/api/state','GET',undefined,scoped)).status,401);
  scoped=await login(user.email);assert.equal((await request('/api/state','GET',undefined,scoped)).body.state.invoices.length,3);
  const updated=(await request('/api/state','GET',undefined,admin)).body;updated.state.buyerGroups[0].customers=['Alpha'];assert.equal((await request('/api/state','PUT',updated,admin)).status,200);assert.equal((await request('/api/state','GET',undefined,scoped)).status,401);
  scoped=await login(user.email);assert.equal((await request('/api/state','GET',undefined,scoped)).body.state.invoices.length,2);
  assert.equal((await request(`/api/users/${user.id}`,'PATCH',{buyerGroupIds:[]},admin)).status,200);scoped=await login(user.email);assert.equal((await request('/api/state','GET',undefined,scoped)).body.state.invoices.length,0);
});
integrationTest('bank customers are required on writes while unchanged legacy receipts remain usable',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();
  const state=emptyState();state.bank=[{ref:'OLD',date:'2026-11-01',amount:100,status:'unmatched'}];
  await db.query('UPDATE workspace SET data=$1 WHERE id=1',[JSON.stringify(state)]);
  assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const changed=structuredClone(state);changed.bank[0].narration='Changed';assert.equal((await request('/api/state','PUT',{state:changed,revision:1},admin)).status,400);
  const added=structuredClone(state);added.bank.push({...state.bank[0],ref:'NEW'});assert.equal((await request('/api/state','PUT',{state:added,revision:1},admin)).status,400);
  added.bank[1].customer='Acme';added.bank[1].narration='Receipt';added.bank[1].bankName='HDFC';
  const saved=await request('/api/state','PUT',{state:added,revision:1},admin);assert.equal(saved.status,200);assert.equal(saved.body.state.bank[1].bankName,'HDFC');
  delete added.bank[1].customer;assert.equal((await request('/api/state','PUT',{state:added,revision:2},admin)).status,400);
});
integrationTest('new advice requires invoice and description without blocking unchanged legacy advice',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();const state=emptyState();
  state.invoices=[{id:'INV',customer:'Acme',date:'2026-11-01',amount:100,code:'—',roundOff:0}];state.customerTerms=[{customer:'Acme',creditDays:45}];
  state.bank=[{ref:'UTR',customer:'Acme',date:'2026-11-01',amount:100,status:'unmatched'}];state.advice=[{id:'OLD',customer:'Acme',date:'2026-11-02',type:'Payment',amount:10,utr:'UTR'}];
  await db.query('UPDATE workspace SET data=$1 WHERE id=1',[JSON.stringify(state)]);
  assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const next=structuredClone(state);next.advice.push({...state.advice[0],id:'NEW',invoice:'INV',description:'Receipt'});
  for(const key of ['invoice','description']){const missing=structuredClone(next);delete missing.advice[1][key];assert.equal((await request('/api/state','PUT',{state:missing,revision:1},admin)).status,400);}
  assert.equal((await request('/api/state','PUT',{state:next,revision:1},admin)).status,200);
});
integrationTest('returns enforce invoice and type on new saves and preserve unchanged legacy records',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();const state=emptyState();
  state.invoices=[{id:'INV',customer:'Acme',date:'2026-11-01',amount:100,code:'—',roundOff:0}];state.customerTerms=[{customer:'Acme',creditDays:45}];
  state.returns=[{id:'OLD',customer:'Acme',date:'2026-11-02',amount:10}];await db.query('UPDATE workspace SET data=$1 WHERE id=1',[JSON.stringify(state)]);
  assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const next=structuredClone(state);next.returns.push({id:'NEW',customer:'Acme',date:'2026-11-03',amount:5,type:'Qty return',invoice:'INV'});
  for(const key of ['id','type','date','invoice','amount']){const missing=structuredClone(next);delete missing.returns[1][key];assert.equal((await request('/api/state','PUT',{state:missing,revision:1},admin)).status,400);}
  assert.equal((await request('/api/state','PUT',{state:next,revision:1},admin)).status,200);
});
integrationTest('return warnings allow importing valid rows and audit the skipped count',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();const state=emptyState();state.invoices=[{id:'INV',customer:'Acme',date:'2026-11-01',amount:100}];assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const input={type:'returns',rows:[['R1','sale return','2026-11-03','INV',10],['R2','price return','2026-11-03','UNKNOWN',5]],mapping:{id:0,type:1,date:2,invoice:3,amount:4},startRow:2};
  const preview=await request('/api/import/preview','POST',input,admin);assert.equal(preview.body.canImport,true);assert.equal(preview.body.errors.length,0);assert.equal(preview.body.warnings.length,1);assert.equal(preview.body.counts.unmatched,1);
  const saved=await request('/api/import','POST',{...input,revision:preview.body.revision},admin);assert.equal(saved.status,200);assert.equal(saved.body.state.returns.length,1);assert.equal(saved.body.state.priceReturns.length,0);
  const events=await db.query('SELECT detail FROM audit_events WHERE action=$1',['workspace.imported']);assert.equal(JSON.parse(events[0].detail).counts.unmatched,1);
});
integrationTest('historical backup restores preserve legacy records without weakening normal-entry requirements',async(t,engine)=>{
  const {request,login}=await fixture(t,engine);const admin=await login();const state=emptyState();state.invoices=[{id:'I',customer:'Acme',date:'2026-11-01',amount:100}];
  state.bank=[{ref:'OLD',date:'2026-11-01',amount:50,status:'unmatched'}];state.returns=[{id:'OLD-R',customer:'Acme',date:'2026-11-01',amount:5}];state.advice=[{id:'OLD-A',customer:'Acme',date:'2026-11-01',amount:10,utr:'OLD',type:'Payment'}];
  assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,400);const restored=await request('/api/restore','POST',{state,revision:0},admin);assert.equal(restored.status,200,JSON.stringify(restored.body));assert.equal(restored.body.state.bank.length,1);
  assert.equal((await request('/api/state','PUT',{state:restored.body.state,revision:1},admin)).status,200);
});
integrationTest('access is rechecked after request parsing and before financial or user writes',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const transaction=db.transaction;
  for(const route of ['/api/state','/api/users']){
    const admin=await login();db.transaction=async fn=>{await db.query('DELETE FROM app_sessions');return transaction(fn);};
    const payload=route==='/api/state'?{state:emptyState(),revision:0}:{email:'blocked@example.com',name:'Blocked',password,role:'editor'};
    const response=await request(route,route==='/api/state'?'PUT':'POST',payload,admin);db.transaction=transaction;assert.equal(response.status,403,JSON.stringify(response.body));
  }
  const [users]=await db.query('SELECT COUNT(*) AS count FROM app_users');assert.equal(Number(users.count),1);const [workspace]=await db.query('SELECT revision FROM workspace WHERE id=1');assert.equal(workspace.revision,0);
});
test('duplicate advice allocations cannot be counted twice while different classifications remain valid',()=>{
  const state=emptyState();state.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:100}];const row={id:'A',customer:'Buyer',date:'2026-11-01',amount:10,invoice:'I',utr:'U',type:'Payment'};state.advice=[row,{...row}];assert.throws(()=>validateState(state),/Duplicate payment advice/);state.advice[1].type='TDS';assert.equal(validateState(state).advice.length,2);
});
integrationTest('malformed revisions are rejected before reaching integer database columns',async(t,engine)=>{
  const {request,login}=await fixture(t,engine);const admin=await login();
  assert.equal((await request('/api/state','PUT',{state:emptyState(),revision:1e100},admin)).status,400);
  assert.equal((await request('/api/snapshots/999999999999999999999','GET',undefined,admin)).status,400);
});
integrationTest('bank receipt buyer must match advice and invoice on saves and imports',async(t,engine)=>{
  const {request,login}=await fixture(t,engine);const admin=await login(),state=emptyState();state.invoices=[{id:'F',customer:'Flipkart',date:'2026-11-01',amount:100},{id:'O',customer:'Other',date:'2026-11-01',amount:100}];state.bank=[{ref:'U',customer:'Flipkart',date:'2026-11-02',amount:100,status:'unmatched'}];assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const row={id:'A',customer:'Other',invoice:'O',date:'2026-11-03',type:'Payment',amount:10,description:'Receipt',utr:'U'};state.advice=[row];const wrong=await request('/api/state','PUT',{state,revision:1},admin);assert.equal(wrong.status,400);assert.match(wrong.body.error,/same buyer/);
  row.customer='flipkart';row.invoice='F';assert.equal((await request('/api/state','PUT',{state,revision:1},admin)).status,200);
  state.bank[0].customer='Other';assert.equal((await request('/api/state','PUT',{state,revision:2},admin)).status,400);
  const input={type:'advice',rows:[['Other','O','Payment',10,'Receipt','U']],mapping:{customer:0,invoice:1,type:2,amount:3,description:4,utr:5},startRow:2};const preview=await request('/api/import/preview','POST',input,admin);assert.equal(preview.body.canImport,false);assert.match(preview.body.errors[0].message,/same buyer/);assert.equal((await request('/api/import','POST',{...input,revision:2},admin)).status,400);
});
integrationTest('only admins delete entries, including through whole-workspace saves; deletions retain snapshots and audit',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();
  await createUser(db,{email:'delete-editor@example.com',name:'Editor',password,role:'editor',mustChange:false});await createUser(db,{email:'delete-viewer@example.com',name:'Viewer',password,role:'viewer',mustChange:false});const editor=await login('delete-editor@example.com'),viewer=await login('delete-viewer@example.com');
  const state=emptyState();state.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:100}];state.bank=[{ref:'U',customer:'Buyer',date:'2026-11-01',amount:100,status:'unmatched'}];state.debitNotes=[{id:'D',customer:'Buyer',date:'2026-11-01',amount:10,type:'EPC',status:'Unmapped'}];
  const saved=await request('/api/state','PUT',{state,revision:0},admin);assert.equal(saved.status,200);
  for(const [collection,identifier] of [['invoices','I'],['bank','U'],['debitNotes','D']]){
    for(const user of [editor,viewer])assert.equal((await request('/api/records/delete','POST',{collection,index:0,identifier,revision:1},user)).status,403);
    const removed=structuredClone(saved.body.state);removed[collection]=[];assert.equal((await request('/api/state','PUT',{state:removed,revision:1},editor)).status,403);
  }
  const edited=structuredClone(saved.body.state);edited.invoices[0].brandName='Updated';assert.equal((await request('/api/state','PUT',{state:edited,revision:1},editor)).status,200);
  assert.equal((await request('/api/records/delete','POST',{collection:'invoices',index:0,identifier:'I',revision:1},admin)).status,409);
  assert.equal((await request('/api/records/delete','POST',{collection:'invoices',index:0,identifier:'I',revision:2},admin,{'X-CSRF-Token':'wrong'})).status,403);
  let revision=2;for(const [collection,identifier] of [['invoices','I'],['bank','U'],['debitNotes','D']]){const deleted=await request('/api/records/delete','POST',{collection,index:0,identifier,revision},admin);assert.equal(deleted.status,200,JSON.stringify(deleted.body));assert.equal(deleted.body.state[collection].length,0);revision=deleted.body.revision;}
  const events=await db.query('SELECT detail FROM audit_events WHERE action=$1',['record.deleted']);assert.equal(events.length,3);assert.equal(JSON.parse(events[0].detail).deleted.collection,'invoices');
  const snapshot=await db.query('SELECT data FROM workspace_snapshots WHERE revision=2');assert.equal(JSON.parse(snapshot[0].data).invoices[0].id,'I');
});
integrationTest('linked entries must be removed first and deleted payment allocations reopen bank receipts',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login(),state=emptyState();state.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:100}];state.bank=[{ref:'U',customer:'Buyer',date:'2026-11-01',amount:100,status:'matched',advice:'A'}];state.advice=[{id:'A',customer:'Buyer',date:'2026-11-01',amount:100,invoice:'I',utr:'U',type:'Payment',description:'Receipt'}];state.returns=[{id:'R',customer:'Buyer',date:'2026-11-01',amount:10,invoice:'I',type:'Qty return'}];state.priceReturns=[{id:'P',customer:'Buyer',date:'2026-11-01',amount:5,invoice:'I',type:'Price return'}];state.debitNotes=[{id:'D',customer:'Buyer',date:'2026-11-01',amount:5,invoice:'I',type:'EPC',status:'Unmapped'}];assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  for(const [collection,identifier] of [['invoices','I'],['bank','U']]){const linked=await request('/api/records/delete','POST',{collection,index:0,identifier,revision:1},admin);assert.equal(linked.status,409);assert.match(linked.body.error,/linked/);}
  assert.equal((await request('/api/records/delete','POST',{collection:'bank',index:0,identifier:'OTHER',revision:1},admin)).status,409);
  assert.equal((await request('/api/records/delete','POST',{collection:'unsupported',index:0,identifier:'I',revision:1},admin)).status,400);
  let revision=1;for(const [collection,identifier] of [['advice','A'],['returns','R'],['priceReturns','P'],['debitNotes','D'],['invoices','I'],['bank','U']]){const removed=await request('/api/records/delete','POST',{collection,index:0,identifier,revision},admin);assert.equal(removed.status,200,JSON.stringify(removed.body));revision=removed.body.revision;if(collection==='advice'){assert.equal(removed.body.state.bank[0].status,'unmatched');assert.equal(removed.body.state.bank[0].advice,'');}}
  const [snapshot]=await db.query('SELECT data FROM workspace_snapshots WHERE revision=1');const restored=await request('/api/restore','POST',{state:JSON.parse(snapshot.data),revision},admin);assert.equal(restored.status,200);assert.equal(restored.body.state.invoices[0].id,'I');assert.equal(restored.body.state.advice.length,1);
});
integrationTest('EPC advice can be imported and deleted without changing cash or reopening a matched receipt',async(t,engine)=>{
  const {request,login}=await fixture(t,engine);const admin=await login(),state=emptyState();state.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:1000}];state.bank=[{ref:'U',customer:'Buyer',date:'2026-11-02',amount:900,status:'matched'}];state.advice=[{id:'P',customer:'Buyer',date:'2026-11-02',invoice:'I',type:'Payment',amount:900,utr:'U',description:'Cash receipt'}];assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const input={type:'advice',rows:[['Buyer','I','EPC',100,'EPC deduction','U']],mapping:{customer:0,invoice:1,type:2,amount:3,description:4,utr:5},startRow:2};const preview=await request('/api/import/preview','POST',input,admin);assert.equal(preview.body.canImport,true);const imported=await request('/api/import','POST',{...input,revision:1},admin);assert.equal(imported.status,200);assert.equal(imported.body.state.bank[0].amount,900);assert.equal(imported.body.state.advice[1].type,'EPC');
  const deleted=await request('/api/records/delete','POST',{collection:'advice',index:1,identifier:imported.body.state.advice[1].id,revision:2},admin);assert.equal(deleted.status,200);assert.equal(deleted.body.state.bank[0].status,'matched');assert.equal(deleted.body.state.bank[0].amount,900);assert.equal(deleted.body.state.advice[0].amount,900);
});
integrationTest('split invoice payments match incrementally and cannot exceed the bank cash balance',async(t,engine)=>{
  const {request,login}=await fixture(t,engine);const admin=await login(),state=emptyState();state.invoices=[{id:'I1',customer:'Buyer',date:'2026-11-01',amount:3000},{id:'I2',customer:'Buyer',date:'2026-11-01',amount:7000}];state.bank=[{ref:'U',customer:'Buyer',date:'2026-11-01',amount:10000,status:'unmatched'}];
  const payment=(id,invoice,amount)=>({id,invoice,amount,customer:'Buyer',date:'2026-11-01',utr:'U',type:'Payment',description:'Split receipt'});state.advice=[payment('P1','I1',3000)];let saved=await request('/api/state','PUT',{state,revision:0},admin);assert.equal(saved.status,200);assert.equal(saved.body.state.bank[0].status,'review');assert.equal(require('./finance').rows(saved.body.state)[0].pendingToMatch,7000);
  state.advice.push(payment('P2','I2',4000));saved=await request('/api/state','PUT',{state,revision:1},admin);assert.equal(saved.status,200);assert.equal(require('./finance').rows(saved.body.state)[0].pendingToMatch,3000);
  state.advice.push(payment('P3','I2',3000));saved=await request('/api/state','PUT',{state,revision:2},admin);assert.equal(saved.status,200);assert.equal(saved.body.state.bank[0].status,'matched');assert.equal(require('./finance').rows(saved.body.state)[0].allocatedAmount,10000);
  state.advice.push(payment('EXTRA','I2',0.01));const excess=await request('/api/state','PUT',{state,revision:3},admin);assert.equal(excess.status,400);assert.match(excess.body.error,/exceed/);assert.equal((await request('/api/state','GET',undefined,admin)).body.state.advice.length,3);
  const input={type:'advice',rows:[['Buyer','I2','Payment',0.01,'Extra','U']],mapping:{customer:0,invoice:1,type:2,amount:3,description:4,utr:5},startRow:2};assert.equal((await request('/api/import/preview','POST',input,admin)).body.canImport,false);assert.equal((await request('/api/import','POST',{...input,revision:3},admin)).status,400);
  const removed=await request('/api/records/delete','POST',{collection:'advice',index:2,identifier:'P3',revision:3},admin);assert.equal(removed.status,200);assert.equal(removed.body.state.bank[0].status,'review');assert.equal(require('./finance').rows(removed.body.state)[0].pendingToMatch,3000);
});
test('receipt summaries stay stable when one reference has many invoice allocations',()=>{
  const state=emptyState();state.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:100}];state.bank=[{ref:'U',customer:'Buyer',date:'2026-11-01',amount:100,status:'unmatched'}];state.advice=Array.from({length:100},(_,i)=>({id:'PAYMENT-ALLOCATION-'+i,customer:'Buyer',date:'2026-11-01',invoice:'I',type:'Payment',amount:1,utr:'U',description:'Part'}));const validated=validateState(state);assert.equal(validated.bank[0].status,'matched');assert.ok(validated.bank[0].advice.length<2000);assert.deepEqual(validateState(validated),validated);
});
integrationTest('one advice batch allocates several invoices with a shared ID and rejects the complete batch on error',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();await createUser(db,{email:'batch-editor@example.com',name:'Editor',password,role:'editor',mustChange:false});const editor=await login('batch-editor@example.com'),state=emptyState();state.invoices=[{id:'I1',customer:'Buyer',date:'2026-11-04',amount:6000},{id:'I2',customer:'Buyer',date:'2026-11-04',amount:4000},{id:'O',customer:'Other',date:'2026-11-04',amount:4000}];state.bank=[{ref:'U',customer:'Buyer',date:'2026-11-04',amount:10000,status:'unmatched'}];assert.equal((await request('/api/state','PUT',{state,revision:0},admin)).status,200);
  const line=(invoice,customer,amount)=>({id:'BATCH-ONE',invoice,customer,amount,date:'2026-11-04',type:'Payment',description:'Split payment',utr:'U'});state.advice=[line('I1','Buyer',6000),line('O','Other',4000)];assert.equal((await request('/api/state','PUT',{state,revision:1},editor)).status,400);assert.equal((await request('/api/state','GET',undefined,admin)).body.state.advice.length,0);
  state.advice=[line('I1','Buyer',6000),line('I2','Buyer',4000.01)];assert.equal((await request('/api/state','PUT',{state,revision:1},editor)).status,400);assert.equal((await request('/api/state','GET',undefined,admin)).body.state.advice.length,0);
  state.advice[1].amount=4000;const saved=await request('/api/state','PUT',{state,revision:1},editor);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.state.advice.length,2);assert.equal(saved.body.state.advice[0].id,saved.body.state.advice[1].id);assert.equal(saved.body.state.bank[0].status,'matched');
});
integrationTest('anonymous API access is blocked and only public assets are served', async (t, engine)=>{
  const {request}=await fixture(t, engine);
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/backup')).status,401);
  for(const resource of ['/server.js','/.env','/lib/auth.js','/package.json','/data/reconcileiq.sqlite','/%2e%2e/server.js']) {
    assert.equal((await request(resource)).status,404,resource);
  }
  assert.equal((await request('/')).status,200);
  assert.deepEqual((await request('/health')).body,{ok:true});
});

integrationTest('spreadsheet imports require admin and preview revision, preserve history and block invalid batches',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();
  await createUser(db,{email:'import-viewer@example.com',name:'Viewer',password,role:'viewer',mustChange:false});const viewer=await login('import-viewer@example.com');
  const input={type:'invoices',mapping:{id:0,customer:1,date:2,amount:3},rows:[['IMPORT-1','Acme','03/11/2026',100]],dateFormat:'dmy',startRow:2};
  assert.equal((await request('/api/import/preview','POST',input)).status,401);
  assert.equal((await request('/api/import/preview','POST',input,viewer)).status,403);
  assert.equal((await request('/api/import/definitions','GET',undefined,viewer)).status,403);
  const preview=await request('/api/import/preview','POST',input,admin);assert.equal(preview.status,200);assert.equal(preview.body.canImport,true);assert.equal(preview.body.counts.added,1);
  assert.equal((await request('/api/state','GET',undefined,admin)).body.state.invoices.length,0);
  const saved=await request('/api/import','POST',{...input,revision:preview.body.revision},admin);assert.equal(saved.status,200);assert.equal(saved.body.revision,1);assert.equal(saved.body.state.invoices[0].id,'IMPORT-1');
  assert.equal((await request('/api/import','POST',{...input,revision:0},admin)).status,409);
  const duplicate=await request('/api/import/preview','POST',input,admin);assert.equal(duplicate.body.counts.skipped,1);assert.equal(duplicate.body.canImport,false);
  const invalid={...input,rows:[['IMPORT-2','Acme','2026-11-03',100],['IMPORT-3','Acme','bad-date',100]],revision:1};
  assert.equal((await request('/api/import','POST',invalid,admin)).status,400);
  assert.equal((await request('/api/state','GET',undefined,admin)).body.state.invoices.length,1);
  const audit=await db.query("SELECT action,detail FROM audit_events WHERE action=$1",['workspace.imported']);assert.equal(audit.length,1);assert.equal(JSON.parse(audit[0].detail).counts.added,1);
  const snapshot=await db.query('SELECT data FROM workspace_snapshots WHERE revision=0');assert.equal(JSON.parse(snapshot[0].data).invoices.length,0);
});

integrationTest('large workspaces use compressed requests, storage and responses without losing snapshots',async(t,engine)=>{
  const {gzipSync}=require('node:zlib');const {decodeState}=require('./lib/state-codec');const {base,db,login,request}=await fixture(t,engine);const session=await login();
  const state=emptyState();state.invoices=Array.from({length:25001},(_,i)=>({id:`LARGE-${i}`,customer:'Large customer with a long display name for compression verification',date:'2026-11-03',amount:100,code:'LARGE-CUSTOMER'.repeat(5)}));
  const text=JSON.stringify({revision:0,state});assert.ok(Buffer.byteLength(text)>4*1024*1024);
  const put=await fetch(base+'/api/state',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json','Content-Encoding':'gzip',Cookie:session.cookie,'X-CSRF-Token':session.csrf},body:gzipSync(text)});
  assert.equal(put.status,200);assert.equal(put.headers.get('content-encoding'),'gzip');assert.equal((await put.json()).state.invoices.length,25001);
  const [stored]=await db.query('SELECT data FROM workspace WHERE id=1');assert.ok(stored.data.startsWith('gzip:'));assert.equal(decodeState(stored.data).invoices.length,25001);
  const shared=await request('/api/state','GET',undefined,session);assert.equal(shared.body.state.invoices.length,25001);
  const backup=await request('/api/backup','GET',undefined,session);assert.equal(backup.body.state.invoices[25000].id,'LARGE-25000');
  const portable=await fetch(base+'/api/state',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json',Cookie:session.cookie,'X-CSRF-Token':session.csrf},body:JSON.stringify({__reconcileiqGzip:gzipSync(JSON.stringify({revision:1,state})).toString('base64')})});
  assert.equal(portable.status,200);assert.equal((await portable.json()).revision,2);
  const snapshot=await request('/api/snapshots/1','GET',undefined,session);assert.equal(snapshot.status,200);assert.equal(snapshot.body.state.invoices.length,25001);
});

integrationTest('sign-in uses hashed passwords, hashed sessions and HttpOnly SameSite cookies', async (t, engine)=>{
  const {db,request,login}=await fixture(t, engine);
  assert.equal((await request('/api/login','POST',{email:'admin@example.com',password:'wrong'})).status,401);
  const session=await login();
  const [user]=await db.query('SELECT password_hash FROM app_users');
  assert.ok(user.password_hash.startsWith('scrypt:'));assert.ok(!user.password_hash.includes(password));
  const [stored]=await db.query('SELECT token_hash FROM app_sessions');
  assert.equal(stored.token_hash,digest(session.cookie.split('=')[1]));
  const result=await request('/api/login','POST',{email:'admin@example.com',password});
  assert.match(result.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/session','GET',undefined,session)).body.user.role,'admin');
  assert.equal((await request('/api/logout','POST',{},session)).status,200);
  assert.equal((await request('/api/state','GET',undefined,session)).status,401);
});

integrationTest('viewer/editor/admin access and request forgery are enforced on the server', async (t, engine)=>{
  const {db,request,login}=await fixture(t, engine);
  await createUser(db,{email:'viewer@example.com',name:'Viewer',password,role:'viewer',mustChange:false});
  await createUser(db,{email:'editor@example.com',name:'Editor',password,role:'editor',mustChange:false});
  const viewer=await login('viewer@example.com');const editor=await login('editor@example.com');const admin=await login();
  assert.equal((await request('/api/state','GET',undefined,viewer)).status,200);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},viewer)).status,403);
  assert.equal((await request('/api/users','GET',undefined,editor)).status,403);
  assert.equal((await request('/api/backup','GET',undefined,editor)).status,403);
  assert.equal((await request('/api/restore','POST',{revision:0,state:emptyState()},editor)).status,403);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},admin,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},admin,{Origin:'https://other.example'})).status,403);
  assert.equal((await request('/api/state','PUT',{revision:0,state:emptyState()},editor)).status,200);
  assert.equal((await request('/api/users','GET',undefined,admin)).status,200);
});

integrationTest('two users cannot overwrite a revision; audit, backup and recovery preserve data', async (t, engine)=>{
  const {request,login}=await fixture(t, engine);
  const first=await login();const second=await login();
  const state=emptyState();state.invoices.push({id:'INV-1',customer:'Test Buyer',date:'2026-11-02',amount:500});
  const changed=structuredClone(state);changed.invoices[0].amount=900;
  const results=await Promise.all([
    request('/api/state','PUT',{revision:0,state},first),
    request('/api/state','PUT',{revision:0,state:changed},second),
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const latest=await request('/api/state','GET',undefined,second);
  assert.equal(latest.body.revision,1);assert.equal(latest.body.state.invoices.length,1);
  const backup=await request('/api/backup','GET',undefined,first);
  assert.deepEqual(backup.body.state,latest.body.state);
  assert.ok(!JSON.stringify(backup.body).includes('password_hash'));
  assert.ok(!JSON.stringify(backup.body).includes('token_hash'));
  const previous=await request('/api/snapshots/0','GET',undefined,first);
  assert.deepEqual(previous.body.state,emptyState());
  const restored=await request('/api/restore','POST',{revision:1,state:previous.body.state},first);
  assert.equal(restored.status,200);assert.equal(restored.body.revision,2);
  assert.equal(restored.body.state.invoices.length,0);
  const audit=await request('/api/audit','GET',undefined,first);
  assert.equal(audit.body.events.filter(event=>event.action==='workspace.saved').length,1);
  assert.equal(audit.body.events.filter(event=>event.action==='workspace.restored').length,1);
});

integrationTest('temporary passwords must change; changing roles and passwords revokes sessions', async (t, engine)=>{
  const {request,login}=await fixture(t, engine);const admin=await login();
  const result=await request('/api/users','POST',{email:'new@example.com',name:'New User',password,role:'editor'},admin);
  assert.equal(result.status,201);const id=result.body.user.id;
  const temporary=await login('new@example.com');assert.equal(temporary.user.mustChange,true);
  assert.equal((await request('/api/state','GET',undefined,temporary)).status,403);
  const nextPassword='A-different-test-password';
  assert.equal((await request('/api/password','POST',{currentPassword:password,password:nextPassword},temporary)).status,200);
  assert.equal((await request('/api/session','GET',undefined,temporary)).status,401);
  const user=await login('new@example.com',nextPassword);assert.equal(user.user.mustChange,false);
  assert.equal((await request(`/api/users/${id}`,'PATCH',{role:'viewer'},admin)).status,200);
  assert.equal((await request('/api/state','GET',undefined,user)).status,401);
  assert.equal((await login('new@example.com',nextPassword)).user.role,'viewer');
  assert.equal((await request(`/api/users/${id}`,'PATCH',{active:false},admin)).status,200);
  assert.equal((await request('/api/login','POST',{email:'new@example.com',password:nextPassword})).status,401);
  assert.equal((await request(`/api/users/${admin.user.id}`,'PATCH',{active:false},admin)).status,400);
});

integrationTest('forgot-password requests are private, rate-limited and do not reveal account existence',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();
  const user=await createUser(db,{email:'recover@example.com',name:'Recovery User',password,role:'viewer',mustChange:false});const viewer=await login(user.email);
  const known=await request('/api/password-reset/request','POST',{email:user.email});const unknown=await request('/api/password-reset/request','POST',{email:'missing@example.com'});
  assert.equal(known.status,202);assert.deepEqual(known.body,unknown.body);
  assert.equal((await request('/api/password-reset/requests')).status,401);assert.equal((await request('/api/password-reset/requests','GET',undefined,viewer)).status,403);
  const pending=await request('/api/password-reset/requests','GET',undefined,admin);assert.equal(pending.body.requests.length,1);assert.equal(pending.body.requests[0].user_id,user.id);
  for(let i=0;i<2;i++)await request('/api/password-reset/request','POST',{email:user.email});
  await db.query('UPDATE password_reset_requests SET requested_at=$1 WHERE user_id=$2',['2000-01-01T00:00:00.000Z',user.id]);
  assert.equal((await request('/api/password-reset/request','POST',{email:user.email})).status,202);
  assert.equal((await db.query('SELECT requested_at FROM password_reset_requests WHERE user_id=$1',[user.id]))[0].requested_at,'2000-01-01T00:00:00.000Z');
  assert.equal((await request(`/api/users/${user.id}/reset-link`,'POST',{},viewer)).status,403);
  assert.equal((await request('/api/password-reset/request','POST',{email:user.email},undefined,{Origin:'https://evil.example.com'})).status,403);
});

integrationTest('reset links are hashed, expire, work once and revoke existing sessions',async(t,engine)=>{
  const {request,login,db,admin:user,base}=await fixture(t,engine);const admin=await login();
  const target=await createUser(db,{email:'reset@example.com',name:'Reset User',password,role:'editor',mustChange:false});const original=await login(target.email);
  await request('/api/password-reset/request','POST',{email:target.email});
  assert.equal((await request(`/api/users/${target.id}/reset-link`,'POST',{},admin,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await request(`/api/users/${user.id}/reset-link`,'POST',{},admin)).status,400);
  const issued=await request(`/api/users/${target.id}/reset-link`,'POST',{},admin);assert.equal(issued.status,200);assert.equal(new URL(issued.body.url).origin,base);
  const token=new URLSearchParams(new URL(issued.body.url).hash.slice(1)).get('reset');assert.match(token,/^[-_a-zA-Z0-9]{43}$/);
  const [saved]=await db.query('SELECT * FROM password_reset_tokens WHERE user_id=$1',[target.id]);assert.equal(saved.token_hash,digest(token));assert.ok(!JSON.stringify(saved).includes(token));
  assert.equal((await request('/api/password-reset/requests','GET',undefined,admin)).body.requests.length,0);
  const nextPassword='New-reset-password-2026';const completed=await request('/api/password-reset/complete','POST',{token,password:nextPassword});assert.equal(completed.status,200);assert.match(completed.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await request('/api/state','GET',undefined,original)).status,401);assert.equal((await request('/api/login','POST',{email:target.email,password})).status,401);
  const signedIn=await login(target.email,nextPassword);assert.equal(signedIn.user.mustChange,false);
  assert.equal((await request('/api/password-reset/complete','POST',{token,password:'Another-reset-password-2026'})).status,400);
  const expired=await request(`/api/users/${target.id}/reset-link`,'POST',{},admin);const expiredToken=new URLSearchParams(new URL(expired.body.url).hash.slice(1)).get('reset');
  await db.query('UPDATE password_reset_tokens SET expires_at=$1 WHERE user_id=$2',['2000-01-01T00:00:00.000Z',target.id]);
  assert.equal((await request('/api/password-reset/complete','POST',{token:expiredToken,password:nextPassword})).status,400);
  const events=await request('/api/audit','GET',undefined,admin);assert.ok(events.body.events.some(e=>e.action==='password.reset'));assert.ok(!JSON.stringify(events.body).includes(token));assert.ok(!JSON.stringify(events.body).includes(nextPassword));
});

integrationTest('administrator temporary resets and access changes invalidate outstanding reset links',async(t,engine)=>{
  const {request,login,db}=await fixture(t,engine);const admin=await login();
  const target=await createUser(db,{email:'temporary-reset@example.com',name:'Temporary Reset',password,role:'viewer',mustChange:false});const old=await login(target.email);
  const issue=async()=>{const r=await request(`/api/users/${target.id}/reset-link`,'POST',{},admin);assert.equal(r.status,200);return new URLSearchParams(new URL(r.body.url).hash.slice(1)).get('reset');};
  const replaced=await issue();const latest=await issue();assert.equal((await request('/api/password-reset/complete','POST',{token:replaced,password:'New-temporary-password-2026'})).status,400);
  const temporary='Temporary-password-2026';assert.equal((await request(`/api/users/${target.id}/reset-password`,'POST',{password:temporary},admin)).status,200);
  assert.equal((await request('/api/state','GET',undefined,old)).status,401);assert.equal((await request('/api/password-reset/complete','POST',{token:latest,password:temporary})).status,400);
  const temporarySession=await login(target.email,temporary);assert.equal(temporarySession.user.mustChange,true);assert.equal((await request('/api/state','GET',undefined,temporarySession)).status,403);
  assert.equal((await request('/api/password','POST',{currentPassword:temporary,password},temporarySession)).status,200);
  const afterChange=await issue();assert.equal((await request(`/api/users/${target.id}`,'PATCH',{active:false},admin)).status,200);
  assert.equal((await request('/api/password-reset/complete','POST',{token:afterChange,password:temporary})).status,400);
  assert.equal((await db.query('SELECT * FROM password_reset_tokens WHERE user_id=$1',[target.id])).length,0);
});

integrationTest('validation rejects malformed data, duplicate invoices and mismatched buyers without advancing revision', async (t, engine)=>{
  const {request,login}=await fixture(t, engine);const admin=await login();
  const state=emptyState();state.invoices.push({id:'I1',customer:'Buyer',date:'2026-11-02',amount:100});
  for(const mutate of [
    s=>s.invoices.push({...s.invoices[0]}),
    s=>s.invoices[0].amount=-10,
    s=>s.invoices[0].date='2026-02-30',
    s=>s.invoices[0].customer='<script>alert(1)</script>',
    s=>s.customerTerms.push({customer:'Buyer',creditDays:-1}),
    s=>s.advice.push({id:'PA1',customer:'Other',invoice:'I1',date:'2026-11-02',amount:100,type:'Payment',utr:'UTR1'}),
  ]){
    const input=structuredClone(state);mutate(input);
    assert.equal((await request('/api/state','PUT',{revision:0,state:input},admin)).status,400);
  }
  assert.equal((await request('/api/state','PUT',null,admin)).status,400);
  assert.equal((await request('/api/state','GET',undefined,admin)).body.revision,0);
  const valid=await request('/api/state','PUT',{revision:0,state},admin);
  assert.equal(valid.status,200);assert.equal(valid.body.state.customerTerms[0].creditDays,45);
});

test('legacy invoice credit terms are migrated to one shared customer mapping',()=>{
  const state=emptyState();delete state.customerTerms;
  state.invoices=[{id:'I1',customer:'Buyer',date:'2026-11-02',amount:100,creditDays:60},{id:'I2',customer:' buyer ',date:'2026-11-02',amount:100,creditDays:15}];
  const migrated=validateState(state);
  assert.equal(migrated.customerTerms.length,1);assert.equal(migrated.customerTerms[0].creditDays,60);
  assert.ok(!('creditDays' in migrated.invoices[0]));
});

integrationTest('expired sessions are refused and concurrent access changes keep one administrator',async(t,engine)=>{
  const {db,request,login}=await fixture(t,engine);
  const first=await login();
  const secondUser=await createUser(db,{email:'admin2@example.com',name:'Admin Two',password,role:'admin',mustChange:false});
  const second=await login('admin2@example.com');
  const results=await Promise.all([
    request(`/api/users/${secondUser.id}`,'PATCH',{active:false},first),
    request(`/api/users/${first.user.id}`,'PATCH',{active:false},second),
  ]);
  assert.equal(results.filter(result=>result.status===200).length,1);
  const [active]=await db.query("SELECT COUNT(*) AS count FROM app_users WHERE active=1 AND role='admin'");
  assert.equal(Number(active.count),1);
  const survivor=await login(results[0].status===200?'admin@example.com':'admin2@example.com');
  await db.query('UPDATE app_sessions SET expires_at=$1',['2000-01-01T00:00:00.000Z']);
  assert.equal((await request('/api/state','GET',undefined,survivor)).status,401);
});

test('local shared data survives a database restart',async()=>{
  const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reconcileiq-test-'));
  const filename=path.join(directory,'workspace.sqlite');
  let db;
  try {
    db=await openDatabase({url:'',filename});
    const state=emptyState();state.invoices.push({id:'PERSIST',customer:'Buyer',date:'2026-11-02',amount:300});
    await db.query('UPDATE workspace SET data=$1,revision=1 WHERE id=1',[JSON.stringify(state)]);
    await db.close();db=await openDatabase({url:'',filename});
    const [saved]=await db.query('SELECT revision,data FROM workspace WHERE id=1');
    assert.equal(saved.revision,1);assert.equal(JSON.parse(saved.data).invoices[0].id,'PERSIST');
  }finally{
    if(db)await db.close();
    for(const suffix of ['','-wal','-shm'])fs.rmSync(filename+suffix,{force:true});
    fs.rmdirSync(directory);
  }
});

integrationTest('repeated login failures are throttled',async (t, engine)=>{
  const {request}=await fixture(t, engine);
  for(let index=0;index<10;index++) assert.equal((await request('/api/login','POST',{email:'missing@example.com',password})).status,401);
  assert.equal((await request('/api/login','POST',{email:'missing@example.com',password})).status,429);
});
