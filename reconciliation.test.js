const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function workspace(saved, shared) {
  const elements = new Map();
  const storage = new Map(saved ? [['reconcileiq-state', JSON.stringify(saved)]] : []);
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() {return true;} },
      addEventListener(name,handler) {this.listeners??={};this.listeners[name]=handler;}, querySelectorAll() { return []; }, append() {},
      focus(){this.focused=true;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    Intl, Date, console, crypto:require('node:crypto'), setTimeout() {}, setInterval() {},
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: {
      getElementById: element,
      querySelectorAll() { return []; },
      querySelector() { return null; },
      createElement() { return { click() {} }; },
    },
    window: { RECONCILE_TEST_MODE: true, scrollTo() {}, addEventListener() {}, workspaceSession:shared },
    Blob: class { constructor(parts) { context.exportedCSV = parts.join(''); } },
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/finance.js`, 'utf8'), context);
  vm.runInContext(fs.readFileSync(`${__dirname}/app.js`, 'utf8'), context);
  return { context, element, storage, run: code => vm.runInContext(code, context) };
}

test('brand claims expose bulk import, map template columns and keep automatic sync disabled for claim imports',()=>{
  const initial=workspace().run('clone(seed)'),app=workspace(undefined,{state:initial,revision:1,user:{role:'editor',buyerGroupIds:null}});app.context.claimDefinitions=require('./lib/import').definitions.brandClaims;
  assert.ok(app.run('renderBrandClaims()').includes('data-action="bulk-import-brand-claims"'));app.run(`window.claimMapping=suggestImportColumns(claimDefinitions.fields,registerImportTemplates.brandClaims,'brandClaims');`);
  for(const field of app.context.claimDefinitions.fields.filter(field=>field.required))assert.equal(typeof app.run('window.claimMapping')[field.key],'number',field.key);
  app.run(`modal=(title,subtitle,body,footer)=>{window.claimImportMarkup=body+footer;return {querySelector:s=>document.getElementById(s.slice(1))};};openRegisterBulkImport('brandClaims');`);assert.ok(app.run('window.claimImportMarkup').includes('claimLocalCsv'));assert.ok(app.run('window.claimImportMarkup').includes('claimOneDriveImport'));
  app.run(`sharedSession.user.buyerGroupIds=['GROUP'];openRegisterBulkImport('brandClaims');`);assert.ok(app.run('window.claimImportMarkup').includes('scopedImportFile'));
});
test('debit-note customer dropdown filters invoices and requires every non-CN field',async()=>{
  const app=workspace();app.run(`modal=(title,subtitle,body)=>{window.debitMarkup=body;};state.invoices=[{id:'A1',customer:'Alpha',code:'CA',date:today,amount:1000},{id:'B1',customer:'Beta',code:'CB',date:today,amount:1000}];state.customerTerms=[];state.debitNotes=[];openDebit();`);
  assert.ok(app.run('window.debitMarkup').includes('<select id="dnCustomer" required>'));assert.equal(app.element('dnInvoice').disabled,true);assert.ok(!app.element('dnInvoice').innerHTML.includes('A1'));
  app.element('dnCustomer').value='Alpha';app.element('dnCustomer').onchange();assert.ok(app.element('dnInvoice').innerHTML.includes('A1'));assert.ok(!app.element('dnInvoice').innerHTML.includes('B1'));assert.equal(app.element('dnCustomerCode').value,'CA');
  app.element('dnInvoice').value='A1';app.element('dnCustomer').value='Beta';app.element('dnCustomer').onchange();assert.equal(app.element('dnInvoice').value,'');assert.ok(!app.element('dnInvoice').innerHTML.includes('A1'));
  app.element('dnId').value='DN-REQ';app.element('dnDate').value='2026-11-11';app.element('dnAmount').value='100';app.element('dnType').value='EPC';await app.element('saveDebit').onclick();assert.equal(app.run('state.debitNotes.length'),0);assert.match(app.element('debitError').textContent,/original invoice/);
});

test('brand claims calculate net, brand due dates and inclusive settlement boundaries without changing invoice balances',()=>{
  const app=workspace();app.run(`state.brandTerms=[{brand:'Brand A',creditDays:30}];window.claimInput={relatedMonth:'2026-10',brand:'Brand A',customer:'Buyer',claimType:'Promotion',receivedDate:'2026-10-31',buyerDocument:'DN-CLAIM',buyerDNAmount:'1000',buyerCNNumber:'CANCEL',buyerCNAmount:'100',relatedCNNumber:'',relatedCNDate:'',relatedCNAmount:''};`);
  const initial=app.run('totals().pending');app.run(`state.brandClaims=[claimFormRecord(window.claimInput,'CLM-TEST')];`);assert.equal(app.run('brandClaimRows()[0].netAmount'),900);assert.equal(app.run('brandClaimRows()[0].dueDate'),'2026-11-30');assert.equal(app.run('brandClaimRows()[0].status'),'Unsettled');assert.equal(app.run('totals().pending'),initial);
  for(const [amount,status,pending] of [[890,'Settled',10],[910,'Settled',-10],[889.99,'Pending',10.01],[910.01,'Pending',-10.01],[900,'Settled',0]]){app.context.cnAmount=amount;app.run(`state.brandClaims[0].relatedCNNumber='BRAND-CN';state.brandClaims[0].relatedCNDate='2026-11-11';state.brandClaims[0].relatedCNAmount=cnAmount;`);assert.equal(app.run('brandClaimRows()[0].status'),status);assert.equal(app.run('brandClaimRows()[0].pendingAmount'),pending);}
  app.run(`state.brandTerms[0].creditDays=0;`);assert.equal(app.run('brandClaimRows()[0].dueDate'),'2026-10-31');app.run('exportBrandClaims()');const csv=require('csv-parse/sync').parse(app.context.exportedCSV);assert.equal(csv[1][csv[0].indexOf('Status')],'Settled');assert.ok(app.run('renderBrandClaims()').includes('Claim settlements with Brand'));
});
test('claim forms save once, allow adding CN later and retain drafts when saving fails',async()=>{
  const initial=workspace().run('clone(seed)'),app=workspace(undefined,{state:initial,revision:1,user:{role:'editor'}});app.run(`modal=()=>{};go=()=>{};closeModal=()=>{};showToast=()=>{};window.workspaceAPI=async(route,method,input)=>({state:JSON.parse(JSON.stringify(input.state)),revision:2});openBrandClaim();`);
  for(const [field,value] of [['RelatedMonth','2026-10'],['Brand','Brand A'],['Customer','Buyer'],['ClaimType','Promotion'],['ReceivedDate','2026-11-01'],['BuyerDocument','DN-CREATE'],['BuyerDNAmount','1000']])app.element('claim'+field).value=value;
  await app.element('saveBrandClaim').onclick();assert.equal(app.run('state.brandClaims.length'),1);assert.equal(app.run('state.brandClaims[0].status'),'Unsettled');
  app.run(`openBrandClaim(state.brandClaims[0].id);`);app.element('claimRelatedCNNumber').value='CN-SETTLE';app.element('claimRelatedCNDate').value='2026-11-11';app.element('claimRelatedCNAmount').value='995';await app.element('saveBrandClaim').onclick();assert.equal(app.run('state.brandClaims[0].status'),'Settled');assert.equal(app.run('state.brandClaims[0].pendingAmount'),5);assert.equal(app.run('state.brandClaims.length'),1);
  app.run(`openBrandClaim(state.brandClaims[0].id);window.workspaceAPI=async()=>{throw Error('Claim save failed')};`);app.element('claimRelatedCNAmount').value='500';await app.element('saveBrandClaim').onclick();assert.equal(app.element('claimRelatedCNAmount').value,'500');assert.equal(app.element('claimError').textContent,'Claim save failed');assert.equal(app.run('state.brandClaims[0].relatedCNAmount'),995);
  app.run(`sharedSession.user.role='viewer';modal=()=>{throw Error('Viewer opened edit form')};openBrandClaim();`);assert.ok(!app.run('renderBrandClaims()').includes('data-action="add-brand-claim"'));
});

test('typed debit-note adjustments share invoice deduction heads and do not double-count advice, totals or exports',()=>{
  const app=workspace();app.run(`state={invoices:[{id:'HEADS',customer:'Buyer',date:today,amount:10000}],advice:[{id:'A',invoice:'HEADS',customer:'Buyer',type:'PPV',amount:50}],bank:[],returns:[],priceReturns:[],customerTerms:[],buyerGroups:[],logs:[],debitNotes:['PPV','PQV','CCOGS','TAXD','EPC'].map((type,i)=>({id:'D'+i,invoice:'HEADS',customer:'Buyer',date:today,type,amount:1000,creditNoteNumber:'CN'+i,creditNoteAmount:700,settlementMode:'creditNote'}))};showToast=()=>{};`);
  assert.equal(app.run('allInvoices()[0].PPV'),350);for(const type of ['PQV','CCOGS','TaxD','EPC'])assert.equal(app.run('allInvoices()[0].'+type),300);
  assert.equal(app.run('allInvoices()[0].deducted'),1550);assert.equal(app.run('allInvoices()[0].pending'),8450);assert.equal(app.run('customerRows()[0].ppv'),350);assert.equal(app.run('customerRows()[0].taxd'),300);assert.equal(app.run('totals().ppv+totals().pqv+totals().ccogs+totals().taxd+totals().epc'),1550);
  app.run(`const reusable=financialIndex();invoiceData(state.invoices[0],reusable);invoiceData(state.invoices[0],reusable);window.reusedPPV=invoiceData(state.invoices[0],reusable).PPV;modal=(title,subtitle,body)=>{window.headMarkup=body;};openInvoice('HEADS');`);assert.equal(app.run('window.reusedPPV'),350);assert.ok(!app.run('window.headMarkup').includes('Debit note difference'));assert.ok(app.run('window.headMarkup').includes('<span>PPV</span>'));
  app.run(`exportReport('Invoice Outstanding');`);const csv=require('csv-parse/sync').parse(app.context.exportedCSV);assert.equal(csv[1][csv[0].indexOf('PPV')],'350');assert.equal(csv[1][csv[0].indexOf('TaxD')],'300');assert.ok(!csv[0].includes('Debit Note Adjustment'));
});

test('DN and CN differences recalculate receivables, brand totals, customer balances and exports without affecting bank cash',()=>{
  const app=workspace();app.run(`state={invoices:[{id:'I-DN',customer:'Buyer',date:today,amount:5000,brandName:'A / B',brandAmounts:[{brandName:'A',amount:3000},{brandName:'B',amount:2000}]}],advice:[],bank:[{ref:'U-DN',customer:'Buyer',date:today,amount:1000,status:'unmatched'}],returns:[],priceReturns:[],customerTerms:[],buyerGroups:[],logs:[],debitNotes:[{id:'DN-TEST',type:'PPV',customer:'Buyer',invoice:'I-DN',date:today,amount:1000,creditNoteAmount:0,creditNoteNumber:'',settlementMode:'creditNote',status:'Unsettled'}]};showToast=()=>{};`);
  assert.equal(app.run('allInvoices()[0].pending'),4000);assert.equal(app.run('customerRows()[0].debitAdjustment'),1000);assert.equal(app.run('bankRows()[0].pendingToMatch'),1000);
  app.run(`state.debitNotes[0].creditNoteNumber='CN-TEST';state.debitNotes[0].creditNoteAmount=700;`);assert.equal(app.run('allInvoices()[0].pending'),4700);assert.equal(app.run('allInvoices()[0].debitAdjustment'),300);assert.ok(app.run('renderDebit()').includes('Settled'));
  app.run(`dashboardBrand='brand:a';`);assert.equal(app.run('totals(dashboardData().invoices).debitAdjustment'),180);assert.equal(app.run('totals(dashboardData().invoices).pending'),2820);
  app.run(`exportReport('Invoice Outstanding');`);let csv=require('csv-parse/sync').parse(app.context.exportedCSV);assert.equal(csv[1][csv[0].indexOf('PPV')],'300');
  app.run(`exportReport('Debit Note Register');`);csv=require('csv-parse/sync').parse(app.context.exportedCSV);assert.equal(csv[1][csv[0].indexOf('Related Credit Note')],'CN-TEST');assert.equal(csv[1][csv[0].indexOf('Invoice Adjustment')],'300');
  app.run(`state.debitNotes[0].creditNoteAmount=1200;`);assert.equal(app.run('allInvoices()[0].pending'),5200);
  app.run(`state.debitNotes=[];`);assert.equal(app.run('allInvoices()[0].pending'),5000);
});
test('editors can add debit notes and later enter a CN while retaining the same DN identifier',async()=>{
  const initial=workspace().run('clone(seed)'),app=workspace(undefined,{state:initial,revision:1,user:{role:'editor'}});
  app.run(`modal=()=>{};render=()=>{};closeModal=()=>{};showToast=()=>{};window.workspaceAPI=async(route,method,input)=>({state:JSON.parse(JSON.stringify(input.state)),revision:2});openDebit();`);
  app.element('dnId').value='DN-FORM';app.element('dnCustomer').value=initial.invoices[0].customer;app.element('dnCustomerCode').value='BUYER-CODE';app.element('dnDate').value='2026-11-11';app.element('dnAmount').value='1000';app.element('dnInvoice').value=initial.invoices[0].id;app.element('dnType').value='EPC';
  await app.element('saveDebit').onclick();assert.equal(app.run('state.debitNotes[0].status'),'Unsettled');assert.equal(app.run('state.debitNotes[0].customerCode'),'BUYER-CODE');
  app.run(`openDebit('DN-FORM');`);assert.equal(app.element('dnId').disabled,true);app.element('dnCreditNote').value='CN-FORM';app.element('dnCreditAmount').value='700';await app.element('saveDebit').onclick();assert.equal(app.run('state.debitNotes[0].status'),'Settled');assert.equal(app.run('window.ReconcileIQBank.debitNote(state.debitNotes[0]).difference'),300);assert.equal(app.run("state.debitNotes.filter(x=>x.id==='DN-FORM').length"),1);
  app.run(`openDebit('DN-FORM');window.workspaceAPI=async()=>{throw Error('Unable to save CN')};`);app.element('dnCreditAmount').value='800';await app.element('saveDebit').onclick();assert.equal(app.element('dnCreditAmount').value,'800');assert.equal(app.element('debitError').textContent,'Unable to save CN');assert.equal(app.run('state.debitNotes[0].creditNoteAmount'),700);
});

test('opening receivables use original due dates and share same-buyer payment allocation without changing sales credit terms',()=>{
  const app=workspace();app.run(`state={invoices:[],advice:[],bank:[],returns:[],priceReturns:[],debitNotes:[],logs:[],buyerGroups:[],customerTerms:[{customer:'Acme',creditDays:90}]};
    state.invoices.push(openingBalanceRecord({customer:'acme',amount:1000,date:today,dueDate:'2020-01-01',reference:'OLD-TEST',remarks:'Carried forward'},'OB-TEST'));
    state.invoices.push({id:'SALE',customer:'Acme',amount:200,date:today});
    state.bank.push({ref:'RECEIPT',customer:'Acme',date:today,amount:1000,status:'unmatched'});`);
  assert.equal(app.run("invoiceData(state.invoices[0]).dueDate"),'2020-01-01');assert.equal(app.run('invoiceData(state.invoices[0]).status'),'overdue');assert.equal(app.run('invoiceData(state.invoices[1]).status'),'due');
  app.run(`state.advice.push(...adviceBatchRecords([{invoice:'OB-TEST',type:'Payment',amount:600,description:'Earlier dues'}],'RECEIPT','PA-TEST'));`);
  assert.equal(app.run('invoiceData(state.invoices[0]).pending'),400);assert.equal(app.run('bankRows()[0].pendingToMatch'),400);assert.equal(app.run('customerRows()[0].overdue'),400);assert.equal(app.run('totals().due'),200);
  app.run(`state.advice.push(...adviceBatchRecords([{invoice:'OB-TEST',type:'Payment',amount:400,description:'Final earlier dues'}],'RECEIPT','PA-FINAL'));`);
  assert.equal(app.run('invoiceData(state.invoices[0]).status'),'settled');assert.equal(app.run('bankRows()[0].pendingToMatch'),0);
  app.run(`state.bank.push({ref:'FOREIGN',customer:'Other',date:today,amount:100,status:'unmatched'});`);
  assert.throws(()=>app.run(`adviceBatchRecords([{invoice:'OB-TEST',type:'Payment',amount:10,description:'Wrong buyer'}],'FOREIGN','PA-BAD')`),/buyer/);
  app.run(`showToast=()=>{};exportReport('Invoice Outstanding');`);const csv=require('csv-parse/sync').parse(app.context.exportedCSV);assert.equal(csv[1][csv[0].indexOf('Receivable Type')],'Opening balance');assert.equal(csv[1][csv[0].indexOf('Earlier Invoice / Reference')],'OLD-TEST');
  assert.ok(app.run('renderCustomers()').includes('Opening balances'));assert.ok(app.run('invoiceTable(allInvoices())').includes('Opening balance'));
});
test('opening-balance form validates entries, persists once, retains failed drafts and restricts viewers',async()=>{
  const initial=workspace().run('clone(seed)'),app=workspace(undefined,{state:initial,revision:1,user:{role:'editor'}});
  app.run(`modal=(title,subtitle,content,footer)=>{window.openingMarkup=content+footer;};showToast=()=>{};render=()=>{};closeModal=()=>{};window.openingWrites=0;window.workspaceAPI=async(route,method,input)=>{window.openingWrites++;return {state:JSON.parse(JSON.stringify(input.state)),revision:2};};openNewOpeningBalance();`);
  const customer=initial.invoices[0].customer;app.element('openingCustomer').value=customer;app.element('openingDate').value='2026-04-01';app.element('openingDueDate').value='2026-03-01';app.element('openingAmount').value='1200';app.element('openingReference').value='Legacy reference';app.element('openingRemarks').value='Opening dues';
  await app.element('saveOpeningBalance').onclick();assert.equal(app.run('state.invoices[0].recordType'),'openingBalance');assert.equal(app.run('window.openingWrites'),1);
  await app.element('saveOpeningBalance').onclick();assert.equal(app.run('window.openingWrites'),1);assert.match(app.element('openingError').textContent,/already saved/);
  app.run(`openNewOpeningBalance();window.workspaceAPI=async()=>{throw Error('Save failed')};`);await app.element('saveOpeningBalance').onclick();assert.equal(app.element('openingAmount').value,'1200');assert.equal(app.element('openingError').textContent,'Save failed');assert.equal(app.run("state.invoices.filter(x=>x.recordType==='openingBalance').length"),1);
  for(const patch of [{amount:0},{amount:'bad'},{date:'2026-02-31'},{dueDate:''},{remarks:'<script>'}]){app.context.openingInput={customer,amount:100,date:'2026-04-01',dueDate:'2026-03-01',...patch};assert.throws(()=>app.run("openingBalanceRecord(openingInput,'OB')"));}
  app.run(`sharedSession.user.role='viewer';window.openingMarkup='unchanged';openNewOpeningBalance();`);assert.equal(app.run('window.openingMarkup'),'unchanged');
});

test('admins edit opening balances in place with allocations retained; editors cannot open the edit form',async()=>{
  const initial=workspace().run('clone(seed)');initial.invoices.unshift({id:'OB-EDIT',recordType:'openingBalance',customer:'Acme',date:'2026-04-01',openingDueDate:'2026-03-01',amount:1000,roundOff:5,code:'C-TEST',openingReference:'Old reference',remarks:'Old note'});
  initial.bank.push({ref:'EDIT-UTR',customer:'Acme',date:'2026-11-01',amount:1000,status:'review'});initial.advice.push({id:'PA-EDIT',customer:'Acme',date:'2026-11-01',invoice:'OB-EDIT',type:'Payment',amount:600,utr:'EDIT-UTR',description:'Earlier dues'});
  const app=workspace(undefined,{state:initial,revision:1,user:{role:'admin'}});
  app.run(`modal=(title,subtitle,content,footer)=>{window.editMarkup=content+footer;};showToast=()=>{};render=()=>{};closeModal=()=>{};window.workspaceAPI=async(route,method,input)=>({state:JSON.parse(JSON.stringify(input.state)),revision:2});openInvoice('OB-EDIT');`);assert.ok(app.run('window.editMarkup').includes('id="editOpeningBalance"'));
  app.element('editOpeningBalance').onclick();assert.equal(app.element('openingAmount').value,1000);assert.equal(app.element('openingDueDate').value,'2026-03-01');assert.equal(app.element('openingCustomer').disabled,true);
  app.element('openingAmount').value='1200';app.element('openingDueDate').value='2026-02-01';app.element('openingReference').value='Corrected reference';await app.element('saveOpeningBalance').onclick();
  assert.equal(app.run("state.invoices.find(row=>row.id==='OB-EDIT').amount"),1200);assert.equal(app.run("state.invoices.find(row=>row.id==='OB-EDIT').roundOff"),5);assert.equal(app.run("state.invoices.find(row=>row.id==='OB-EDIT').code"),'C-TEST');assert.equal(app.run("state.advice.find(row=>row.id==='PA-EDIT').invoice"),'OB-EDIT');assert.equal(app.run("invoiceData(state.invoices.find(row=>row.id==='OB-EDIT')).pending"),595);
  app.run(`openNewOpeningBalance('OB-EDIT');window.workspaceAPI=async()=>{throw Error('Edit failed')};`);app.element('openingAmount').value='1300';await app.element('saveOpeningBalance').onclick();assert.equal(app.element('openingAmount').value,'1300');assert.equal(app.element('openingError').textContent,'Edit failed');assert.equal(app.run("state.invoices.find(row=>row.id==='OB-EDIT').amount"),1200);
  app.run(`sharedSession.user.role='editor';openInvoice('OB-EDIT');`);assert.ok(!app.run('window.editMarkup').includes('id="editOpeningBalance"'));app.run(`window.editMarkup='unchanged';openNewOpeningBalance('OB-EDIT');`);assert.equal(app.run('window.editMarkup'),'unchanged');
});

test('invoice remarks save and clear, retain failed drafts and are read-only for viewers',async()=>{
  const initial=workspace().run('clone(seed)'),app=workspace(undefined,{state:initial,revision:1,user:{role:'editor'}});const id=initial.invoices[0].id;
  app.context.invoiceId=id;app.run(`modal=(title,subtitle,content)=>{window.invoiceMarkup=content;};showToast=()=>{};window.remarkWrites=0;window.workspaceAPI=async(route,method,input)=>{window.remarkWrites++;return {state:JSON.parse(JSON.stringify(input.state)),revision:2};};openInvoice(invoiceId);`);
  assert.ok(app.run('window.invoiceMarkup').includes('id="invoiceRemarks"'));app.element('invoiceRemarks').value='Customer confirmed\nFollow up on Friday';await app.element('saveInvoiceRemarks').onclick();assert.equal(app.run('state.invoices[0].remarks'),'Customer confirmed\nFollow up on Friday');assert.ok(app.run('window.invoiceMarkup').includes('Follow up on Friday'));
  app.run(`window.workspaceAPI=async()=>{throw Error('Unable to save')};`);app.element('invoiceRemarks').value='Unsaved follow-up';await app.element('saveInvoiceRemarks').onclick();assert.equal(app.element('invoiceRemarks').value,'Unsaved follow-up');assert.equal(app.element('invoiceRemarksError').textContent,'Unable to save');assert.equal(app.run('state.invoices[0].remarks'),'Customer confirmed\nFollow up on Friday');
  app.run(`window.workspaceAPI=async(route,method,input)=>({state:JSON.parse(JSON.stringify(input.state)),revision:3});`);app.element('invoiceRemarks').value='';await app.element('saveInvoiceRemarks').onclick();assert.equal(app.run('state.invoices[0].remarks'),'');
  app.run(`sharedSession.user.role='viewer';openInvoice(invoiceId);`);assert.ok(!app.run('window.invoiceMarkup').includes('id="saveInvoiceRemarks"'));assert.ok(app.run('window.invoiceMarkup').includes('No remarks added.'));
});
test('buyer groups combine multiple customers across views and exports without changing allocation rules',()=>{
  const app=workspace();app.run(`state.invoices=[{id:'A',customer:'Alpha',date:'2026-11-01',amount:100},{id:'B',customer:'Beta',date:'2026-11-01',amount:200},{id:'C',customer:'Other',date:'2026-11-01',amount:300}];state.customerTerms=[];initializeCustomerTerms();state.returns=[];state.priceReturns=[];state.advice=[];state.debitNotes=[];state.bank=[{ref:'BANK-A',customer:'Alpha',date:'2026-11-01',amount:100,status:'unmatched'},{ref:'BANK-C',customer:'Other',date:'2026-11-01',amount:300,status:'unmatched'}];state.buyerGroups=[{id:'G',name:'Group A',customers:['Alpha','Beta']}];customerScope={buyer:'buyer:G',customer:'all'};`);
  assert.equal(app.run('dashboardData().invoices.length'),2);assert.equal(app.run('invoiceRegisterData().invoices.length'),2);assert.equal(app.run('customerRows().length'),2);assert.equal(app.run('unallocatedRows().length'),1);
  assert.ok(app.run('renderBank()').includes('BANK-A'));assert.ok(!app.run('renderBank()').includes('BANK-C'));
  app.run("exportReport('Invoice Outstanding')");assert.ok(app.context.exportedCSV.includes('Alpha'));assert.ok(app.context.exportedCSV.includes('Beta'));assert.ok(!app.context.exportedCSV.includes('Other'));
  assert.ok(app.run('allInvoices().length')===3);app.run("customerScope.customer='customer:beta'");assert.equal(app.run('invoiceRegisterData().invoices[0].id'),'B');
  app.run("customerScope={buyer:'ungrouped',customer:'all'}");assert.equal(app.run('dashboardData().invoices[0].id'),'C');
  app.run("customerScope={buyer:'buyer:G',customer:'all'};state.buyerGroups=[];normalizeCustomerScope()");assert.equal(app.run('customerScope.buyer'),'all');
});
test('buyer groups can be created by admins with several customers and viewer changes are blocked',async()=>{
  const initial=workspace().run('clone(seed)'),app=workspace(undefined,{state:initial,revision:1,user:{role:'admin'}});
  const choices=[{checked:true,dataset:{buyerCustomer:'Alpha'}},{checked:true,dataset:{buyerCustomer:'Beta'}},{checked:false,dataset:{buyerCustomer:'Other'}}];
  app.context.choices=choices;app.run(`modal=(...args)=>{window.groupModal=args;return {querySelector:s=>document.getElementById(s.slice(1)),querySelectorAll:s=>s==='[data-buyer-customer]'?choices:[]};};showToast=()=>{};window.workspaceAPI=async(route,method,input)=>({state:input.state,revision:2});openBuyerGroupForm();`);
  app.element('buyerGroupName').value='Buyer Group';await app.element('saveBuyerGroup').onclick();assert.equal(app.run('state.buyerGroups[0].customers.length'),2);assert.equal(app.run('workspaceRevision'),2);
  assert.ok(app.run('window.groupModal[2]').includes('data-delete-buyer='));
  app.run(`sharedSession.user.role='viewer';modal=()=>{throw Error('Viewer must not edit groups')};openBuyerGroups();`);
});
test('register bulk import templates map required fields and are available to administrators and editors',()=>{
  const app=workspace(undefined,{state:workspace().run('clone(seed)'),revision:1,user:{role:'admin'}});
  assert.ok(app.run('renderAdvice()').includes('data-action="bulk-import-advice"'));assert.ok(app.run('renderDebit()').includes('data-action="bulk-import-debit"'));
  const {definitions}=require('./lib/import');app.context.importDefinitions=definitions;
  for(const type of ['advice','debitNotes']){
    app.context.registerType=type;
    const mapping=JSON.parse(app.run('JSON.stringify(suggestImportColumns(importDefinitions[registerType].fields,registerImportTemplates[registerType],registerType))'));
    for(const field of definitions[type].fields.filter(f=>f.required))assert.equal(typeof mapping[field.key],'number',type+': '+field.key);
    app.run('downloadRegisterImportTemplate(registerType)');assert.ok(app.context.exportedCSV.endsWith('\r\n'));assert.equal(app.context.exportedCSV.trim().split('\n').length,1);
  }
  app.run(`modal=(...args)=>{window.bulkModal=args;return {querySelector:s=>document.getElementById(s.slice(1))};};openRegisterBulkImport('advice');`);
  assert.ok(app.run('window.bulkModal[2]').includes('Repeat a UTR'));assert.ok(app.run('window.bulkModal[2]').includes('EPC'));
  app.run(`sharedSession.user.role='editor';openRegisterBulkImport('advice');`);
  assert.ok(app.run('renderAdvice()').includes('data-action="bulk-import-advice"'));assert.ok(app.run('renderDebit()').includes('data-action="bulk-import-debit"'));
  app.run(`sharedSession.user.role='viewer';modal=()=>{throw Error('Viewer must not import')};showToast=()=>{};openRegisterBulkImport('advice');`);
  assert.ok(!app.run('renderAdvice()').includes('data-action="bulk-import-advice"'));assert.ok(!app.run('renderDebit()').includes('data-action="bulk-import-debit"'));
});
test('editor import file picker uses the shared connection without opening administrator controls',async()=>{
  const app=workspace(undefined,{state:workspace().run('clone(seed)'),revision:1,user:{role:'editor'}});
  app.run(`openOneDriveFolder=(...args)=>{window.browseArgs=args;};window.workspaceAPI=()=>{throw Error('Editor must not request connector administration')};`);
  await app.run(`openConnect('advice')`);assert.equal(app.run('window.browseArgs[3]'),'advice');
  await app.run(`openConnect('debitNotes')`);assert.equal(app.run('window.browseArgs[3]'),'debitNotes');
});
test('register type survives CSV loading, Excel background preparation and resumed mapping',async()=>{
  const app=workspace();app.run(`window.workspaceAPI=async route=>route==='/api/import/definitions'?{definitions:{}}:{name:'source.csv',sheets:[]};openImportMapping=(...args)=>{window.mappingArgs=args;};`);
  await app.run(`openOneDriveImport('FILE','advice')`);assert.equal(app.run('window.mappingArgs[3]'),'advice');
  app.run(`window.workspaceAPI=async route=>route==='/api/import/definitions'?{definitions:{}}:route==='/api/import-jobs'?{id:'JOB'}:{large:true};watchBulkImport=(...args)=>{window.watchArgs=args;};`);
  await app.run(`openOneDriveImport('FILE','debitNotes')`);assert.equal(app.run('window.watchArgs[1]'),'debitNotes');
  const resumed=workspace();resumed.run(`document.getElementById('bulkJobMarker').dataset.job='JOB';modal=()=>({classList:{contains:()=>false},querySelector:s=>document.getElementById(s.slice(1))});window.workspaceAPI=async route=>route==='/api/import/definitions'?{definitions:{}}:{status:'ready',file_id:'FILE',info:{name:'advice.xlsx',sheets:[]}};openImportMapping=(...args)=>{window.mappingArgs=args;};`);
  await resumed.run(`watchBulkImport('JOB','advice')`);assert.equal(resumed.run('window.mappingArgs[3]'),'advice');
});
test('automatic sync controls display review details safely and exclude viewers',async()=>{
  const app=workspace(undefined,{state:workspace().run('clone(seed)'),revision:1,user:{role:'admin'}});
  app.run(`modal=(...args)=>{window.syncModal=args;return {querySelector:selector=>document.getElementById(selector.slice(1)),querySelectorAll:()=>[]};};window.workspaceAPI=async()=>({sources:[{id:'SOURCE',enabled:1,status:'review',last_success:'2026-11-04T05:00:00Z',config:{name:'bank.xlsx',sheetName:'bank',type:'bank'}}],runs:[{id:'RUN',source_id:'SOURCE',status:'review',created_at:'2026-11-04T05:00:00Z',summary:{counts:{added:1,review:1},reviews:[{row:2,identifier:'<unsafe>',changes:[{field:'Amount',existing:100,source:200}]}]}}]});`);
  await app.run('openSyncSources()');assert.ok(app.run('window.syncModal[2]').includes('data-sync-action="pause"'));assert.ok(app.run('window.syncModal[2]').includes('data-sync-action="run"'));assert.ok(app.run('window.syncModal[2]').includes('&lt;unsafe&gt;'));assert.ok(!app.run('window.syncModal[2]').includes('<unsafe>'));
  app.run(`sharedSession.user.role='editor';sharedSession.user.buyerGroupIds=['G'];window.workspaceAPI=async()=>({scoped:true,sources:[],runs:[],templates:[{id:'APPROVED',name:'source.xlsx',sheetName:'bank',type:'bank'}]});`);await app.run('openSyncSources()');assert.ok(app.run('window.syncModal[2]').includes('data-approved-sync="APPROVED"'));assert.ok(app.run('renderSettings()').includes('data-action="auto-sync"'));assert.ok(!app.run('renderSettings()').includes('data-action="connect-onedrive"'));
  app.run(`sharedSession.user.role='viewer';window.workspaceAPI=()=>{throw Error('Must not fetch sync controls')};showToast=()=>{};`);await app.run('openSyncSources()');
});
test('bank file mapping recognizes transaction ID without confusing narration or customer',()=>{
  const app=workspace();const {definitions,prepareImport}=require('./lib/import');
  app.context.bankFields=definitions.bank.fields;
  const mapping=JSON.parse(app.run(`JSON.stringify(suggestImportColumns(bankFields,['Bank','Date','Narration','Transaction ID','Amount','Customer Name'],'bank'))`));
  assert.deepEqual(mapping,{ref:3,date:1,amount:4,customer:5,narration:2,bankName:0});
  const current={invoices:[],returns:[],priceReturns:[],advice:[],bank:[],debitNotes:[],logs:[],customerTerms:[]};
  const preview=prepareImport({type:'bank',mapping,rows:[['ICICI','02-11-2026','NEFT transfer','MAPPING-TEST-REF',48019.54,'aripl']],startRow:2,dateFormat:'dmy'},current);
  assert.equal(preview.canImport,true);assert.equal(preview.state.bank[0].ref,'MAPPING-TEST-REF');
  assert.equal(preview.state.bank[0].date,'2026-11-02');assert.equal(preview.state.bank[0].amount,48019.54);
  assert.equal(preview.state.bank[0].customer,'aripl');assert.equal(preview.state.bank[0].bankName,'ICICI');assert.equal(preview.state.bank[0].narration,'NEFT transfer');
  for(const header of ['Transaction No','Transaction Number']){
    app.context.referenceHeader=header;
    assert.equal(app.run(`suggestImportColumns(bankFields,[referenceHeader],'bank').ref`),0);
  }
});

test('late refresh responses cannot overwrite a newer save or another refresh',async()=>{
  const initial=workspace().run('clone(seed)');const app=workspace(undefined,{state:initial,revision:1,user:{role:'admin'}});
  let resolveRefresh;app.context.window.workspaceAPI=(route,method,payload)=>method==='PUT'?Promise.resolve({state:payload.state,revision:2}):new Promise(resolve=>{resolveRefresh=resolve;});
  const refresh=app.context.window.refreshWorkspace(true);app.run('state.invoices[0].amount=999');await app.run('persist()');resolveRefresh({state:initial,revision:1});await refresh;
  assert.equal(app.run('workspaceRevision'),2);assert.equal(app.run('state.invoices[0].amount'),999);
  const pending=[];app.context.window.workspaceAPI=()=>new Promise(resolve=>pending.push(resolve));const older=app.context.window.refreshWorkspace(true),newer=app.context.window.refreshWorkspace(true);
  const latest=JSON.parse(JSON.stringify(initial));latest.invoices[0].amount=1234;pending[1]({state:latest,revision:4});await newer;pending[0]({state:initial,revision:3});await older;assert.equal(app.run('workspaceRevision'),4);assert.equal(app.run('state.invoices[0].amount'),1234);assert.equal(app.run('sharedSession.revision'),4);
});
test('open workspaces update due-date ageing and cached status after midnight',()=>{
  const app=workspace();let now=Date.now();const Clock=class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};app.context.Date=Clock;
  app.run(`state.invoices=[{id:'DAY',customer:'Buyer',date:today,amount:100}];state.customerTerms=[{customer:'Buyer',creditDays:0}];state.advice=[];state.returns=[];state.priceReturns=[];invoiceCache=null;window.RECONCILE_TEST_MODE=false;`);
  assert.equal(app.run('allInvoices()[0].ageing'),0);assert.equal(app.run('allInvoices()[0].status'),'due');now+=86400000;assert.equal(app.run('allInvoices()[0].ageing'),1);assert.equal(app.run('allInvoices()[0].status'),'overdue');
});
test('search preserves focus and advice filters and export use the selected rows',()=>{
  const app=workspace();const input=app.element('invoiceSearch');input.id='invoiceSearch';input.value='INV';input.selectionStart=2;input.selectionEnd=2;input.listeners.input({target:input});assert.equal(input.focused,true);assert.equal(input.selectionStart,2);
  app.run(`state.advice=[{id:'A',invoice:'INV1',customer:'Alpha',type:'Payment',description:'NEFT transfer',utr:'U1',amount:20},{id:'B',invoice:'INV2',customer:'Beta',type:'TDS',description:'Tax',utr:'U2',amount:2}];adviceFilter={search:'neft',type:'Payment'};`);
  assert.equal(app.run('filteredAdvice().length'),1);assert.ok(app.run('renderAdvice()').includes('id="adviceTypeFilter"'));app.run("showToast=()=>{};action('export-advice',{})");assert.equal(app.context.exportedCSV.split('\r\n').length,2);assert.ok(app.context.exportedCSV.includes('Alpha'));
});
test('exports protect leading-space formulas and carriage returns and status markup escapes quotes',()=>{
  const app=workspace();assert.equal(app.run('csvEscape("   =1+1")'),"'   =1+1");assert.equal(app.run('csvEscape("a\\rb")'),'"a\rb"');assert.equal(app.run('csvEscape(-10.01)'),'-10.01');
  const html=app.run('statusMarkup(\'x" onmouseover="alert(1)\')');assert.ok(!html.includes('onmouseover="'));assert.ok(html.includes('&quot;'));assert.ok(app.run('fMoney(10.01)').includes('10.01'));
});
test('repeated save clicks do not mutate pending writes and cannot dismiss the saving form',async()=>{
  const initial=workspace().run('clone(seed)'),app=workspace(undefined,{state:initial,revision:1,user:{role:'editor'}});let finish;app.context.window.workspaceAPI=(route,method,payload)=>new Promise(resolve=>{finish=()=>resolve({state:payload.state,revision:2});});
  app.run("showToast=()=>{};openNewInvoice()");for(const [id,value] of Object.entries({newInvId:'ONCE',newInvCustomer:'Buyer',newInvDate:'2026-11-03',newInvAmount:'100',newInvRoundOff:'0'}))app.element(id).value=value;
  let hidden=false;app.element('modalLayer').classList.add=()=>{hidden=true;};const first=app.element('saveInvoice').onclick();await app.element('saveInvoice').onclick();app.run('closeModal()');assert.equal(hidden,false);assert.equal(app.run("state.invoices.filter(x=>x.id==='ONCE').length"),1);finish();await first;assert.equal(hidden,true);assert.equal(app.run("state.invoices.filter(x=>x.id==='ONCE').length"),1);
});
test('delete controls are visible only to admins and deletion requires confirmation',async()=>{
  const initial=workspace().run('clone(state)');initial.advice=[];initial.returns=[];initial.priceReturns=[];initial.debitNotes=[];initial.invoices=[{id:'DELETE-ME',customer:'Buyer',date:'2026-11-03',amount:100}];
  const app=workspace(undefined,{state:initial,revision:4,user:{role:'admin'}});assert.ok(app.run('renderInvoices()').includes('data-delete-collection="invoices"'));assert.ok(app.run('renderBank()').includes('data-delete-collection="bank"'));
  app.run(`modal=(...args)=>{window.deleteModal=args;return {querySelector:selector=>document.getElementById(selector.slice(1))};};showToast=()=>{};window.deleteRequests=[];`);const next=structuredClone(initial);next.invoices=[];app.context.window.workspaceAPI=async(route,method,input)=>{app.context.window.deleteRequests.push({route,method,input});return {state:next,revision:5};};
  app.run("openDeleteEntry('invoices',0)");assert.equal(app.run('window.deleteRequests.length'),0);assert.equal(app.run('state.invoices.length'),1);assert.ok(app.run('window.deleteModal[2]').includes('DELETE-ME'));await app.element('confirmDelete').onclick();assert.equal(app.run('window.deleteRequests[0].route'),'/api/records/delete');assert.equal(app.run('window.deleteRequests[0].input.revision'),4);assert.equal(app.run('state.invoices.length'),0);
  for(const role of ['editor','viewer']){const restricted=workspace(undefined,{state:initial,revision:4,user:{role}});assert.ok(!restricted.run('renderInvoices()').includes('data-delete-collection'));assert.ok(!restricted.run('renderBank()').includes('data-delete-collection'));restricted.run("showToast=()=>{};window.workspaceAPI=()=>{throw new Error('Must not be called')};openDeleteEntry('invoices',0)");assert.equal(restricted.run('state.invoices.length'),1);}
});
test('linked invoice deletion is blocked and stale confirmations never automatically retry',async()=>{
  const initial=workspace().run('clone(state)'),app=workspace(undefined,{state:initial,revision:4,user:{role:'admin'}});app.run(`modal=(...args)=>{window.deleteModal=args;return {querySelector:selector=>document.getElementById(selector.slice(1))};};showToast=()=>{};window.deleteCalls=0;`);
  app.run("openDeleteEntry('invoices',0)");assert.ok(app.run('window.deleteModal[3]').includes('disabled'));app.context.window.workspaceAPI=()=>{throw new Error('Must not be called')};await app.element('confirmDelete').onclick();
  app.run("state.advice=[];state.returns=[];state.priceReturns=[];state.debitNotes=[];openDeleteEntry('invoices',0)");const latest=structuredClone(initial);latest.invoices[0].orderNumber='Changed';app.context.window.workspaceAPI=async(route)=>{if(route==='/api/records/delete'){app.context.window.deleteCalls++;throw Object.assign(new Error('Another user saved changes.'),{status:409});}return {state:latest,revision:6};};await app.element('confirmDelete').onclick();assert.equal(app.run('window.deleteCalls'),1);assert.equal(app.element('confirmDelete').disabled,true);assert.equal(app.run('workspaceRevision'),6);assert.equal(app.run('state.invoices[0].orderNumber'),'Changed');
});
test('legacy customer terms migrate once, persist, and apply to every invoice', () => {
  const original = workspace().run('clone(seed)');
  original.invoices[0].creditDays = 60;
  original.invoices[5].creditDays = 15;
  const app = workspace(original);
  assert.equal(app.run("customerCreditDays('  APEX DISTRIBUTORS PVT LTD ')"), 60);
  assert.equal(app.run("allInvoices().find(x=>x.id==='INV-2026-001777').creditDays"), 60);
  app.run("state.customerTerms.find(t=>t.customer==='Apex Distributors Pvt Ltd').creditDays=90;persist()");
  const restored = workspace(JSON.parse(app.storage.get('reconcileiq-state')));
  assert.equal(restored.run("customerCreditDays('Apex Distributors Pvt Ltd')"), 90);
});

test('import preview commits only on confirmation using the reviewed revision',async()=>{
  const empty={invoices:[],returns:[],priceReturns:[],advice:[],bank:[],debitNotes:[],logs:[],customerTerms:[]};
  const app=workspace(undefined,{user:{role:'admin',email:'admin@example.com'},revision:0,state:empty});
  app.run(`modal=(...args)=>{window.lastImportModal=args;return {querySelector:selector=>document.getElementById(selector.slice(1))};};window.importCalls=[];
    window.workspaceAPI=async(route,method,input)=>{window.importCalls.push({route,method,input});if(route==='/api/import/preview')return {revision:7,counts:{added:1,updated:0,skipped:0,invalid:0,blank:0},errors:[],sample:[],canImport:true};return {revision:8,state:{invoices:[{id:'IMPORTED',customer:'Acme',date:'2026-11-03',amount:100}],returns:[],priceReturns:[],advice:[],bank:[],debitNotes:[],logs:[],customerTerms:[{customer:'Acme',creditDays:45}]}};};`);
  await app.run(`showImportPreview({type:'invoices',rows:[['IMPORTED']],mapping:{id:0},startRow:2},()=>{})`);
  assert.equal(app.run('state.invoices.length'),0);assert.equal(app.run('window.importCalls.length'),1);
  await app.element('confirmImport').onclick();
  assert.equal(app.run('window.importCalls[1].route'),'/api/import');assert.equal(app.run('window.importCalls[1].input.revision'),7);
  assert.equal(app.run('state.invoices[0].id'),'IMPORTED');assert.equal(app.run('workspaceRevision'),8);
});
test('import warnings identify skipped rows and leave valid imports available for confirmation',async()=>{
  const app=workspace();app.run(`modal=(...args)=>{window.warningModal=args;return {querySelector:selector=>document.getElementById(selector.slice(1))};};window.workspaceAPI=async()=>({revision:1,counts:{added:1,skipped:0,updated:0,invalid:0,blank:0,unmatched:1},errors:[],warnings:[{row:2,message:'Unknown invoice INV-X. This row will be skipped.'}],sample:[],canImport:true});`);
  await app.run("showImportPreview({type:'returns'},()=>{})");assert.ok(app.run('window.warningModal[2]').includes('Row 2: Unknown invoice INV-X'));assert.ok(app.run('window.warningModal[2]').includes('valid rows can still be imported'));assert.ok(!app.run('window.warningModal[3]').includes('disabled'));
});
test('large invoice calculations stay accurate while register HTML is paginated',()=>{
  const empty={invoices:[],returns:[],priceReturns:[],advice:[],bank:[],debitNotes:[],logs:[],customerTerms:[{customer:'Bulk',creditDays:45}]};
  empty.invoices=Array.from({length:25001},(_,i)=>({id:`BULK-${i}`,customer:'Bulk',date:'2026-11-03',amount:100}));empty.advice.push({id:'A-1',invoice:'BULK-0',customer:'Bulk',date:'2026-11-03',amount:20,type:'Payment',utr:'U-1'});
  const app=workspace(undefined,{user:{role:'admin'},revision:0,state:empty});assert.equal(app.run('totals().pending'),2500080);
  const html=app.run('renderInvoices()');assert.equal((html.match(/<tr class="clickable"/g)||[]).length,100);assert.equal(app.run('pageCounts.invoices.total'),25001);
  app.run("pagePositions.invoices=1");assert.ok(app.run('renderInvoices()').includes('BULK-100'));assert.equal(app.run("invoiceData(state.invoices[0]).Payment"),20);
});

test('due-date boundary uses customer terms and local calendar date', () => {
  const app = workspace();
  app.run("state.customerTerms=[{customer:'Boundary',creditDays:0}]");
  assert.equal(app.run("invoiceData({id:'test',customer:'Boundary',date:today,amount:100}).status"), 'due');
  app.run("state.customerTerms[0].creditDays=1");
  assert.equal(app.run("invoiceData({id:'test',customer:'Boundary',date:today,amount:100}).status"), 'due');
  assert.equal(app.run("invoiceData({id:'test',customer:'Boundary',date:'2020-01-01',amount:100}).status"), 'overdue');
  assert.equal(app.run("invoiceData({id:'test',customer:'Boundary',date:'2026-01-31',amount:100}).dueDate"), '2026-02-01');
});

test('customer and dashboard categories exclude settlements and excess payments', () => {
  const app = workspace();
  app.run(`state.invoices=[
    {id:'old',customer:'Test',date:'2020-01-01',amount:100},
    {id:'due',customer:'Test',date:today,amount:200},
    {id:'settled',customer:'Test',date:today,amount:0},
    {id:'credit',customer:'Test',date:today,amount:-50}
  ];state.advice=[];state.returns=[];state.priceReturns=[];
  state.customerTerms=[{customer:'Test',creditDays:30}];`);
  assert.equal(app.run('totals().overdue'), 100);
  assert.equal(app.run('totals().due'), 200);
  assert.equal(app.run('customerRows()[0].overdue'), 100);
  assert.equal(app.run('customerRows()[0].due'), 200);
  app.run('state.customerTerms[0].creditDays=10000');
  assert.equal(app.run('totals().overdue'), 0);
  assert.equal(app.run('totals().due'), 300);
});

test('dashboard brand filter scopes balances, adjustments, payment charts, customers and exports',()=>{
  const app=workspace();
  app.run(`state.invoices=[
    {id:'A-1',customer:'Shared Buyer',brandName:'Brand A',date:today,amount:1000},
    {id:'A-2',customer:'Shared Buyer',brandName:' brand a ',date:'2020-01-01',amount:200},
    {id:'B-1',customer:'Other Buyer',brandName:'Brand B',date:today,amount:500},
    {id:'UNBRANDED',customer:'Unbranded Buyer',date:today,amount:75}
  ];state.customerTerms=[{customer:'Shared Buyer',creditDays:45},{customer:'Other Buyer',creditDays:45},{customer:'Unbranded Buyer',creditDays:45}];
  state.advice=[{id:'P-A',invoice:'A-1',type:'Payment',amount:100,date:today},{id:'T-A',invoice:'A-2',type:'TDS',amount:20,date:today},{id:'P-B',invoice:'B-1',type:'Payment',amount:200,date:today},{id:'P-U',invoice:'UNBRANDED',type:'Payment',amount:15,date:today},{id:'UNALLOCATED',type:'Payment',amount:9999,date:today}];
  state.returns=[{invoice:'A-1',amount:50}];state.priceReturns=[{invoice:'A-2',amount:10}];dashboardBrand='brand:brand a';`);
  assert.equal(app.run('dashboardData().invoices.length'),2);assert.equal(app.run("dashboardData().options.filter(x=>x.value==='brand:brand a').length"),1);
  assert.equal(app.run('totals(dashboardData().invoices).invoice'),1200);assert.equal(app.run('totals(dashboardData().invoices).pending'),1020);
  assert.equal(app.run('totals(dashboardData().invoices).due'),850);assert.equal(app.run('totals(dashboardData().invoices).overdue'),170);
  assert.equal(app.run('sum(dashboardData().payments,x=>x.amount)'),100);assert.equal(app.run('customerRows(dashboardData().invoices).length'),1);
  assert.equal(app.run('customerRows(dashboardData().invoices)[0].pending'),1020);
  const html=app.run('renderDashboard()');assert.ok(html.includes('Filter dashboard by brand'));assert.ok(html.includes('2 of 4 invoices'));assert.ok(!html.includes('Other Buyer'));assert.ok(html.includes(`class="bar payment" title="${app.run('fMoney(100)')}"`));
  app.run("showToast=()=>{};action('export-dashboard',{})");assert.equal(app.context.exportedCSV.split('\r\n').length,3);assert.ok(app.context.exportedCSV.includes('A-1'));assert.ok(!app.context.exportedCSV.includes('B-1'));
  app.run("dashboardBrand='unassigned'");assert.equal(app.run('dashboardData().invoices[0].id'),'UNBRANDED');assert.equal(app.run('totals(dashboardData().invoices).pending'),60);assert.equal(app.run('sum(dashboardData().payments,x=>x.amount)'),15);
  app.run("dashboardBrand='all'");assert.equal(app.run('totals(dashboardData().invoices).pending'),1380);assert.equal(app.run('sum(dashboardData().payments,x=>x.amount)'),315);
  assert.equal(app.run('state.invoices.length'),4);
});

test('dashboard handles empty data and brand removal without leaving a stale selection',()=>{
  const app=workspace();app.run("state.invoices=[];state.advice=[];state.returns=[];state.priceReturns=[];dashboardBrand='brand:missing';");
  assert.equal(app.run('dashboardData().invoices.length'),0);assert.equal(app.run('dashboardBrand'),'all');assert.ok(app.run('renderDashboard()').includes('0 of 0 invoices'));
});

test('customer credit form validates and saves terms across invoices', async () => {
  const app = workspace();
  app.run('showToast=()=>{};openCustomerTerms()');
  const input = { value: '-1', dataset: { termIndex: '0' } };
  app.context.document.querySelectorAll = selector => selector === '[data-term-index]' ? [input] : [];
  await app.element('saveCustomerTerms').onclick();
  assert.equal(app.run('state.customerTerms[0].creditDays'), 45);
  input.value = '60.5';
  await app.element('saveCustomerTerms').onclick();
  assert.equal(app.run('state.customerTerms[0].creditDays'), 45);
  input.value = '60';
  await app.element('saveCustomerTerms').onclick();
  assert.equal(app.run('allInvoices()[0].creditDays'), 60);
  assert.equal(app.run('allInvoices()[5].creditDays'), 60);
});

test('new invoice inherits terms without per-invoice credit or material inputs', async () => {
  const app = workspace();
  app.run('showToast=()=>{};openNewInvoice()');
  const html = app.element('modalLayer').innerHTML;
  assert.ok(!html.includes('newInvCreditDays'));
  assert.ok(!html.includes('newInvProduct'));
  for (const [id, value] of Object.entries({newInvId:'NEW',newInvOrderNumber:'000123',newInvBrandName:'Urban & Co',newInvCustomer:'New Customer',newInvAmount:'500',newInvDate:'2026-11-02',newInvRoundOff:'0'})) app.element(id).value = value;
  await app.element('saveInvoice').onclick();
  assert.equal(app.run("customerCreditDays('New Customer')"), 45);
  assert.equal(app.run('allInvoices()[0].creditDays'), 45);
  assert.equal(app.run('allInvoices()[0].pending'), 500);
  assert.equal(app.run('state.invoices[0].orderNumber'),'000123');
  assert.equal(app.run('state.invoices[0].brandName'),'Urban & Co');
  assert.ok(app.run('renderInvoices()').includes('<th>Order number</th>'));
  app.run("invoiceFilter.search='000123'");assert.equal((app.run('renderInvoices()').match(/<tr class="clickable"/g)||[]).length,1);
  assert.ok(app.run('renderInvoices()').includes('<th>Brand name</th>'));assert.ok(app.run('renderInvoices()').includes('Urban &amp; Co'));
  app.run("invoiceFilter.search='urban & co'");assert.equal((app.run('renderInvoices()').match(/<tr class="clickable"/g)||[]).length,1);
  app.run("showToast=()=>{};exportReport('Invoice Outstanding')");assert.ok(app.context.exportedCSV.startsWith('Invoice,Order number,Brand name,Customer,'));assert.ok(app.context.exportedCSV.includes('NEW,000123,Urban & Co,New Customer'));
  app.run("action('reset-data',{})");
  assert.equal(app.run('state.customerTerms.length'), 6);
  assert.equal(app.run('allInvoices()[0].creditDays'), 45);
});

test('multi-brand invoices retain one ledger identity and allocate dashboard balances proportionally',()=>{
  const app=workspace();
  app.run(`state.invoices=[{id:'MIX',customer:'Buyer',date:'2026-11-01',amount:1000,brandName:'A / B',brandAmounts:[{brandName:'A',amount:800},{brandName:'B',amount:200}]}];state.advice=[{id:'P',invoice:'MIX',customer:'Buyer',date:'2026-11-02',type:'Payment',amount:500}];state.returns=[];state.priceReturns=[];dashboardBrand='brand:a'`);
  assert.equal(app.run('dashboardData().invoices.length'),1);assert.equal(app.run('totals(dashboardData().invoices).invoice'),800);assert.equal(app.run('totals(dashboardData().invoices).pending'),400);assert.equal(app.run('dashboardData().payments[0].amount'),400);
  app.run("dashboardBrand='brand:b'");assert.equal(app.run('totals(dashboardData().invoices).pending'),100);
  app.run("dashboardBrand='all'");assert.equal(app.run('totals(dashboardData().invoices).invoice'),1000);assert.equal(app.run('totals(dashboardData().invoices).pending'),500);assert.equal(app.run('allInvoices().length'),1);
});
test('invoice ageing uses due dates, keeps negative days, and sorts before pagination',()=>{
  const app=workspace();app.run(`
    const shift=days=>new Date(Date.parse(today)+days*86400000).toISOString().slice(0,10);
    state.invoices=[{id:'FUTURE',customer:'Buyer',date:shift(5),amount:100},{id:'TODAY',customer:'Buyer',date:today,amount:100},{id:'OLDEST',customer:'Buyer',date:shift(-90),amount:100}];
    state.customerTerms=[{customer:'Buyer',creditDays:0}];state.advice=[];state.returns=[];state.priceReturns=[];
  `);
  assert.equal(app.run("allInvoices().find(x=>x.id==='FUTURE').ageing"),-5);assert.equal(app.run("allInvoices().find(x=>x.id==='TODAY').ageing"),0);
  assert.equal(app.run("invoiceRegisterData().invoices.map(x=>x.id).join(',')"),'OLDEST,TODAY,FUTURE');
  app.run('state.customerTerms[0].creditDays=30');assert.equal(app.run("allInvoices().find(x=>x.id==='OLDEST').ageing"),60);
  assert.ok(app.run('renderInvoices()').includes('Ageing (days) ↓'));
  app.run("globalThis.detailMarkup='';modal=(title,subtitle,content)=>{detailMarkup=content};openInvoice('OLDEST')");
  assert.ok(!app.run('detailMarkup').includes('<span>Quantity</span>'));assert.ok(!app.run('detailMarkup').includes('<span>Rate</span>'));assert.ok(app.run('detailMarkup').includes('60 days'));
});
test('invoice brand and customer filters combine, preserve full mixed-brand invoices and export the selection',()=>{
  const app=workspace();app.run(`state.invoices=[
    {id:'MIX',customer:'Alpha',date:today,amount:100,brandName:'A / B',brandAmounts:[{brandName:'A',amount:80},{brandName:'B',amount:20}]},
    {id:'BETA',customer:'Beta',date:today,amount:200,brandName:'B'},
    {id:'BLANK',customer:'Alpha',date:today,amount:300}
  ];state.advice=[];state.returns=[];state.priceReturns=[];invoiceFilter.brand='brand:b';invoiceFilter.customer='customer:alpha';`);
  assert.equal(app.run("invoiceRegisterData().invoices.map(x=>x.id).join(',')"),'MIX');assert.equal(app.run('invoiceRegisterData().invoices[0].amount'),100);
  const html=app.run('renderInvoices()');assert.ok(html.includes('id="invoiceBrandFilter"'));assert.ok(app.run('customerScopeMarkup()').includes('id="scopeCustomer"'));assert.ok(html.includes('value="brand:b" selected'));
  app.run("showToast=()=>{};action('export-invoices',{})");assert.equal(app.context.exportedCSV.split('\r\n').length,2);assert.ok(app.context.exportedCSV.includes('Ageing Days'));
  app.run("invoiceFilter.brand='unassigned'");assert.equal(app.run("invoiceRegisterData().invoices[0].id"),'BLANK');
  app.run("pagePositions.invoices=9;action('clear-filters',{})");assert.equal(app.run('invoiceRegisterData().invoices.length'),3);assert.equal(app.run('pagePositions.invoices'),0);
});
test('customer export carries both balance categories and customer credit days', () => {
  const app = workspace();
  app.run("showToast=()=>{};exportReport('Customer Outstanding')");
  const lines = app.context.exportedCSV.split('\r\n');
  assert.ok(lines[0].endsWith('Credit Days,Overdue,Due,Pending Amount'));
  assert.equal(lines.length, 7);
  for (const line of lines) assert.equal(line.split(',').length, 12);
});

test('a rejected shared save preserves form input and never reports success', async()=>{
  const initial=workspace().run('clone(seed)');
  const app=workspace(undefined,{state:initial,revision:4,user:{name:'Editor',role:'editor'}});
  app.context.window.workspaceAPI=async()=>{throw new Error('Connection lost. Try again.');};
  app.run("globalThis.messages=[];showToast=message=>messages.push(message);openNewInvoice()");
  for(const [id,value] of Object.entries({newInvId:'RETRY',newInvCustomer:'Buyer',newInvDate:'2026-11-02',newInvAmount:'150',newInvRoundOff:'0'}))app.element(id).value=value;
  await app.element('saveInvoice').onclick();
  assert.equal(app.element('newInvId').value,'RETRY');
  assert.equal(app.run("state.invoices.some(row=>row.id==='RETRY')"),false);
  assert.equal(app.run('messages.at(-1)'),'Connection lost. Try again.');
  app.context.window.workspaceAPI=async(route,method,payload)=>({state:payload.state,revision:5});
  await app.element('saveInvoice').onclick();
  assert.equal(app.run("state.invoices.filter(row=>row.id==='RETRY').length"),1);
  assert.equal(app.run('workspaceRevision'),5);
});

test('EPC settles the invoice as a deduction while bank matching uses cash only and debit notes are not counted twice',async()=>{
  const app=workspace();app.run(`showToast=()=>{};state.invoices=[{id:'EPC-I',customer:'Buyer',date:today,amount:1000,brandName:'A / B',brandAmounts:[{brandName:'A',amount:800},{brandName:'B',amount:200}]}];state.returns=[];state.priceReturns=[];state.advice=[{id:'P',invoice:'EPC-I',customer:'Buyer',date:today,type:'Payment',amount:900,utr:'U'},{id:'E',invoice:'EPC-I',customer:'Buyer',date:today,type:'EPC',amount:100,utr:'U'}];state.bank=[{ref:'U',customer:'Buyer',date:today,amount:900,status:'unmatched'}];state.debitNotes=[{id:'D',invoice:'EPC-I',customer:'Buyer',date:today,type:'EPC',amount:100,status:'Unmapped'}];`);
  assert.equal(app.run('allInvoices()[0].EPC'),100);assert.equal(app.run('allInvoices()[0].Payment'),900);assert.equal(app.run('allInvoices()[0].pending'),0);assert.equal(app.run('allInvoices()[0].autoRoundOff'),0);assert.equal(app.run('totals().epc'),100);assert.equal(app.run('customerRows()[0].epc'),100);
  app.run("modal=(title,subtitle,content)=>{window.epcDetails=content};openInvoice('EPC-I')");assert.ok(app.run('window.epcDetails').includes('<span>EPC</span>'));
  app.run("exportReport('Invoice Outstanding')");const lines=app.context.exportedCSV.split('\r\n').map(line=>line.split(','));assert.equal(lines[1][lines[0].indexOf('EPC')],'100');assert.equal(lines[1][lines[0].indexOf('Payment')],'900');
  app.run("dashboardBrand='brand:a'");assert.equal(app.run('dashboardData().invoices[0].EPC'),80);assert.equal(app.run('totals(dashboardData().invoices).pending'),0);
  await app.run('matchEligible()');assert.equal(app.run('state.bank[0].status'),'matched');assert.equal(app.run('state.bank[0].amount'),900);
});
test('EPC entry can use a matched receipt without offering that receipt for another cash Payment',async()=>{
  const app=workspace();app.run(`showToast=()=>{};state.invoices=[{id:'I',customer:'Buyer',date:today,amount:1000}];state.returns=[];state.priceReturns=[];state.advice=[{id:'P',invoice:'I',customer:'Buyer',date:today,type:'Payment',amount:900,utr:'U'}];state.bank=[{ref:'U',customer:'Buyer',date:today,amount:900,status:'matched'}];openAdvice();`);
  assert.equal(app.run('availableBankReceipts().length'),0);app.element('advType').value='EPC';app.element('advType').onchange();assert.ok(app.element('advUtr').innerHTML.includes('value="U"'));
  app.element('advUtr').value='U';app.element('advUtr').onchange();app.element('advInvoice').value='I';app.element('advType').value='Payment';app.element('advType').onchange();assert.equal(app.element('advUtr').value,'');assert.equal(app.element('advInvoice').value,'');
  app.element('advType').value='EPC';app.element('advType').onchange();app.element('advUtr').value='U';app.element('advUtr').onchange();app.element('advInvoice').value='I';app.element('advAmount').value='100';app.element('advDescription').value='EPC deduction';await app.element('saveAdvice').onclick();assert.equal(app.run('allInvoices()[0].pending'),0);assert.equal(app.run('state.bank[0].status'),'matched');assert.equal(app.run('state.advice[0].type'),'EPC');
});
test('automatic round-off settles signed balances through ten rupees inclusive without changing the ledger',()=>{
  const app=workspace();app.run(`state.invoices=[{id:'ROUND',customer:'Buyer',date:today,amount:1000,roundOff:0}];state.returns=[];state.priceReturns=[];state.advice=[{invoice:'ROUND',type:'Payment',amount:1000}];`);
  for(const remainder of [-10.01,-10,-9.99,-0.01,0,0.01,9.99,10,10.01]){
    app.context.testRemainder=remainder;app.run('state.advice[0].amount=1000-testRemainder');const invoice=app.run('allInvoices()[0]');
    const shouldRound=Math.abs(remainder)<=10;assert.equal(invoice.pending,shouldRound?0:remainder);assert.equal(invoice.autoRoundOff,shouldRound?remainder:0);assert.equal(invoice.roundOff,shouldRound?remainder:0);assert.equal(invoice.status==='settled',shouldRound);assert.equal(app.run('state.invoices[0].roundOff'),0);
  }
  app.run('state.invoices[0].amount=100.3;state.advice[0].amount=90.3');assert.equal(app.run('allInvoices()[0].pending'),0);assert.equal(app.run('allInvoices()[0].autoRoundOff'),10);
});
test('automatic round-off recomputes after returns and payments and appears in totals and exports',()=>{
  const app=workspace();app.run(`state.invoices=[{id:'ROUND',customer:'Buyer',date:today,amount:1000,roundOff:5,brandName:'A / B',brandAmounts:[{brandName:'A',amount:800},{brandName:'B',amount:200}]}];state.returns=[{invoice:'ROUND',amount:20}];state.priceReturns=[{invoice:'ROUND',amount:5}];state.advice=[{invoice:'ROUND',type:'Payment',amount:960},{invoice:'ROUND',type:'TDS',amount:2}];`);
  assert.equal(app.run('allInvoices()[0].autoRoundOff'),8);assert.equal(app.run('allInvoices()[0].roundOff'),13);assert.equal(app.run('totals().pending'),0);assert.equal(app.run('customerRows()[0].pending'),0);
  app.run("showToast=()=>{};exportReport('Invoice Outstanding')");assert.ok(app.context.exportedCSV.includes('Manual Round Off,Automatic Round Off,Round Off'));assert.ok(app.context.exportedCSV.includes(',5,8,13,0,settled'));
  app.run("dashboardBrand='brand:a'");assert.equal(app.run('dashboardData().invoices[0].autoRoundOff'),6.4);assert.equal(app.run('totals(dashboardData().invoices).pending'),0);
  app.run('state.advice[0].amount=950');assert.equal(app.run('allInvoices()[0].pending'),18);assert.equal(app.run('allInvoices()[0].autoRoundOff'),0);assert.equal(app.run('allInvoices()[0].roundOff'),5);
  app.run('state.advice[0].amount=975');assert.equal(app.run('allInvoices()[0].autoRoundOff'),-7);assert.equal(app.run('allInvoices()[0].pending'),0);assert.equal(app.run('state.invoices[0].roundOff'),5);
  app.run('state.advice.forEach(row=>row.date=today)');const reloaded=workspace(JSON.parse(app.run('JSON.stringify(state)')));assert.equal(reloaded.run('allInvoices()[0].pending'),0);assert.equal(reloaded.run('allInvoices()[0].autoRoundOff'),-7);
});
test('round-off form retries against latest data after another user saves',async()=>{
  const initial=workspace().run('clone(seed)');
  const app=workspace(undefined,{state:initial,revision:4,user:{name:'Editor',role:'editor'}});
  const latest=JSON.parse(JSON.stringify(initial));latest.invoices[0].amount=600000;
  let requests=0;
  app.context.window.workspaceAPI=async(route,method,payload)=>{
    if(method==='PUT'&&requests++===0){const error=new Error('Another user saved changes.');error.status=409;throw error;}
    if(method==='PUT')return{state:payload.state,revision:6};
    return{state:latest,revision:5};
  };
  app.run("showToast=()=>{};openRoundOff('INV-2026-001842')");
  app.element('roundOffAmount').value='2.50';
  await app.element('saveRoundOff').onclick();
  assert.equal(app.run('workspaceRevision'),5);
  assert.equal(app.run('state.invoices[0].amount'),600000);
  assert.equal(app.element('roundOffAmount').value,'2.50');
  await app.element('saveRoundOff').onclick();
  assert.equal(app.run('state.invoices[0].roundOff'),2.5);
  assert.equal(app.run('state.invoices[0].amount'),600000);
  assert.equal(app.run('workspaceRevision'),6);
});

test('bank entry requires a customer and displays and exports narration and bank name',async()=>{
  const app=workspace();app.run('showToast=()=>{};openBankReceipt()');
  for(const [id,value] of Object.entries({bankRef:'NEW-UTR',bankDate:'2026-11-03',bankAmount:'150',bankCustomer:' ',bankNarration:'Receipt & transfer',bankName:'HDFC'}))app.element(id).value=value;
  await app.element('saveBank').onclick();assert.equal(app.run("state.bank.some(x=>x.ref==='NEW-UTR')"),false);
  app.element('bankCustomer').value='Acme';await app.element('saveBank').onclick();
  assert.equal(app.run("state.bank.find(x=>x.ref==='NEW-UTR').bankName"),'HDFC');assert.ok(app.run('renderBank()').includes('Receipt &amp; transfer'));assert.ok(app.run('renderBank()').includes('<th>Bank name</th>'));
  app.run("exportReport('Bank Reconciliation')");assert.ok(app.context.exportedCSV.startsWith('Date,Bank Reference,Customer,Narration,Bank Name,'));assert.ok(app.context.exportedCSV.includes('Receipt & transfer,HDFC'));
});
test('payment advice hides number and date and requires allocation details before saving',async()=>{
  const app=workspace();app.run("showToast=()=>{};state.bank.find(row=>row.status==='unmatched').customer=state.invoices[0].customer;openAdvice()");
  const invoice=app.run('state.invoices[0]'),bank=app.run("state.bank.find(x=>x.status==='unmatched')");
  for(const [id,value] of Object.entries({advCustomer:invoice.customer,advInvoice:invoice.id,advType:'Payment',advAmount:'10',advDescription:'Receipt allocated',advUtr:bank.ref}))app.element(id).value=value;
  for(const id of ['advInvoice','advType','advAmount','advDescription']){const previous=app.element(id).value;app.element(id).value='';const before=app.run('state.advice.length');await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice.length'),before);app.element(id).value=previous;}
  await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice[0].description'),'Receipt allocated');assert.match(app.run('state.advice[0].id'),/^PA-/);assert.equal(app.run('state.advice[0].date'),app.run('today'));
  assert.ok(!app.run('renderAdvice()').includes('<th>Advice number</th>'));assert.ok(!app.run('renderAdvice()').includes('<th>Date</th>'));
  app.run("exportReport('Payment Advice')");assert.ok(app.context.exportedCSV.startsWith('Customer,Invoice,Transaction Type,Transaction Description,Amount,Bank Reference / UTR'));
});
test('receipt selection filters invoices to its buyer and rejects a forged invoice selection',async()=>{
  const app=workspace();app.run(`showToast=()=>{};state.invoices=[{id:'FLIP',customer:'Flipkart',date:today,amount:100},{id:'OTHER',customer:'Other buyer',date:today,amount:100}];state.bank=[{ref:'F-UTR',customer:'Flipkart',date:today,amount:100,status:'unmatched'},{ref:'O-UTR',customer:'Other buyer',date:today,amount:100,status:'unmatched'}];state.advice=[];openAdvice();`);
  app.element('advUtr').value='F-UTR';app.element('advUtr').onchange();assert.equal(app.element('advCustomer').value,'Flipkart');assert.ok(app.element('advInvoice').innerHTML.includes('FLIP'));assert.ok(!app.element('advInvoice').innerHTML.includes('OTHER'));
  for(const [id,value] of Object.entries({advInvoice:'OTHER',advAmount:'10',advType:'Payment',advDescription:'Receipt'}))app.element(id).value=value;await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice.length'),0);
  app.element('advInvoice').value='FLIP';await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice[0].customer'),'Flipkart');
  app.run('openAdvice()');app.element('advUtr').value='O-UTR';app.element('advInvoice').value='FLIP';app.element('advUtr').onchange();assert.equal(app.element('advInvoice').value,'');assert.ok(!app.element('advInvoice').innerHTML.includes('FLIP'));
});
test('automatic matching cannot relabel a payment to the buyer of mismatched advice',async()=>{
  const app=workspace();app.run("showToast=()=>{};state.bank=[{ref:'U',customer:'Flipkart',amount:100,status:'unmatched'}];state.advice=[{id:'A',utr:'U',customer:'Other buyer',type:'Payment',amount:100}];");await app.run('matchEligible()');assert.equal(app.run('state.bank[0].status'),'unmatched');assert.equal(app.run('state.bank[0].customer'),'Flipkart');
});
test('one receipt funds multiple invoices and shows only its remaining cash in queues and advice',async()=>{
  const app=workspace();app.run(`showToast=()=>{};state.invoices=[{id:'I1',customer:'Buyer',date:today,amount:3000},{id:'I2',customer:'Buyer',date:today,amount:7000}];state.bank=[{ref:'SPLIT',customer:'Buyer',date:today,amount:10000,status:'unmatched'}];state.advice=[{id:'P1',invoice:'I1',customer:'Buyer',date:today,type:'Payment',amount:3000,utr:'SPLIT'},{id:'P2',invoice:'I2',customer:'Buyer',date:today,type:'Payment',amount:4000,utr:'SPLIT'},{id:'E',invoice:'I2',customer:'Buyer',date:today,type:'EPC',amount:100,utr:'SPLIT'}];state.returns=[];state.priceReturns=[];`);
  assert.equal(app.run('bankRows()[0].allocatedAmount'),7000);assert.equal(app.run('bankRows()[0].pendingToMatch'),3000);assert.equal(app.run('bankRows()[0].allocationCount'),2);assert.equal(app.run('unallocatedRows()[0].amount'),3000);assert.ok(app.run('renderBank()').includes('Pending to match'));
  app.run("openAdvice('SPLIT')");assert.equal(app.element('advPending').value,app.run('fMoney(3000)'));app.element('advInvoice').value='I2';app.element('advType').value='Payment';app.element('advAmount').value='3000.01';app.element('advDescription').value='Final cash allocation';await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice.length'),3);
  app.element('advAmount').value='3000';await app.element('saveAdvice').onclick();assert.equal(app.run('bankRows()[0].pendingToMatch'),0);assert.equal(app.run('bankRows()[0].status'),'matched');assert.equal(app.run('unallocatedRows().length'),0);assert.equal(app.run('availableBankReceipts().length'),0);assert.equal(app.run("availableBankReceipts('EPC').length"),1);
  app.run("exportReport('Bank Reconciliation')");const exported=require('csv-parse/sync').parse(app.context.exportedCSV);assert.equal(exported[1][exported[0].indexOf('Allocated Payment')],'10000');assert.equal(exported[1][exported[0].indexOf('Pending to Match')],'0');
});
test('bank matching preserves paise even when invoice round-off clears a small invoice balance',()=>{
  const app=workspace();app.run("state.invoices=[{id:'I',customer:'Buyer',date:today,amount:1}];state.advice=[{id:'P',invoice:'I',customer:'Buyer',date:today,type:'Payment',amount:0.99,utr:'U'}];state.bank=[{ref:'U',customer:'Buyer',date:today,amount:1,status:'unmatched'}];state.returns=[];state.priceReturns=[];");assert.equal(app.run('allInvoices()[0].pending'),0);assert.equal(app.run('bankRows()[0].pendingToMatch'),0.01);assert.equal(app.run('bankRows()[0].status'),'review');
});
test('Difference receipts appear in unallocated queue and export and can complete same-buyer allocation',async()=>{
  const app=workspace();app.run(`showToast=()=>{};state.invoices=[{id:'I',customer:'Flipkart',date:today,amount:1000},{id:'M',customer:'Flipkart',date:today,amount:30}];state.bank=[{ref:'REVIEW-UTR-TEST',customer:'Flipkart',date:today,amount:1000,status:'review'},{ref:'UNMATCHED',customer:'Flipkart',date:today,amount:20,status:'unmatched'},{ref:'MATCHED',customer:'Flipkart',date:today,amount:30,status:'matched'}];state.advice=[{id:'P',invoice:'I',customer:'Flipkart',date:today,type:'Payment',amount:900,utr:'REVIEW-UTR-TEST'},{id:'PM',invoice:'M',customer:'Flipkart',date:today,type:'Payment',amount:30,utr:'MATCHED'}];state.returns=[];state.priceReturns=[];`);
  assert.equal(app.run('unallocatedRows().length'),2);const html=app.run('renderUnallocated()');assert.ok(html.includes('REVIEW-UTR-TEST'));assert.ok(html.includes('Difference / reconciliation review required'));assert.ok(html.includes('Flipkart'));assert.ok(!html.includes('>MATCHED</td>'));
  app.run("exportReport('Unallocated Transactions')");assert.ok(app.context.exportedCSV.includes('REVIEW-UTR-TEST,Flipkart'));assert.ok(app.context.exportedCSV.includes('Difference / reconciliation review required'));
  app.run("action('allocate-receipt',{ref:'REVIEW-UTR-TEST'})");assert.equal(app.element('advUtr').value,'REVIEW-UTR-TEST');assert.equal(app.element('advCustomer').value,'Flipkart');app.element('advInvoice').value='I';app.element('advType').value='Payment';app.element('advAmount').value='100';app.element('advDescription').value='Balance allocation';await app.element('saveAdvice').onclick();assert.equal(app.run('allInvoices()[0].pending'),0);
  await app.run('matchEligible()');assert.equal(app.run('state.bank[0].status'),'matched');assert.equal(app.run("unallocatedRows().some(row=>row.ref==='REVIEW-UTR-TEST')"),false);
});
test('one advice form saves multiple invoice rows atomically under one UTR and rejects invalid totals',async()=>{
  const initial=workspace().run('clone(state)');initial.invoices=[{id:'I1',customer:'Buyer',date:'2026-11-04',amount:6000},{id:'I2',customer:'Buyer',date:'2026-11-04',amount:4000},{id:'OTHER',customer:'Other',date:'2026-11-04',amount:10000}];initial.bank=[{ref:'U',customer:'Buyer',date:'2026-11-04',amount:10000,status:'unmatched'}];initial.advice=[];initial.returns=[];initial.priceReturns=[];initial.debitNotes=[];
  const app=workspace(undefined,{state:initial,revision:1,user:{role:'editor'}});let saves=0,payload;app.context.window.workspaceAPI=async(route,method,input)=>{saves++;payload=JSON.parse(JSON.stringify(input));return {state:input.state,revision:2};};app.run("showToast=()=>{};openAdvice('U')");
  app.element('advInvoice').value='I1';app.element('advAmount').value='6000';app.element('advDescription').value='Split payment';app.element('advAddLine').onclick();assert.ok(app.element('advRows').innerHTML.includes('Invoice row 2'));assert.equal(app.element('advDescription-1').value,'Split payment');assert.ok(!app.element('advInvoice-1').innerHTML.includes('OTHER'));
  app.element('advAmount-1').value='4000';await app.element('saveAdvice').onclick();assert.equal(saves,0);assert.equal(app.run('state.advice.length'),0);
  app.element('advInvoice-1').value='I2';app.element('advAmount-1').value='4000.01';await app.element('saveAdvice').onclick();assert.equal(saves,0);assert.equal(app.run('state.advice.length'),0);
  app.element('advAmount-1').value='4000';app.element('advAmount-1').oninput();assert.ok(app.element('adviceBatchSummary').textContent.includes('2 invoice rows'));await app.element('saveAdvice').onclick();assert.equal(saves,1);assert.equal(payload.state.advice.length,2);assert.equal(payload.state.advice[0].id,payload.state.advice[1].id);assert.equal(payload.state.advice[0].utr,'U');assert.equal(app.run('bankRows()[0].pendingToMatch'),0);
});
test('a failed batch save preserves every row and a committed batch is not duplicated after a conflict',async()=>{
  const initial=workspace().run('clone(state)');initial.invoices=[{id:'I1',customer:'Buyer',date:'2026-11-04',amount:60},{id:'I2',customer:'Buyer',date:'2026-11-04',amount:40}];initial.bank=[{ref:'U',customer:'Buyer',date:'2026-11-04',amount:100,status:'unmatched'}];initial.advice=[];initial.returns=[];initial.priceReturns=[];initial.debitNotes=[];const app=workspace(undefined,{state:initial,revision:1,user:{role:'editor'}});app.run("showToast=()=>{};openAdvice('U')");app.element('advInvoice').value='I1';app.element('advAmount').value='60';app.element('advDescription').value='Group';app.element('advAddLine').onclick();app.element('advInvoice-1').value='I2';app.element('advAmount-1').value='40';
  app.context.window.workspaceAPI=async()=>{throw new Error('Connection lost');};await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice.length'),0);assert.equal(app.element('advInvoice-1').value,'I2');assert.equal(app.element('advAmount-1').value,'40');
  let committed,calls=0;app.context.window.workspaceAPI=async(route,method,input)=>{if(method==='PUT'){calls++;committed=JSON.parse(JSON.stringify(input.state));throw Object.assign(new Error('The previous save completed.'),{status:409});}return {state:committed,revision:2};};await app.element('saveAdvice').onclick();assert.equal(calls,1);assert.equal(app.run('state.advice.length'),2);assert.equal(app.run('workspaceRevision'),2);
});
test('draft invoice rows can be removed and invoice searches find results beyond the first hundred',async()=>{
  const app=workspace();app.run("showToast=()=>{};state.invoices=Array.from({length:150},(_,i)=>({id:'I'+i,customer:'Buyer',date:today,amount:100}));state.bank=[{ref:'U',customer:'Buyer',date:today,amount:10000,status:'unmatched'}];state.advice=[];state.returns=[];state.priceReturns=[];openAdvice('U')");
  assert.ok(!app.element('advInvoice').innerHTML.includes('value="I149"'));app.element('advSearch').value='I149';app.element('advSearch').oninput();assert.ok(app.element('advInvoice').innerHTML.includes('value="I149"'));
  app.element('advInvoice').value='I149';app.element('advAmount').value='100';app.element('advDescription').value='Receipt';app.element('advAddLine').onclick();app.element('advInvoice-1').value='I1';app.element('advAmount-1').value='100';app.element('advRemove-0').onclick();assert.ok(!app.element('advRows').innerHTML.includes('id="advInvoice"'));await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice.length'),1);assert.equal(app.run('state.advice[0].invoice'),'I1');
});
test('the same invoice can have Payment and EPC rows in a single advice entry',async()=>{
  const app=workspace();app.run("showToast=()=>{};state.invoices=[{id:'I',customer:'Buyer',date:today,amount:1000}];state.bank=[{ref:'U',customer:'Buyer',date:today,amount:900,status:'unmatched'}];state.advice=[];state.returns=[];state.priceReturns=[];openAdvice('U')");app.element('advInvoice').value='I';app.element('advAmount').value='900';app.element('advDescription').value='Cash';app.element('advAddLine').onclick();app.element('advInvoice-1').value='I';app.element('advAmount-1').value='100';app.element('advType-1').value='EPC';app.element('advType-1').onchange();await app.element('saveAdvice').onclick();assert.equal(app.run('state.advice.length'),2);assert.equal(app.run('allInvoices()[0].pending'),0);assert.equal(app.run('bankRows()[0].pendingToMatch'),0);
});
test('large bank queues paginate and duplicate UTRs cannot be selected for new advice',()=>{
  const app=workspace();app.run("state.bank=Array.from({length:10001},(_,i)=>({ref:'U'+i,date:today,customer:'Buyer',amount:100,status:'unmatched'}));state.advice=[];state.bank.push({...state.bank[0]});");const html=app.run('renderBank()');assert.equal((html.match(/class="recon-item"/g)||[]).length,100);assert.equal(app.run("pageCounts['bank-queue'].total"),10002);assert.equal(app.run('availableBankReceipts().length'),10000);assert.equal(app.run("availableBankReceipts().some(row=>row.ref==='U0')"),false);
});
test('legacy unmapped returns are counted and displayed accurately after recovery',()=>{
  const app=workspace();app.run("state.returns=[{id:'R1',date:today,amount:100,invoice:'KNOWN'},{id:'R2',date:today,amount:10}];state.priceReturns=[];");const html=app.run('renderReturns()');assert.ok(html.includes('Mapped to invoices</small><b style="color:#1ca37d">1</b>'));assert.ok(html.includes('Unmapped returns</small><b>1</b>'));assert.ok(html.includes('Unallocated'));assert.ok(!html.includes('data-invoice="undefined"'));
});
test('receipt matching sums split payments and flags duplicate references',async()=>{
  const app=workspace();
  app.run(`showToast=()=>{};state.invoices=[{id:'I',customer:'Buyer',date:today,amount:550},{id:'D',customer:'Buyer',date:today,amount:100}];state.bank=[
    {ref:'UTR',customer:'Buyer',amount:500,status:'unmatched'},
    {ref:'DUPLICATE',amount:100,status:'unmatched'},
    {ref:'DUPLICATE',amount:100,status:'unmatched'}
  ];state.advice=[
    {id:'PA1',invoice:'I',date:today,utr:'UTR',amount:200,type:'Payment',customer:'Buyer'},
    {id:'PA2',invoice:'I',date:today,utr:'UTR',amount:300,type:'Payment',customer:'Buyer'},
    {id:'PA2',invoice:'I',date:today,utr:'UTR',amount:50,type:'TDS',customer:'Buyer'},
    {id:'PA3',invoice:'D',date:today,utr:'DUPLICATE',amount:100,type:'Payment',customer:'Buyer'}
  ]`);
  await app.run('matchEligible()');
  assert.equal(app.run('state.bank[0].status'),'matched');
  assert.equal(app.run('state.bank[1].status'),'review');
  assert.equal(app.run('state.bank[2].status'),'review');
});
