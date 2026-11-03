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
  const current=prepareImport(invoiceInput(),emptyState()).state;
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
test('bank receipt import does not reset matched status on a repeated import',()=>{
  const current=emptyState();current.bank=[{ref:'UTR-1',date:'2026-11-03',amount:100,customer:'Acme',status:'matched',advice:'PA-1'}];
  const result=prepareImport({type:'bank',rows:[['UTR-1','2026-11-03',100,'Acme']],mapping:{ref:0,date:1,amount:2,customer:3},startRow:2,dateFormat:'iso'},current);
  assert.equal(result.counts.skipped,1);assert.equal(result.state.bank[0].status,'matched');
});
test('bank import requires customers and preserves narration and bank name',()=>{
  const input={type:'bank',rows:[['UTR-NEW','2026-11-03',100,'Acme','Invoice receipt','HDFC']],mapping:{ref:0,date:1,amount:2,customer:3,narration:4,bankName:5},startRow:2};
  const result=prepareImport(input,emptyState());assert.equal(result.canImport,true);assert.equal(result.state.bank[0].narration,'Invoice receipt');assert.equal(result.state.bank[0].bankName,'HDFC');
  const missing=structuredClone(input);delete missing.mapping.customer;assert.throws(()=>prepareImport(missing,emptyState()),/Map Customer name/);
  missing.mapping.customer=3;missing.rows[0][3]='  ';assert.match(prepareImport(missing,emptyState()).errors[0].message,/Customer name is required/);
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
