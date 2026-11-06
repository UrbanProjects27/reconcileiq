const {test}=require('node:test');const assert=require('node:assert/strict');
const {emptyState}=require('./lib/state');const {prepareImport}=require('./lib/import');const {parseWorkbook}=require('./lib/workbook');
const invoiceInput=(rows=[['INV-001','Acme','03/11/2026','₹1,00,000.50']])=>({type:'invoices',mapping:{id:0,customer:1,date:2,amount:3},rows,startRow:2,dateFormat:'dmy'});
test('imports map Indian currency and explicit dates, retain customer-level credit terms and leave unrelated data intact',()=>{
  const current=emptyState();current.customerTerms.push({customer:'Acme',creditDays:60});current.bank.push({ref:'UTR1',date:'2026-11-01',amount:25,status:'unmatched'});
  const result=prepareImport(invoiceInput(),current);assert.equal(result.canImport,true);assert.equal(result.state.invoices[0].amount,100000.5);assert.equal(result.state.invoices[0].date,'2026-11-03');
  assert.equal(result.state.customerTerms[0].creditDays,60);assert.deepEqual(result.state.bank,current.bank);assert.equal(current.invoices.length,0);
  const duplicate=prepareImport(invoiceInput(),result.state);assert.equal(duplicate.counts.skipped,1);assert.equal(duplicate.canImport,false);
  const conflicting=prepareImport(invoiceInput([['INV-001','Acme','03/11/2026','50']]),result.state);assert.equal(conflicting.counts.invalid,1);assert.equal(conflicting.state,undefined);assert.match(conflicting.errors[0].message,/different values/);
});
test('sales imports never treat an opening balance as a sales invoice with the same identifier',()=>{
  const current=emptyState();current.invoices=[{id:'INV-001',recordType:'openingBalance',customer:'Acme',date:'2026-11-03',openingDueDate:'2026-03-01',amount:100000.5}];
  const result=prepareImport(invoiceInput(),current);assert.equal(result.canImport,false);assert.match(result.errors[0].message,/opening balance/);assert.equal(current.invoices[0].recordType,'openingBalance');
});
test('invalid rows block the complete batch and report source rows',()=>{
  const rows=[['INV-1','Acme','03/11/2026',100],['INV-2','Acme','31/02/2026',200],['INV-3','Acme','03/11/2026',-1],['INV-4','<script>','03/11/2026',50]];
  const result=prepareImport(invoiceInput(rows),emptyState());assert.equal(result.canImport,false);assert.equal(result.state,undefined);assert.deepEqual(result.errors.map(e=>e.row),[3,4,5]);
  assert.throws(()=>prepareImport({...invoiceInput(),mapping:{id:0}},emptyState()),/Map Customer name/);
  assert.throws(()=>prepareImport({...invoiceInput(),mapping:{id:0,customer:0,date:2,amount:3}},emptyState()),/only one field/);
});
test('optional invoice order numbers and brands survive import without changing balances',()=>{
  const input=invoiceInput([['INV-1','Acme','2026-11-03',100,'000123','Urban & Co']]);input.mapping.orderNumber=4;input.mapping.brandName=5;
  const result=prepareImport(input,emptyState());assert.equal(result.canImport,true);assert.equal(result.state.invoices[0].orderNumber,'000123');assert.equal(result.state.invoices[0].brandName,'Urban & Co');assert.equal(result.state.invoices[0].amount,100);
  assert.equal(prepareImport(invoiceInput(),emptyState()).canImport,true);
});
test('brand subtotal imports combine invoices explicitly, preserve brand amounts and safely repeat',()=>{
  const input={...invoiceInput([['INV-1','Acme','2026-11-03',22811.210000000003,'Veeba'],['INV-1','Acme','2026-11-03',3239.71,'Zyro']]),invoiceRows:'brandAmounts'};input.mapping.brandName=4;
  assert.equal(prepareImport({...input,invoiceRows:'single'},emptyState()).canImport,false);
  const result=prepareImport(input,emptyState());assert.equal(result.canImport,true);assert.equal(result.counts.added,1);assert.equal(result.counts.combined,1);
  assert.equal(result.state.invoices[0].amount,26050.92);assert.equal(result.state.invoices[0].brandName,'Veeba / Zyro');assert.equal(result.state.invoices[0].brandAmounts.length,2);
  assert.equal(prepareImport(input,result.state).counts.skipped,1);assert.equal(prepareImport({...input,rows:[...input.rows].reverse()},result.state).counts.skipped,1);
  for(const column of [1,2]){const changed=structuredClone(input);changed.rows[1][column]=column===1?'Other':'2026-11-02';assert.equal(prepareImport(changed,emptyState()).canImport,false);}
  const duplicate=structuredClone(input);duplicate.rows[1][4]='veeba';assert.match(prepareImport(duplicate,emptyState()).errors[0].message,/repeats brand/);
  const missing=structuredClone(input);delete missing.mapping.brandName;assert.throws(()=>prepareImport(missing,emptyState()),/Map Brand/);
  const invalid=structuredClone(result.state);invalid.invoices[0].brandAmounts[0].amount=1;assert.throws(()=>require('./lib/state').validateState(invalid),/must equal/);
});
test('customer credit-day import updates only the named customers and rejects conflicting source duplicates',()=>{
  const current=emptyState();current.customerTerms=[{customer:'Acme',creditDays:45},{customer:'Other',creditDays:20}];
  const input={type:'customerTerms',rows:[[' acme ',60]],mapping:{customer:0,creditDays:1},startRow:2};const result=prepareImport(input,current);
  assert.equal(result.counts.updated,1);assert.equal(result.state.customerTerms[0].creditDays,60);assert.equal(result.state.customerTerms[1].creditDays,20);
  assert.equal(prepareImport({...input,rows:[['acme',60],['Acme',30]]},current).canImport,false);
});
test('payment advice requires UTR, validates invoice customer and deduplicates distinct advice types',()=>{
  const current=prepareImport(invoiceInput(),emptyState()).state;current.bank.push({ref:'UTR-1',customer:'Acme',date:'2026-11-03',amount:100,status:'unmatched'});
  const input={type:'advice',rows:[['PA-1','Acme','2026-11-03',100,'INV-001','Payment','UTR-1','Receipt'],['PA-1','Acme','2026-11-03',10,'INV-001','TDS','UTR-1','Tax deducted']],mapping:{customer:1,amount:3,invoice:4,type:5,utr:6,description:7},startRow:2,dateFormat:'iso'};
  const result=prepareImport(input,current);assert.equal(result.canImport,true);assert.equal(result.state.advice.length,2);
  assert.equal(prepareImport(input,result.state).counts.skipped,2);
  const legacy=structuredClone(result.state);legacy.advice.forEach((row,i)=>row.id='OLD-'+i);assert.equal(prepareImport(input,legacy).counts.skipped,2);
  const mismatch=structuredClone(input);mismatch.rows[0][1]='Other';assert.match(prepareImport(mismatch,current).errors[0].message,/Customer must match/);
  const noInvoice=structuredClone(input);noInvoice.rows[0][4]='unknown';assert.match(prepareImport(noInvoice,current).errors[0].message,/Import invoices first/);
  assert.match(result.state.advice[0].id,/^PA-/);assert.equal(result.state.advice[0].date,current.invoices[0].date);
  for(const key of ['invoice','type','amount','description']){
    const missing=structuredClone(input);delete missing.mapping[key];assert.throws(()=>prepareImport(missing,current),/Map /);
    const blank=structuredClone(input);blank.rows[0][input.mapping[key]]=' ';assert.equal(prepareImport(blank,current).canImport,false);
  }
  assert.ok(!require('./lib/import').definitions.advice.fields.some(field=>['id','date'].includes(field.key)));
});
test('advice import cannot allocate a bank receipt to a different buyer',()=>{
  const current=emptyState();current.invoices=[{id:'F',customer:'Flipkart',date:'2026-11-01',amount:100},{id:'O',customer:'Other buyer',date:'2026-11-01',amount:100}];current.bank=[{ref:'U',customer:'Flipkart',date:'2026-11-02',amount:100,status:'unmatched'}];
  const input={type:'advice',rows:[['Other buyer','O','Payment',10,'Receipt','U']],mapping:{customer:0,invoice:1,type:2,amount:3,description:4,utr:5},startRow:2};const wrong=prepareImport(input,current);assert.equal(wrong.canImport,false);assert.match(wrong.errors[0].message,/tagged to Flipkart/);
  input.rows[0][0]=' flipkart ';input.rows[0][1]='F';assert.equal(prepareImport(input,current).canImport,true);
  current.bank[0].customer='';assert.match(prepareImport(input,current).errors[0].message,/Assign a buyer/);current.bank=[];assert.match(prepareImport(input,current).errors[0].message,/Unknown bank receipt/);
});
test('split cash imports check the total available bank balance and reject over-allocation',()=>{
  const current=emptyState();current.invoices=[{id:'I1',customer:'Buyer',date:'2026-11-01',amount:100},{id:'I2',customer:'Buyer',date:'2026-11-01',amount:100}];current.bank=[{ref:'U',customer:'Buyer',date:'2026-11-01',amount:100,status:'unmatched'}];
  const input={type:'advice',rows:[['Buyer','I1','Payment',30,'Part one','U'],['Buyer','I2','Payment',40,'Part two','U']],mapping:{customer:0,invoice:1,type:2,amount:3,description:4,utr:5},startRow:2};const partial=prepareImport(input,current);assert.equal(partial.canImport,true);assert.equal(partial.state.bank[0].status,'review');assert.equal(require('./finance').rows(partial.state)[0].pendingToMatch,30);
  input.rows.push(['Buyer','I2','Payment',30.01,'Too much','U']);const excess=prepareImport(input,current);assert.equal(excess.canImport,false);assert.match(excess.errors[0].message,/exceed/);assert.equal(excess.state,undefined);input.rows[2][3]=30;const full=prepareImport(input,current);assert.equal(full.canImport,true);assert.equal(full.state.bank[0].status,'matched');assert.equal(require('./finance').rows(full.state)[0].pendingToMatch,0);
  const legacy=emptyState();legacy.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:120}];legacy.advice=[{id:'OLD',customer:'Buyer',date:'2026-11-01',invoice:'I',type:'Payment',amount:120,utr:'OLD-U',description:'Historical allocation'}];const receipt=prepareImport({type:'bank',rows:[['OLD-U','2026-11-01',100,'Buyer']],mapping:{ref:0,date:1,amount:2,customer:3},startRow:2},legacy);assert.equal(receipt.canImport,true);assert.equal(require('./finance').rows(receipt.state)[0].pendingToMatch,-20);assert.equal(receipt.state.bank[0].status,'review');
});
test('bank receipt import does not reset matched status on a repeated import',()=>{
  const current=emptyState();current.invoices=[{id:'I',customer:'Acme',date:'2026-11-03',amount:100}];current.advice=[{id:'PA-1',invoice:'I',customer:'Acme',date:'2026-11-03',type:'Payment',amount:100,utr:'UTR-1'}];current.bank=[{ref:'UTR-1',date:'2026-11-03',amount:100,customer:'Acme',status:'matched',advice:'PA-1'}];
  const result=prepareImport({type:'bank',rows:[['UTR-1','2026-11-03',100,'Acme']],mapping:{ref:0,date:1,amount:2,customer:3},startRow:2,dateFormat:'iso'},current);
  assert.equal(result.counts.skipped,1);assert.equal(result.state.bank[0].status,'matched');
});
test('bank import requires customers and preserves narration and bank name',()=>{
  const input={type:'bank',rows:[['UTR-NEW','2026-11-03',100,'Acme','Invoice receipt','HDFC']],mapping:{ref:0,date:1,amount:2,customer:3,narration:4,bankName:5},startRow:2};
  const result=prepareImport(input,emptyState());assert.equal(result.canImport,true);assert.equal(result.state.bank[0].narration,'Invoice receipt');assert.equal(result.state.bank[0].bankName,'HDFC');
  const missing=structuredClone(input);delete missing.mapping.customer;assert.throws(()=>prepareImport(missing,emptyState()),/Map Customer name/);
  missing.mapping.customer=3;missing.rows[0][3]='  ';assert.match(prepareImport(missing,emptyState()).errors[0].message,/Customer name is required/);
});
test('returns require all five fields, infer customers and route mixed types without double counting',()=>{
  const current=prepareImport(invoiceInput(),emptyState()).state;
  const input={type:'returns',rows:[['R1','Qty return','2026-11-03','INV-001',10],['R1','Price return','2026-11-03','INV-001',5]],mapping:{id:0,type:1,date:2,invoice:3,amount:4},startRow:2};
  const result=prepareImport(input,current);assert.equal(result.canImport,true);assert.equal(result.state.returns[0].amount,10);assert.equal(result.state.priceReturns[0].amount,5);assert.equal(result.state.returns[0].customer,'Acme');assert.equal(result.state.priceReturns[0].type,'Price return');
  assert.equal(prepareImport(input,result.state).counts.skipped,2);
  const legacy=structuredClone(result.state);delete legacy.returns[0].type;delete legacy.priceReturns[0].type;assert.equal(prepareImport(input,legacy).counts.skipped,2);
  for(const key of ['id','type','date','invoice','amount']){
    const missing=structuredClone(input);delete missing.mapping[key];assert.throws(()=>prepareImport(missing,current),/Map /);
    const blank=structuredClone(input);blank.rows[0][input.mapping[key]]='';assert.equal(prepareImport(blank,current).canImport,false);
  }
  for(const [column,value] of [[1,'Other'],[2,'2026-02-31'],[4,0]]){const bad=structuredClone(input);bad.rows[0][column]=value;assert.equal(prepareImport(bad,current).canImport,false);}
  assert.ok(!require('./lib/import').definitions.returns.fields.some(f=>f.key==='customer'));
});
test('unknown return invoices warn and skip only those rows, with safe later reimport',()=>{
  const current=prepareImport(invoiceInput(),emptyState()).state;
  const input={type:'returns',rows:[['R1','Sale return','2026-11-03','INV-001',10],['R2','Price return','2026-11-03','MISSING',5]],mapping:{id:0,type:1,date:2,invoice:3,amount:4},startRow:2,sourceRows:[2,15]};
  const result=prepareImport(input,current);assert.equal(result.canImport,true);assert.equal(result.counts.invalid,0);assert.equal(result.counts.unmatched,1);assert.equal(result.counts.added,1);assert.equal(result.warnings[0].row,15);assert.match(result.warnings[0].message,/MISSING/);assert.equal(result.state.returns.length,1);assert.equal(result.state.priceReturns.length,0);assert.equal(current.returns.length,0);
  const later=structuredClone(result.state);later.invoices.push({id:'MISSING',customer:'Acme',date:'2026-11-01',amount:100});const retry=prepareImport(input,later);assert.equal(retry.counts.added,1);assert.equal(retry.counts.skipped,1);assert.equal(retry.state.priceReturns.length,1);
  const unknown={...input,rows:Array.from({length:60},(_,i)=>['U'+i,'Sale return','2026-11-03','MISSING',5]),sourceRows:undefined};const all=prepareImport(unknown,current);assert.equal(all.canImport,false);assert.equal(all.counts.unmatched,60);assert.equal(all.warnings.length,50);assert.equal(all.counts.invalid,0);
  const invalid=structuredClone(input);invalid.rows[1][4]=0;assert.equal(prepareImport(invalid,current).counts.invalid,1);assert.equal(prepareImport(invalid,current).canImport,false);
});
test('sales return labels from uploaded workbooks normalize without accepting unknown types',()=>{
  const current=prepareImport(invoiceInput(),emptyState()).state;
  const input={type:'returns',rows:[['FGM89','sale return','2026-11-02','INV-001',31920]],mapping:{id:0,type:1,date:2,invoice:3,amount:4},startRow:2};
  for(const label of ['sale return','Sale Return','SALE RETURNS','sales return','Qty returns','Quantity returns']){
    input.rows[0][1]=label;const result=prepareImport(input,current);assert.equal(result.canImport,true,label);assert.equal(result.state.returns[0].type,'Qty return');assert.equal(result.state.returns[0].amount,31920);
  }
  input.rows[0][1]='unknown';assert.match(prepareImport(input,current).errors[0].message,/Unrecognized return type: unknown/);
  for(const label of ['constructor','__proto__','toString']){input.rows[0][1]=label;assert.equal(prepareImport(input,current).canImport,false,label);}
});
test('EPC advice imports normalize type and preserve the actual bank cash amount',()=>{
  const current=emptyState();current.invoices=[{id:'I',customer:'Buyer',date:'2026-11-01',amount:1000}];current.bank=[{ref:'U',customer:'Buyer',date:'2026-11-02',amount:900,status:'matched'}];
  const input={type:'advice',rows:[['Buyer','I','epc',100,'EPC deduction','U']],mapping:{customer:0,invoice:1,type:2,amount:3,description:4,utr:5},startRow:2};const result=prepareImport(input,current);assert.equal(result.canImport,true);assert.equal(result.state.advice[0].type,'EPC');assert.equal(result.state.advice[0].amount,100);assert.equal(result.state.bank[0].amount,900);assert.equal(prepareImport(input,result.state).counts.skipped,1);
});
test('EPC debit notes import as audit records without changing invoice or payment amounts',()=>{
  const current=prepareImport(invoiceInput(),emptyState()).state;
  const result=prepareImport({type:'debitNotes',rows:[['DN-EPC','Acme','2026-11-03',25,'INV-001','epc']],mapping:{id:0,customer:1,date:2,amount:3,invoice:4,type:5},startRow:2,dateFormat:'iso'},current);
  assert.equal(result.canImport,true);assert.equal(result.state.debitNotes[0].type,'EPC');assert.equal(result.state.debitNotes[0].status,'Unmapped');assert.deepEqual(result.state.invoices,current.invoices);assert.deepEqual(result.state.advice,current.advice);
});
test('CSV parsing handles BOM, quoted commas and empty columns, and rejects unsupported or oversized files',async()=>{
  const result=await parseWorkbook('invoices.csv',Buffer.from('\ufeffInvoice,Customer,Date,Amount\r\nINV-1,"Acme, Ltd",2026-11-03,"1,000.50"\r\n'));
  assert.equal(result.sheets[0].rows[1][1],'Acme, Ltd');assert.equal(result.sheets[0].rows[1][3],'1,000.50');
  await assert.rejects(()=>parseWorkbook('old.xls',Buffer.from('x')),/\.xlsx/);
  await assert.rejects(()=>parseWorkbook('large.csv',Buffer.alloc(4*1024*1024+1)),/4 MB/);
  await assert.rejects(()=>parseWorkbook('bad.xlsx',Buffer.from('not a zip')),/could not be read/);
});
function xlsxFixture(){
  const {zipSync,strToU8}=require('fflate');const xml={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Invoices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Invoice</t></is></c><c r="B1" t="inlineStr"><is><t>Customer</t></is></c><c r="C1" t="inlineStr"><is><t>Date</t></is></c><c r="D1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>INV-001</t></is></c><c r="B2" t="inlineStr"><is><t>Acme</t></is></c><c r="C2" s="1"><v>46329</v></c><c r="D2"><f>50+50.5</f><v>100.5</v></c></row></sheetData></worksheet>',
  };return Buffer.from(zipSync(Object.fromEntries(Object.entries(xml).map(([key,value])=>[key,strToU8(value)]))));
}
test('XLSX parsing preserves sheet names, date cells and cached formula results',async()=>{
  const result=await parseWorkbook('invoices.xlsx',xlsxFixture());assert.equal(result.sheets[0].name,'Invoices');assert.equal(result.sheets[0].rows[1][0],'INV-001');assert.equal(result.sheets[0].rows[1][2],'2026-11-03');assert.equal(result.sheets[0].rows[1][3],100.5);
});
test('XLSX compressed expansion limits prevent oversized archives',async()=>{
  const {zipSync}=require('fflate');const oversized=Buffer.from(zipSync({'huge.xml':Buffer.alloc(21*1024*1024)}));
  await assert.rejects(()=>parseWorkbook('large.xlsx',oversized),/too large/);
});
test('XLSX coordinate limits reject sparse billion-row worksheets before parsing',async()=>{
  const {unzipSync,zipSync,strToU8,strFromU8}=require('fflate');const entries=unzipSync(xlsxFixture());
  entries['xl/worksheets/sheet1.xml']=strToU8(strFromU8(entries['xl/worksheets/sheet1.xml']).replace('<row r="2">','<row r="1000000000">'));
  await assert.rejects(()=>parseWorkbook('sparse.xlsx',Buffer.from(zipSync(entries))),/too large/);
});
