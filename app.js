let bankReceiptFilters={statuses:null,customers:null};
function bankCustomerFilterKey(row){return String(row.customer || '').trim()?'customer:'+customerKey(row.customer):'unidentified';}
function filteredBankReceipts(rows=bankRows().filter(matchesCustomerScope)){
  return rows.filter(row=>(bankReceiptFilters.statuses===null || bankReceiptFilters.statuses.includes(row.status)) && (bankReceiptFilters.customers===null || bankReceiptFilters.customers.includes(bankCustomerFilterKey(row))));
}
function bankReceiptFilterMarkup(rows){
  const customers=new Map();for(const row of rows)customers.set(bankCustomerFilterKey(row),String(row.customer || '').trim() || 'Customer not identified');
  const controls=[['statuses','Status',[['matched','Matched'],['review','Difference'],['unmatched','Unmatched']]],['customers','Customer name',[...customers].sort((a,b)=>a[1].localeCompare(b[1]))]];
  return `<div class="filter-bar bank-receipt-filters">${controls.map(([key,label,options])=>{
    const selected=bankReceiptFilters[key],summary=selected===null?'All':selected.length===0?'None':selected.length===1?(options.find(([value])=>value===selected[0])?.[1] || '1 selected'):selected.length+' selected';
    return `<details class="bank-multi-filter" id="bank-filter-${key}"><summary>${label}: ${esc(summary)}</summary><div class="bank-filter-menu"><div class="bank-filter-tools"><button class="btn" type="button" data-bank-select="all" data-bank-key="${key}">Select all</button><button class="btn" type="button" data-bank-select="none" data-bank-key="${key}">Select none</button></div><div class="bank-filter-options" role="group" aria-label="${label} filter">${options.map(([value,name])=>`<label><input type="checkbox" value="${esc(value)}" data-bank-filter="${key}" ${selected===null || selected.includes(value)?'checked':''} /><span>${esc(name)}</span></label>`).join('') || '<small>No customers available.</small>'}</div></div></details>`;
  }).join('')}<button class="btn" id="clearBankReceiptFilters" type="button">Clear receipt filters</button><span class="bank-filter-result">${filteredBankReceipts(rows).length} of ${rows.length} receipts · Export uses these selections</span></div>`;
}
function bindBankReceiptFilters(){
  const apply=(key,value)=>{bankReceiptFilters[key]=value;pagePositions.bank=0;render();const menu=document.getElementById('bank-filter-'+key);if(menu)menu.open=true;};
  app.querySelectorAll('[data-bank-filter]').forEach(input=>input.onchange=()=>{
    const key=input.dataset.bankFilter,focused=input.value;
    apply(key,[...app.querySelectorAll('[data-bank-filter]')].filter(box=>box.dataset.bankFilter===key && box.checked).map(box=>box.value));
    [...app.querySelectorAll('[data-bank-filter]')].find(box=>box.dataset.bankFilter===key && box.value===focused)?.focus();
  });
  app.querySelectorAll('[data-bank-select]').forEach(button=>button.onclick=()=>apply(button.dataset.bankKey,button.dataset.bankSelect==='all'?null:[]));
  const clear=document.getElementById('clearBankReceiptFilters');if(clear)clear.onclick=()=>{bankReceiptFilters={statuses:null,customers:null};pagePositions.bank=0;render();};
}

let brandClaimFilter={month:'',brand:'all',type:'all',status:'all'};
function brandClaimRows(){return (state.brandClaims || []).filter(matchesCustomerScope).map(row=>({...row,...window.ReconcileIQBank.claim(row,state.brandTerms || [])})).filter(row=>(!brandClaimFilter.month || row.relatedMonth===brandClaimFilter.month) && (brandClaimFilter.brand==='all' || customerKey(row.brand)===brandClaimFilter.brand) && (brandClaimFilter.type==='all' || 'type:'+customerKey(row.claimType)===brandClaimFilter.type) && (brandClaimFilter.status==='all' || row.status===brandClaimFilter.status)).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));}
function knownBrands(){const names=new Map();for(const row of [...(state.brandClaims || []),...(state.brandTerms || [])])if(row.brand)names.set(customerKey(row.brand),row.brand);for(const row of state.invoices)for(const brand of row.brandAmounts?.map(part=>part.brandName) || [row.brandName])if(brand)names.set(customerKey(brand),brand);return [...names].sort((a,b)=>a[1].localeCompare(b[1]));}
function renderBrandClaims(){
  const rows=brandClaimRows(),editable=sharedSession?.user.role!=='viewer',types=[...new Map((state.brandClaims || []).filter(matchesCustomerScope).map(row=>[customerKey(row.claimType),row.claimType])).entries()].sort((a,b)=>a[1].localeCompare(b[1]));
  return `<section class="view"><div class="page-heading"><div><h1>Claim settlements with Brand</h1><p>Track buyer claims and brand credit notes separately from customer invoice reconciliation.</p></div><div class="heading-actions">${sharedSession?.user.role==='admin'?'<button class="btn" data-action="brand-credit-days">Manage brand credit days</button>':''}<button class="btn" data-action="export-brand-claims">⇩ Export report</button>${editable?'<button class="btn" data-action="bulk-import-brand-claims">⇧ Bulk import</button><button class="btn primary" data-action="add-brand-claim">＋ Add claim</button>':''}</div></div><div class="kpi-grid">${kpi('Net claim amount',sum(rows,row=>row.netAmount),'invoice','<span>Buyer DN minus cancelled CN</span>')}${kpi('Pending to claim',sum(rows,row=>row.pendingAmount),'pending','<span>Net amount minus related CN</span>')}${kpi('Unsettled claims',rows.filter(row=>row.status==='Unsettled').length,'pending','<span>Awaiting related CN details</span>')}</div><section class="panel"><div class="filter-bar" style="flex-wrap:wrap"><label>Related month<input id="claimMonthFilter" type="month" value="${esc(brandClaimFilter.month)}" /></label><label>Brand<select id="claimBrandFilter" class="filter-select"><option value="all">All brands</option>${knownBrands().map(([key,name])=>`<option value="${esc(key)}" ${brandClaimFilter.brand===key?'selected':''}>${esc(name)}</option>`).join('')}</select></label><label>Claim type<select id="claimTypeFilter" class="filter-select" aria-label="Filter claims by claim type"><option value="all">All claim types</option>${types.map(([key,name])=>`<option value="type:${esc(key)}" ${brandClaimFilter.type==='type:'+key?'selected':''}>${esc(name)}</option>`).join('')}</select></label><label>Status<select id="claimStatusFilter" class="filter-select">${['all','Unsettled','Pending','Settled'].map(value=>`<option value="${value}" ${brandClaimFilter.status===value?'selected':''}>${value==='all'?'All statuses':value}</option>`).join('')}</select></label><button class="btn" data-action="clear-claim-filters">Clear filters</button></div><div class="table-wrap"><table class="data-table"><thead><tr>${['Related month','Brand','Customer name','Claim type','Claim received date','Buyer DN / invoice number','Buyer DN amount','Buyer CN number if cancelled','Buyer CN amount','Net amount','DN attachment','Due date','Related CN date','Related CN number','Related CN amount','Pending amount to claim','Status','Actions'].map(label=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${pageRows(rows,'claims').map(row=>`<tr><td>${esc(row.relatedMonth)}</td><td>${esc(row.brand)}</td><td>${esc(row.customer)}</td><td>${esc(row.claimType)}</td><td>${dateText(row.receivedDate)}</td><td>${esc(row.buyerDocument)}</td><td class="right">${fMoney(row.buyerDNAmount)}</td><td>${esc(row.buyerCNNumber || '—')}</td><td class="right">${fMoney(row.buyerCNAmount || 0)}</td><td class="right">${fMoney(row.netAmount)}</td><td>${row.attachmentName?`<button class="btn" data-action="download-claim-file" data-ref="${esc(row.id)}">${esc(row.attachmentName)}</button>`:'—'}</td><td>${dateText(row.dueDate)}<br><small>${row.brandCreditDays} credit days</small></td><td>${row.relatedCNDate?dateText(row.relatedCNDate):'—'}</td><td>${esc(row.relatedCNNumber || '—')}</td><td class="right">${fMoney(row.relatedCNAmount || 0)}</td><td class="right">${fMoney(row.pendingAmount)}</td><td><span class="status ${row.status==='Settled'?'matched':'review'}">${row.status}</span></td><td>${editable?`<button class="btn" data-action="edit-brand-claim" data-ref="${esc(row.id)}">Edit / add CN</button>`:''}${deleteButton('brandClaims',row)}</td></tr>`).join('') || '<tr><td colspan="18">No claims match these filters.</td></tr>'}</tbody></table></div></section></section>`;
}
function openBrandCreditDays(){
  if(sharedSession?.user.role!=='admin')return;
  modal('Manage brand credit days','Due date = claim received date + brand credit days. New brands use 45 days until configured.',`<div class="mapping-grid"><label>Brand<input id="brandTermName" list="creditBrands" maxlength="2000" /><datalist id="creditBrands">${knownBrands().map(([,name])=>`<option value="${esc(name)}"></option>`).join('')}</datalist></label><label>Credit days<input id="brandTermDays" type="number" min="0" max="3650" step="1" value="45" /></label></div><div class="table-wrap"><table><thead><tr><th>Brand</th><th>Credit days</th></tr></thead><tbody>${knownBrands().map(([,brand])=>`<tr><td>${esc(brand)}</td><td>${(state.brandTerms || []).find(term=>customerKey(term.brand)===customerKey(brand))?.creditDays ?? 45}</td></tr>`).join('')}</tbody></table></div><p id="brandTermsError" class="form-error" role="alert"></p>`,`<button class="btn" data-close-modal>Close</button><button class="btn primary" id="saveBrandDays">Save credit days</button>`);
  document.getElementById('brandTermName').onchange=()=>{document.getElementById('brandTermDays').value=(state.brandTerms || []).find(term=>customerKey(term.brand)===customerKey(document.getElementById('brandTermName').value))?.creditDays ?? 45;};
  document.getElementById('saveBrandDays').onclick=async()=>{if(saving)return;try{const brand=document.getElementById('brandTermName').value.trim(),creditDays=Number(document.getElementById('brandTermDays').value);if(!brand || brand.length>2000 || /[<>\x00-\x1f]/.test(brand) || !Number.isInteger(creditDays)||creditDays<0||creditDays>3650)throw new Error('Enter a brand and whole credit days from 0 to 3650.');state.brandTerms??=[];const term=state.brandTerms.find(row=>customerKey(row.brand)===customerKey(brand));if(term)term.creditDays=creditDays;else state.brandTerms.push({brand,creditDays});await persist();render();openBrandCreditDays();showToast('Brand credit days saved; claim due dates recalculated.');}catch(error){document.getElementById('brandTermsError').textContent=error.message;}};
}
function openClaimBulkImport(){
  if(Array.isArray(sharedSession?.user.buyerGroupIds))return openScopedCsvImport('brandClaims');
  const layer=modal('Bulk import brand claims','Import claim data from Excel or UTF-8 CSV.',`<p>Download the template and enter one claim per row. Related month accepts YYYY-MM or MM/YYYY; dates use YYYY-MM-DD or the selected date format. Net amount, due date, pending amount and status are calculated automatically using brand credit days.</p><p>Claim reference is optional. Without it, the combination of month, brand, customer, claim type and buyer DN/invoice identifies the claim. Identical records are skipped; changed existing records require review.</p><p>Related CN fields are optional until settlement. If provided, enter the related CN number, date and amount together. Attach PDF/JPG files separately through Edit / add CN after importing.</p><p>Computer CSV: up to 2 MB / 5,000 rows. OneDrive Excel/CSV: up to 100 MB / 200,000 rows. Preview the mapping and confirm before saving.</p>`,`<button class="btn" id="claimImportTemplate">Download template</button><button class="btn" id="claimLocalCsv">Choose computer CSV</button><button class="btn" id="claimResumeImport">Resume prepared file</button><button class="btn primary" id="claimOneDriveImport">Choose OneDrive file</button><button class="btn" data-close-modal>Close</button>`);
  layer.querySelector('#claimImportTemplate').onclick=()=>downloadRegisterImportTemplate('brandClaims');
  layer.querySelector('#claimLocalCsv').onclick=()=>openScopedCsvImport('brandClaims');
  layer.querySelector('#claimResumeImport').onclick=()=>openBulkImports('brandClaims').catch(error=>showToast(error.message));
  layer.querySelector('#claimOneDriveImport').onclick=()=>openConnect('brandClaims').catch(error=>showToast(error.message));
}
function claimFormRecord(values,id){
  const row={id,...values};
  for(const field of ['brand','customer','claimType','buyerDocument']){row[field]=String(row[field] || '').trim();if(!row[field])throw new Error('Brand, customer, claim type and buyer DN / invoice number are required.');}
  for(const field of ['buyerCNNumber','relatedCNNumber'])row[field]=String(row[field] || '').trim();
  for(const value of Object.values(row))if(typeof value==='string' && (value.length>2000 || /[<>\x00-\x08\x0b-\x1f]/.test(value)))throw new Error('Use plain text, up to 2,000 characters per field.');
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.relatedMonth) || !date(row.receivedDate))throw new Error('Enter a valid related month and claim received date.');
  for(const field of ['buyerDNAmount','buyerCNAmount','relatedCNAmount']){const raw=row[field];if(field==='buyerDNAmount' && raw==='')throw new Error('Enter the buyer DN amount.');if(field==='buyerCNAmount' && row.buyerCNNumber && raw==='')throw new Error('Enter the buyer CN amount.');if(field==='relatedCNAmount' && row.relatedCNNumber && raw==='')throw new Error('Enter the related CN amount.');row[field]=Number(raw || 0);if(!Number.isFinite(row[field]) || row[field]<(field==='buyerDNAmount'?0.01:0) || row[field]>1e12)throw new Error('Enter a positive DN amount and non-negative CN amounts.');row[field]=Math.round(row[field]*100)/100;}
  if(!row.buyerCNNumber && row.buyerCNAmount)throw new Error('Enter the buyer CN number for its amount.');
  if(row.relatedCNNumber || row.relatedCNDate || row.relatedCNAmount){if(!row.relatedCNNumber || !date(row.relatedCNDate))throw new Error('Related CN number, date and amount must be entered together.');}
  return {...row,...window.ReconcileIQBank.claim(row,state.brandTerms || [])};
}
async function claimFilePayload(file,id){
  if(!file)return null;
  if(file.size>2*1024*1024 || !/\.(pdf|jpe?g)$/i.test(file.name))throw new Error('Choose a PDF or JPG up to 2 MB.');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('The attachment could not be read.'));reader.readAsDataURL(file);});
  return {claimId:id,name:file.name,data};
}
function openBrandClaim(existingId){
  if(sharedSession?.user.role==='viewer')return;
  const existing=existingId?(state.brandClaims || []).find(row=>row.id===existingId):null;if(existingId && !existing)return showToast('This claim no longer exists. Refresh and try again.');
  updateCalendar();const id=existing?.id || 'CLM-'+crypto.randomUUID();let submitting=false;
  const fields=[['RelatedMonth','Related month *','month'],['Brand','Brand *','text'],['Customer','Customer name *','text'],['ClaimType','Claim type *','text'],['ReceivedDate','Claim received date *','date'],['BuyerDocument','Buyer DN / invoice number *','text'],['BuyerDNAmount','Buyer DN amount *','number'],['BuyerCNNumber','Buyer CN number if cancelled','text'],['BuyerCNAmount','Buyer CN amount','number'],['RelatedCNDate','Related CN date','date'],['RelatedCNNumber','Related CN number','text'],['RelatedCNAmount','Related CN amount','number']];
  modal(existing?'Edit brand claim / add CN':'Add brand claim','Buyer cancellation CNs reduce the net claim. Brand CNs reduce the amount pending to claim.',`<div class="mapping-grid">${fields.map(([field,label,type])=>`<label>${label}<input id="claim${field}" type="${type}" ${type==='number'?'min="0" step="0.01"':''} ${type==='text'?'maxlength="2000"':''} ${field==='Brand'?'list="claimBrands"':field==='Customer'?'list="claimCustomers"':''} /></label>`).join('')}<datalist id="claimBrands">${knownBrands().map(([,name])=>`<option value="${esc(name)}"></option>`).join('')}</datalist><datalist id="claimCustomers">${knownCustomers().map(([,name])=>`<option value="${esc(name)}"></option>`).join('')}</datalist><label>DN attachment (PDF / JPG, up to 2 MB)<input id="claimAttachment" type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" />${existing?.attachmentName?`<small>Current: ${esc(existing.attachmentName)}. Selecting a file replaces it.</small>`:''}</label></div><div id="claimCalculation" class="summary-strip" style="margin-top:14px"></div><p>Claims remain Unsettled until related CN details are entered. After that, pending amounts from ₹-10 through ₹10 are Settled; all others are Pending. The remaining amount stays visible.</p><p id="claimError" class="form-error" role="alert"></p>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveBrandClaim">Save claim</button>`);
  const mapping={RelatedMonth:'relatedMonth',Brand:'brand',Customer:'customer',ClaimType:'claimType',ReceivedDate:'receivedDate',BuyerDocument:'buyerDocument',BuyerDNAmount:'buyerDNAmount',BuyerCNNumber:'buyerCNNumber',BuyerCNAmount:'buyerCNAmount',RelatedCNDate:'relatedCNDate',RelatedCNNumber:'relatedCNNumber',RelatedCNAmount:'relatedCNAmount'};
  for(const [field,key] of Object.entries(mapping))document.getElementById('claim'+field).value=existing?.[key] ?? (field==='RelatedMonth'?today.slice(0,7):field==='ReceivedDate'?today:field==='BuyerCNAmount'?'0':'');
  const read=()=>Object.fromEntries(Object.entries(mapping).map(([field,key])=>[key,document.getElementById('claim'+field).value]));
  const preview=()=>{try{const values=read();if(!values.receivedDate)return;const result=window.ReconcileIQBank.claim({...values,buyerDNAmount:Number(values.buyerDNAmount)||0,buyerCNAmount:Number(values.buyerCNAmount)||0,relatedCNAmount:Number(values.relatedCNAmount)||0},state.brandTerms || []);document.getElementById('claimCalculation').innerHTML=`<div><small>Net amount</small><b>${fMoney(result.netAmount)}</b></div><div><small>Due date (${result.brandCreditDays} days)</small><b>${dateText(result.dueDate)}</b></div><div><small>Pending to claim</small><b>${fMoney(result.pendingAmount)}</b></div><div><small>Status</small><b>${result.status}</b></div>`;}catch{document.getElementById('claimCalculation').textContent='Enter valid dates and amounts to calculate.';}};
  for(const field of Object.keys(mapping))document.getElementById('claim'+field).oninput=preview;preview();
  document.getElementById('saveBrandClaim').onclick=async()=>{
    if(saving || submitting)return;submitting=true;try{
      const record=claimFormRecord(read(),id),file=document.getElementById('claimAttachment').files?.[0],attachment=await claimFilePayload(file,id);
      if(existing?.attachmentName)record.attachmentName=existing.attachmentName;if(attachment)record.attachmentName=attachment.name;
      state.brandClaims??=[];if(existing){const index=state.brandClaims.findIndex(row=>row.id===id);if(index<0)throw new Error('This claim no longer exists. Refresh and try again.');state.brandClaims[index]=record;}else{if(state.brandClaims.some(row=>row.id===id))throw new Error('This claim is already saved. Refresh and review it.');state.brandClaims.unshift(record);}
      await persist('/api/state',attachment?{claimAttachment:attachment}:{});closeModal();go('claims');showToast('Brand claim saved.');
    }catch(error){document.getElementById('claimError').textContent=error.message;}finally{submitting=false;}
  };
}
async function downloadClaimAttachment(id){try{const file=await window.workspaceAPI('/api/brand-claims/'+encodeURIComponent(id)+'/attachment');const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:file.mediaType})),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){showToast(error.message);}}
function exportBrandClaims(){const headers=['Related Month','Brand','Customer Name','Claim Type','Claim Received Date','Buyer DN/Invoice Number','Buyer DN Amount','Buyer CN Number If Cancelled','Buyer CN Amount','Net Amount','DN Attachment','Due Date','Related CN Date','Related CN Number','Related CN Amount','Pending Amount To Claim','Status'];const rows=brandClaimRows().map(row=>[row.relatedMonth,row.brand,row.customer,row.claimType,row.receivedDate,row.buyerDocument,row.buyerDNAmount,row.buyerCNNumber || '',row.buyerCNAmount || 0,row.netAmount,row.attachmentName || '',row.dueDate,row.relatedCNDate || '',row.relatedCNNumber || '',row.relatedCNAmount || 0,row.pendingAmount,row.status]);const csv=[headers,...rows].map(row=>row.map(csvEscape).join(',')).join('\r\n'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'})),link=document.createElement('a');link.href=url;link.download='brand-claim-settlements-'+today+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

/* ReconcileIQ shared workspace. Sample data is used only by the calculation test harness. */
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits:2, maximumFractionDigits:2 });
const shortMoney = value => {
  const abs = Math.abs(value);
  if (abs >= 10000000) return `${value < 0 ? '-' : ''}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${value < 0 ? '-' : ''}₹${(abs / 100000).toFixed(2)} L`;
  return money.format(value);
};
const fMoney = value => money.format(Number(value || 0));
const dateText = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
let localToday = new Date();
let today = `${localToday.getFullYear()}-${String(localToday.getMonth()+1).padStart(2,'0')}-${String(localToday.getDate()).padStart(2,'0')}`;

function updateCalendar(now=new Date()){
  const value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  if(value===today)return false;
  localToday=now;today=value;invoiceCache=null;return true;
}

const seed = {
  invoices: [
    { id:'INV-2026-001842', customer:'Apex Distributors Pvt Ltd', code:'APX-001', date:'2026-09-18', amount:485600, product:'Industrial bearings — Series X', qty:420, rate:1156, gst:87300 },
    { id:'INV-2026-001829', customer:'Meridian Auto Components', code:'MER-014', date:'2026-09-11', amount:326800, product:'Forged steel sleeves', qty:280, rate:1167 },
    { id:'INV-2026-001816', customer:'Northstar Engineering Co.', code:'NSE-022', date:'2026-08-30', amount:714250, product:'Precision machine assemblies', qty:125, rate:5714 },
    { id:'INV-2026-001803', customer:'Vertex Manufacturing Ltd', code:'VTX-008', date:'2026-08-19', amount:219400, product:'Hydraulic coupling kits', qty:190, rate:1155 },
    { id:'INV-2026-001796', customer:'Orbit Trade Solutions', code:'ORB-035', date:'2026-08-12', amount:156750, product:'Chrome-plated shafts', qty:150, rate:1045 },
    { id:'INV-2026-001777', customer:'Apex Distributors Pvt Ltd', code:'APX-001', date:'2026-07-26', amount:382900, product:'Industrial bearings — Series X', qty:330, rate:1160 },
    { id:'INV-2026-001761', customer:'Meridian Auto Components', code:'MER-014', date:'2026-07-15', amount:592000, product:'Forged steel sleeves', qty:500, rate:1184 },
    { id:'INV-2026-001743', customer:'Cobalt Heavy Works', code:'CBT-011', date:'2026-06-29', amount:264300, product:'Custom turbine flange', qty:42, rate:6293 },
    { id:'INV-2026-001729', customer:'Vertex Manufacturing Ltd', code:'VTX-008', date:'2026-06-17', amount:468900, product:'Hydraulic coupling kits', qty:410, rate:1144 },
    { id:'INV-2026-001702', customer:'Northstar Engineering Co.', code:'NSE-022', date:'2026-05-28', amount:398550, product:'Precision machine assemblies', qty:70, rate:5694 },
    { id:'INV-2026-001688', customer:'Orbit Trade Solutions', code:'ORB-035', date:'2026-05-09', amount:181000, product:'Chrome-plated shafts', qty:175, rate:1034 },
    { id:'INV-2026-001672', customer:'Cobalt Heavy Works', code:'CBT-011', date:'2026-04-21', amount:323400, product:'Custom turbine flange', qty:54, rate:5989 }
  ],
  returns: [
    { id:'SR-40182', invoice:'INV-2026-001842', customer:'Apex Distributors Pvt Ltd', date:'2026-10-02', qty:18, amount:20808, product:'Industrial bearings — Series X' },
    { id:'SR-40149', invoice:'INV-2026-001829', customer:'Meridian Auto Components', date:'2026-09-28', qty:12, amount:14004, product:'Forged steel sleeves' },
    { id:'SR-40088', invoice:'INV-2026-001761', customer:'Meridian Auto Components', date:'2026-08-08', qty:25, amount:29600, product:'Forged steel sleeves' },
    { id:'SR-40034', invoice:'INV-2026-001729', customer:'Vertex Manufacturing Ltd', date:'2026-07-01', qty:8, amount:9152, product:'Hydraulic coupling kits' }
  ],
  priceReturns: [
    { id:'CN-17284', invoice:'INV-2026-001842', customer:'Apex Distributors Pvt Ltd', date:'2026-10-05', amount:4856, reason:'Quarterly price variance' },
    { id:'CN-17261', invoice:'INV-2026-001816', customer:'Northstar Engineering Co.', date:'2026-09-12', amount:17856, reason:'Rate correction' },
    { id:'CN-17211', invoice:'INV-2026-001777', customer:'Apex Distributors Pvt Ltd', date:'2026-08-19', amount:7658, reason:'Contractual discount' },
    { id:'CN-17172', invoice:'INV-2026-001688', customer:'Orbit Trade Solutions', date:'2026-06-01', amount:4525, reason:'Rate correction' }
  ],
  advice: [
    { id:'PA-260458', customer:'Apex Distributors Pvt Ltd', date:'2026-10-14', invoice:'INV-2026-001842', type:'Payment', amount:400000, utr:'HDFC2609148' },
    { id:'PA-260458', customer:'Apex Distributors Pvt Ltd', date:'2026-10-14', invoice:'INV-2026-001842', type:'TDS', amount:4856, utr:'HDFC2609148' },
    { id:'PA-260445', customer:'Meridian Auto Components', date:'2026-10-03', invoice:'INV-2026-001829', type:'Payment', amount:250000, utr:'ICIC2601173' },
    { id:'PA-260429', customer:'Northstar Engineering Co.', date:'2026-09-22', invoice:'INV-2026-001816', type:'Payment', amount:300000, utr:'UTIB2607841' },
    { id:'PA-260429', customer:'Northstar Engineering Co.', date:'2026-09-22', invoice:'INV-2026-001816', type:'PPV', amount:8500, utr:'UTIB2607841' },
    { id:'PA-260416', customer:'Vertex Manufacturing Ltd', date:'2026-09-04', invoice:'INV-2026-001803', type:'Payment', amount:219400, utr:'HDFC2607827' },
    { id:'PA-260394', customer:'Orbit Trade Solutions', date:'2026-08-31', invoice:'INV-2026-001796', type:'Payment', amount:156750, utr:'KKBK2609011' },
    { id:'PA-260381', customer:'Apex Distributors Pvt Ltd', date:'2026-08-20', invoice:'INV-2026-001777', type:'Payment', amount:350000, utr:'HDFC2605144' },
    { id:'PA-260381', customer:'Apex Distributors Pvt Ltd', date:'2026-08-20', invoice:'INV-2026-001777', type:'TDS', amount:3829, utr:'HDFC2605144' },
    { id:'PA-260352', customer:'Meridian Auto Components', date:'2026-08-01', invoice:'INV-2026-001761', type:'Payment', amount:562400, utr:'ICIC2609083' },
    { id:'PA-260352', customer:'Meridian Auto Components', date:'2026-08-01', invoice:'INV-2026-001761', type:'TDS', amount:5920, utr:'ICIC2609083' },
    { id:'PA-260331', customer:'Cobalt Heavy Works', date:'2026-07-14', invoice:'INV-2026-001743', type:'Payment', amount:264300, utr:'SBIN2603561' },
    { id:'PA-260306', customer:'Vertex Manufacturing Ltd', date:'2026-06-30', invoice:'INV-2026-001729', type:'Payment', amount:430000, utr:'HDFC2602734' },
    { id:'PA-260306', customer:'Vertex Manufacturing Ltd', date:'2026-06-30', invoice:'INV-2026-001729', type:'TaxD', amount:8500, utr:'HDFC2602734' },
    { id:'PA-260275', customer:'Northstar Engineering Co.', date:'2026-06-09', invoice:'INV-2026-001702', type:'Payment', amount:398550, utr:'UTIB2601840' },
    { id:'PA-260244', customer:'Orbit Trade Solutions', date:'2026-05-22', invoice:'INV-2026-001688', type:'Payment', amount:181000, utr:'KKBK2607483' },
    { id:'PA-260201', customer:'Cobalt Heavy Works', date:'2026-05-01', invoice:'INV-2026-001672', type:'Payment', amount:323400, utr:'SBIN2600165' },
    { id:'PA-260197', customer:'Apex Distributors Pvt Ltd', date:'2026-04-27', invoice:'', type:'Payment', amount:74500, utr:'HDFC2600201' },
    { id:'PA-260489', customer:'Meridian Auto Components', date:'2026-10-22', invoice:'', type:'TDS', amount:2170, utr:'ICIC2609167' }
  ],
  bank: [
    { date:'2026-10-14', ref:'HDFC2609148', customer:'Apex Distributors Pvt Ltd', amount:400000, status:'matched', advice:'PA-260458' },
    { date:'2026-10-03', ref:'ICIC2601173', customer:'Meridian Auto Components', amount:250000, status:'matched', advice:'PA-260445' },
    { date:'2026-09-22', ref:'UTIB2607841', customer:'Northstar Engineering Co.', amount:300000, status:'matched', advice:'PA-260429' },
    { date:'2026-09-04', ref:'HDFC2607827', customer:'Vertex Manufacturing Ltd', amount:219400, status:'matched', advice:'PA-260416' },
    { date:'2026-08-31', ref:'KKBK2609011', customer:'Orbit Trade Solutions', amount:156750, status:'matched', advice:'PA-260394' },
    { date:'2026-08-20', ref:'HDFC2605144', customer:'Apex Distributors Pvt Ltd', amount:350000, status:'matched', advice:'PA-260381' },
    { date:'2026-08-01', ref:'ICIC2609083', customer:'Meridian Auto Components', amount:562400, status:'matched', advice:'PA-260352' },
    { date:'2026-07-14', ref:'SBIN2603561', customer:'Cobalt Heavy Works', amount:264300, status:'matched', advice:'PA-260331' },
    { date:'2026-07-01', ref:'HDFC2602734', customer:'Vertex Manufacturing Ltd', amount:438500, status:'review', advice:'PA-260306' },
    { date:'2026-06-09', ref:'UTIB2601840', customer:'Northstar Engineering Co.', amount:398550, status:'matched', advice:'PA-260275' },
    { date:'2026-05-22', ref:'KKBK2607483', customer:'Orbit Trade Solutions', amount:181000, status:'matched', advice:'PA-260244' },
    { date:'2026-05-01', ref:'SBIN2600165', customer:'Cobalt Heavy Works', amount:323400, status:'matched', advice:'PA-260201' },
    { date:'2026-10-27', ref:'NEFT-AX19283', customer:'', amount:92750, status:'unmatched', advice:'' },
    { date:'2026-10-29', ref:'IMPS-SB23901', customer:'', amount:48560, status:'unmatched', advice:'' },
    { date:'2026-10-29', ref:'IMPS-SB23901', customer:'', amount:48560, status:'unmatched', advice:'' }
  ],
  debitNotes: [
    { id:'DN-9321', customer:'Apex Distributors Pvt Ltd', date:'2026-10-05', invoice:'INV-2026-001842', amount:4856, type:'PPV', status:'Included in adjustment' },
    { id:'DN-9288', customer:'Northstar Engineering Co.', date:'2026-09-13', invoice:'INV-2026-001816', amount:8500, type:'PQV', status:'Included in PA-260429' },
    { id:'DN-9210', customer:'Meridian Auto Components', date:'2026-08-11', invoice:'INV-2026-001761', amount:12500, type:'Unknown', status:'Unmapped' },
    { id:'DN-9154', customer:'Vertex Manufacturing Ltd', date:'2026-06-30', invoice:'INV-2026-001729', amount:8500, type:'TAXD', status:'Included in PA-260306' }
  ],
  logs: [
    { time:'Today, 09:42', event:'Daily sync completed successfully', detail:'6 source files processed · 28 new records · 0 errors', kind:'ok' },
    { time:'Yesterday, 18:10', event:'Bank statement imported', detail:'15 credit transactions reviewed · 2 require mapping', kind:'info' },
    { time:'30 Oct, 09:39', event:'Payment advice validation warning', detail:'1 entry has no invoice reference and is unallocated', kind:'warn' }
  ]
};

function clone(data) { return JSON.parse(JSON.stringify(data)); }
const sharedSession = window.workspaceSession;
let state;
if (sharedSession) state = clone(sharedSession.state);
else if (window.RECONCILE_TEST_MODE) {
  try { state = JSON.parse(localStorage.getItem('reconcileiq-state')) || clone(seed); } catch { state = clone(seed); }
} else { throw new Error('Sign in before opening the workspace.'); }
state.brandClaims??=[];state.brandTerms??=[];
let workspaceRevision = sharedSession ? sharedSession.revision : 0;
let savedState = clone(state);
let saving = false;
function customerKey(name) { return String(name).trim().toLowerCase(); }
function initializeCustomerTerms() {
  if(!Array.isArray(state.buyerGroups))state.buyerGroups=[];
  if (!Array.isArray(state.customerTerms)) state.customerTerms = [];
  const keys=new Set(state.customerTerms.map(term=>customerKey(term.customer)));
  state.invoices.forEach(invoice => {
    if (!keys.has(customerKey(invoice.customer))) {
      const legacyDays = Number(invoice.creditDays);
      state.customerTerms.push({customer: invoice.customer, creditDays: Number.isFinite(legacyDays) && legacyDays >= 0 ? legacyDays : 45});
      keys.add(customerKey(invoice.customer));
    }
  });
}
function customerCreditDays(customer) {
  const term = state.customerTerms.find(term => customerKey(term.customer) === customerKey(customer));
  return term ? Number(term.creditDays) : 45;
}
initializeCustomerTerms();
state.invoices.forEach(invoice => {
  if (!Number.isFinite(Number(invoice.roundOff))) invoice.roundOff = 0;
});
state.advice.forEach(advice => { if (typeof advice.description !== 'string') advice.description = ''; });
state.debitNotes.forEach(note => {
  if (note.type) return;
  const legacy = String(note.reason || '').toLowerCase();
  note.type = legacy.includes('tax') ? 'TAXD' : legacy.includes('price') ? 'PPV' : legacy.includes('packaging') ? 'PQV' : 'Unknown';
});
if (!sharedSession) persist();
let currentView = 'dashboard';
let invoiceFilter = { search:'', status:'all',brand:'all',customer:'all' };
let dashboardBrand='all';
let customerScope={buyer:'all',customer:'all'};
let adviceFilter={search:'',type:'all'};
const app = document.getElementById('app');
let scopeCache=null;
function knownCustomers(){
  const customers=new Map();
  for(const collection of ['invoices','customerTerms','bank','advice','returns','priceReturns','debitNotes','brandClaims'])for(const row of state[collection] || [])if(String(row.customer || '').trim() && !customers.has(customerKey(row.customer)))customers.set(customerKey(row.customer),row.customer.trim());
  for(const group of state.buyerGroups || [])for(const name of group.customers)if(!customers.has(customerKey(name)))customers.set(customerKey(name),name.trim());
  return [...customers].sort((a,b)=>a[1].localeCompare(b[1]));
}
function scopedCustomerKeys(){
  if(scopeCache?.state===state && scopeCache.buyer===customerScope.buyer && scopeCache.groups===state.buyerGroups)return scopeCache.keys;
  let keys=null;
  if(customerScope.buyer==='ungrouped'){keys=new Set((state.buyerGroups || []).flatMap(group=>group.customers.map(customerKey)));}
  else if(customerScope.buyer!=='all'){const group=(state.buyerGroups || []).find(g=>'buyer:'+g.id===customerScope.buyer);keys=new Set((group?.customers || []).map(customerKey));}
  scopeCache={state,buyer:customerScope.buyer,groups:state.buyerGroups,keys};return keys;
}
function matchesBuyerScope(row){const keys=scopedCustomerKeys();return keys===null || (customerScope.buyer==='ungrouped'?!keys.has(customerKey(row.customer || '')):keys.has(customerKey(row.customer || '')));}
function matchesCustomerScope(row){return matchesBuyerScope(row) && (customerScope.customer==='all' || customerScope.customer==='customer:'+customerKey(row.customer || ''));}
function normalizeCustomerScope(){
  if(!['all','ungrouped'].includes(customerScope.buyer) && !(state.buyerGroups || []).some(g=>'buyer:'+g.id===customerScope.buyer))customerScope.buyer='all';
  if(customerScope.customer!=='all' && !knownCustomers().some(([key,name])=>'customer:'+'customer:'+key===customerScope.customer && matchesBuyerScope({customer:name})))customerScope.customer='all';
}
function customerScopeMarkup(){
  if(['settings','sync'].includes(currentView))return '';
  const customers=knownCustomers().filter(([,name])=>matchesBuyerScope({customer:name}));
  return `<section class="panel customer-scope"><div class="filter-bar"><label>Buyer group<select class="filter-select" id="scopeBuyer" aria-label="Filter by buyer group"><option value="all">All buyer groups</option><option value="ungrouped" ${customerScope.buyer==='ungrouped'?'selected':''}>Customers without a group</option>${(state.buyerGroups || []).map(group=>`<option value="buyer:${esc(group.id)}" ${customerScope.buyer==='buyer:'+group.id?'selected':''}>${esc(group.name)}</option>`).join('')}</select></label><label>Customer<select class="filter-select" id="scopeCustomer" aria-label="Filter by customer"><option value="all">All customers</option>${customers.map(([key,name])=>`<option value="customer:${esc(key)}" ${customerScope.customer==='customer:'+key?'selected':''}>${esc(name)}</option>`).join('')}</select></label><button class="btn" id="clearCustomerScope">Clear buyer / customer</button>${sharedSession?.user.role==='admin'?'<button class="btn" data-action="buyer-groups">Manage buyer groups</button>':''}</div></section>`;
}
function openBuyerGroups(){
  if(sharedSession?.user.role!=='admin')return showToast('Administrator access required.');
  const groups=state.buyerGroups || [],canDelete=sharedSession.user.role==='admin';
  const layer=modal('Buyer groups','Map multiple customers to one buyer group.',`<div class="table-wrap"><table><thead><tr><th>Buyer group</th><th>Customers</th><th>Actions</th></tr></thead><tbody>${groups.map(group=>`<tr><td><b>${esc(group.name)}</b></td><td>${group.customers.map(esc).join(', ') || 'No customers mapped'}</td><td><button class="btn small" data-edit-buyer="${esc(group.id)}">Edit</button>${canDelete?` <button class="btn small" data-delete-buyer="${esc(group.id)}">Delete</button>`:''}</td></tr>`).join('') || '<tr><td colspan="3">No buyer groups yet. Add a group and select its customers.</td></tr>'}</tbody></table></div>`,`<button class="btn" data-close-modal>Close</button><button class="btn primary" id="newBuyerGroup">Add buyer group</button>`);
  layer.querySelector('#newBuyerGroup').onclick=()=>openBuyerGroupForm();
  layer.querySelectorAll('[data-edit-buyer]').forEach(button=>button.onclick=()=>openBuyerGroupForm(button.dataset.editBuyer));
  layer.querySelectorAll('[data-delete-buyer]').forEach(button=>button.onclick=()=>openDeleteBuyerGroup(button.dataset.deleteBuyer));
}
function openBuyerGroupForm(id){
  if(sharedSession?.user.role!=='admin')return;
  const group=(state.buyerGroups || []).find(g=>g.id===id);if(id&&!group)return showToast('This group no longer exists. Refresh and try again.');
  const selected=new Set((group?.customers || []).map(customerKey));
  const layer=modal(group?'Edit buyer group':'Add buyer group','Choose all customers that belong to this buyer.',`<label class="account-form">Buyer group name<input id="buyerGroupName" maxlength="200" value="${esc(group?.name || '')}" required /></label><label class="account-form">Find customer<input id="buyerCustomerSearch" type="search" placeholder="Search customers" /></label><div class="buyer-customer-list">${knownCustomers().map(([key,name])=>`<label data-buyer-customer-name="${esc(key)}"><input type="checkbox" data-buyer-customer="${esc(name)}" ${selected.has(key)?'checked':''} /> ${esc(name)}</label>`).join('') || '<p>Add or import customers first.</p>'}</div><p id="buyerGroupError" class="form-error" role="alert"></p>`,`<button class="btn" id="buyerGroupBack">Back</button><button class="btn primary" id="saveBuyerGroup">Save buyer group</button>`);
  layer.querySelector('#buyerGroupBack').onclick=openBuyerGroups;
  layer.querySelector('#buyerCustomerSearch').oninput=event=>layer.querySelectorAll('[data-buyer-customer-name]').forEach(label=>{label.hidden=!label.dataset.buyerCustomerName.includes(customerKey(event.target.value));});
  layer.querySelector('#saveBuyerGroup').onclick=async()=>{
    if(saving)return;
    try{
      const name=layer.querySelector('#buyerGroupName').value.trim();if(!name)throw Error('Enter a buyer group name.');
      if(id && !(state.buyerGroups || []).some(g=>g.id===id))throw Error('This group was deleted. Close this form and add a new group if needed.');
      if((state.buyerGroups || []).some(g=>g.id!==id && customerKey(g.name)===customerKey(name)))throw Error('A buyer group with that name already exists.');
      const customers=[...layer.querySelectorAll('[data-buyer-customer]')].filter(input=>input.checked).map(input=>input.dataset.buyerCustomer);
      const record={id:id || crypto.randomUUID(),name,customers};
      state.buyerGroups=id?state.buyerGroups.map(g=>g.id===id?record:g):[...(state.buyerGroups || []),record];
      await persist();render();openBuyerGroups();showToast('Buyer group saved.');
    }catch(error){layer.querySelector('#buyerGroupError').textContent=error.message;}
  };
}
function openDeleteBuyerGroup(id){
  if(sharedSession?.user.role!=='admin')return;
  const group=(state.buyerGroups || []).find(g=>g.id===id);if(!group)return;
  const layer=modal('Delete buyer group',group.name,`<p>Delete this buyer grouping? Its ${group.customers.length} customers and all financial records will remain in the workspace.</p><p id="deleteBuyerError" class="form-error" role="alert"></p>`,`<button class="btn" id="cancelDeleteBuyer">Cancel</button><button class="btn danger" id="confirmDeleteBuyer">Delete group</button>`);
  layer.querySelector('#cancelDeleteBuyer').onclick=openBuyerGroups;
  layer.querySelector('#confirmDeleteBuyer').onclick=async()=>{if(saving)return;try{state.buyerGroups=state.buyerGroups.filter(g=>g.id!==id);await persist();render();openBuyerGroups();showToast('Buyer group deleted.');}catch(error){layer.querySelector('#deleteBuyerError').textContent=error.message;}};
}

async function persist(endpoint = '/api/state',extras={}) {
  if (!sharedSession) { localStorage.setItem('reconcileiq-state', JSON.stringify(state)); return; }
  if (saving) throw new Error('A save is in progress. Please wait.');
  saving = true;
  const buttons = [...document.querySelectorAll('#modalLayer button, #app button')].map(button=>({button,disabled:button.disabled}));
  buttons.forEach(({button}) => { button.disabled = true; });
  try {
    const result = await window.workspaceAPI(endpoint, endpoint === '/api/state' ? 'PUT' : 'POST', {...extras,revision: workspaceRevision, state});
    state = result.state; workspaceRevision = result.revision; savedState = clone(state);
    sharedSession.state = clone(state); sharedSession.revision = workspaceRevision;
  } catch (error) {
    state = clone(savedState);
    if (error.status === 409) {
      const latest = await window.workspaceAPI('/api/state');
      state = latest.state;initializeCustomerTerms(); workspaceRevision = latest.revision; savedState = clone(state);
      sharedSession.state=clone(state);sharedSession.revision=workspaceRevision;render();
    }
    throw error;
  } finally { saving = false; buttons.forEach(({button,disabled}) => { button.disabled = disabled; }); }
}
window.replaceWorkspace = async next => { if(saving)throw new Error('A save is in progress. Please wait.');state = clone(next); await persist('/api/restore'); render(); };
window.refreshWorkspace = async (quiet = false) => {
  const modalOpen=()=>!document.getElementById('modalLayer').classList.contains('hidden');
  if (!sharedSession || saving || modalOpen()) return;
  const dayChanged=updateCalendar(),requestedRevision=workspaceRevision;
  const latest = await window.workspaceAPI('/api/state');
  if(saving || workspaceRevision!==requestedRevision || modalOpen())return;
  if (latest.revision > workspaceRevision) {
    state = latest.state;initializeCustomerTerms(); workspaceRevision = latest.revision; savedState = clone(state);
    sharedSession.state=clone(state);sharedSession.revision=workspaceRevision;render();
    if (!quiet) showToast('Workspace updated with the latest shared data.');
  } else if(dayChanged)render();
};
function sum(arr, fn = x => x) { return arr.reduce((total, item) => total + Number(fn(item) || 0), 0); }
function allocations(invoiceId) {
  const result = { Payment:0, TDS:0, PPV:0, PQV:0, CCOGS:0, TaxD:0, EPC:0 };
  state.advice.filter(a => a.invoice === invoiceId).forEach(a => { if (result[a.type] !== undefined) result[a.type] += +a.amount; });
  return result;
}
function financialIndex(){
  const index={returns:new Map(),prices:new Map(),debit:new Map(),advice:new Map(),terms:new Map(state.customerTerms.map(t=>[customerKey(t.customer),Number(t.creditDays)]))};
  for(const [rows,map] of [[state.returns,index.returns],[state.priceReturns,index.prices]])for(const row of rows)map.set(row.invoice,(map.get(row.invoice)||0)+Number(row.amount));
  for(const row of state.advice){let entry=index.advice.get(row.invoice);if(!entry){entry={Payment:0,TDS:0,PPV:0,PQV:0,CCOGS:0,TaxD:0,EPC:0};index.advice.set(row.invoice,entry);}if(entry[row.type]!==undefined)entry[row.type]+=Number(row.amount);}
  for(const row of state.debitNotes)if(row.invoice){
    let entry=index.debit.get(row.invoice);if(!entry){entry={total:0,PPV:0,PQV:0,CCOGS:0,TaxD:0,EPC:0,Unknown:0};index.debit.set(row.invoice,entry);}
    const amount=window.ReconcileIQBank.debitNote(row).difference,type=row.type==='TAXD'?'TaxD':row.type;
    entry.total+=amount;entry[['PPV','PQV','CCOGS','TaxD','EPC'].includes(type)?type:'Unknown']+=amount;
  }
  return index;
}
function invoiceData(inv,index=financialIndex()) {
  updateCalendar();
  const a = {...(index.advice.get(inv.id) || {Payment:0,TDS:0,PPV:0,PQV:0,CCOGS:0,TaxD:0,EPC:0})};
  const debit=index.debit.get(inv.id);
  if(debit)for(const type of ['PPV','PQV','CCOGS','TaxD','EPC'])a[type]+=debit[type];
  const qtyReturn = index.returns.get(inv.id) || 0;
  const priceReturn = index.prices.get(inv.id) || 0;
  const manualRoundOff = Number(inv.roundOff || 0);
  const debitAdjustment=debit?.total || 0,otherDebit=debit?.Unknown || 0;
  const deducted = qtyReturn + priceReturn + otherDebit + sum(Object.values(a));
  const remainingCents=Math.round((inv.amount-deducted-manualRoundOff)*100);
  const autoRoundOff=Math.abs(remainingCents)<=1000?remainingCents/100:0;
  const roundOff=Math.round((manualRoundOff+autoRoundOff)*100)/100;
  const pending=(remainingCents-Math.round(autoRoundOff*100))/100;
  const age = Math.max(0, Math.floor((new Date(today) - new Date(inv.date)) / 86400000));
  const creditDays = index.terms.get(customerKey(inv.customer)) ?? 45;
  const dueDate = new Date(`${inv.recordType==='openingBalance'?inv.openingDueDate:inv.date}T00:00:00`);
  if(inv.recordType!=='openingBalance')dueDate.setDate(dueDate.getDate() + creditDays);
  const status = pending < 0 ? 'overadjusted' : pending === 0 ? 'settled' : new Date(`${today}T00:00:00`) > dueDate ? 'overdue' : 'due';
  const dueISO=`${dueDate.getFullYear()}-${String(dueDate.getMonth()+1).padStart(2,'0')}-${String(dueDate.getDate()).padStart(2,'0')}`;
  const ageing=Math.round((Date.parse(today)-Date.parse(dueISO))/86400000);
  return { ...inv, qtyReturn, priceReturn, debitAdjustment, otherDebit, roundOff, manualRoundOff, autoRoundOff, ...a, pending, deducted, age, ageing, creditDays, dueDate:dueISO, status };
}
let invoiceCache=null,invoiceCacheState=null;
function allInvoices() {updateCalendar();if(!window.RECONCILE_TEST_MODE && invoiceCacheState===state && invoiceCache)return invoiceCache;const index=financialIndex();invoiceCache=state.invoices.map(invoice=>invoiceData(invoice,index));invoiceCacheState=state;return invoiceCache;}
const pagePositions=Object.create(null);let pageCounts=Object.create(null);
function pageRows(rows,key=currentView){const pages=Math.ceil(rows.length/100);const page=Math.max(0,Math.min(pagePositions[key] || 0,Math.max(0,pages-1)));pagePositions[key]=page;pageCounts[key]={total:rows.length,page,pages};return rows.slice(page*100,page*100+100);}
function pageControls(){return Object.entries(pageCounts).filter(([,p])=>p.total>100).map(([key,p])=>`<div class="pagination" style="margin:0 24px 18px"><span>${key==='bank-queue'?'Receipt matching queue · ':key==='bank'?'All bank receipts · ':''}${p.page*100+1}–${Math.min(p.total,(p.page+1)*100)} of ${p.total.toLocaleString('en-IN')} records</span><div class="pages"><button data-page-key="${esc(key)}" data-page-number="${p.page-1}" ${p.page===0?'disabled':''}>Previous</button><button data-page-key="${esc(key)}" data-page-number="${p.page+1}" ${p.page+1>=p.pages?'disabled':''}>Next</button></div></div>`).join('');}
function totals(invoices=allInvoices()) {
  return {
    invoice:sum(invoices, x => x.amount), debitAdjustment:sum(invoices,x=>x.debitAdjustment), otherDebit:sum(invoices,x=>x.otherDebit), qtyReturn:sum(invoices, x => x.qtyReturn), priceReturn:sum(invoices, x => x.priceReturn),
    payment:sum(invoices, x => x.Payment), tds:sum(invoices,x=>x.TDS), ppv:sum(invoices,x=>x.PPV), pqv:sum(invoices,x=>x.PQV), ccogs:sum(invoices,x=>x.CCOGS), taxd:sum(invoices,x=>x.TaxD), epc:sum(invoices,x=>x.EPC), pending:sum(invoices,x=>x.pending), overdue:sum(invoices.filter(x=>x.status==='overdue'),x=>x.pending), due:sum(invoices.filter(x=>x.status==='due'),x=>x.pending)
  };
}
function statusMarkup(status) { const labels={settled:'Fully settled',due:'Due',overdue:'Overdue',overadjusted:'Excess paid',matched:'Matched',review:'Difference',unmatched:'Unmatched',unallocated:'Unallocated'}; return `<span class="status ${esc(status)}">${esc(Object.hasOwn(labels,status)?labels[status]:status)}</span>`; }
function icon(type) { return ({ invoice:'₹', payment:'↓', returns:'↩', pending:'⌛', bank:'⇄', file:'▤' }[type] || '•'); }
function navTitle(view) { return ({ dashboard:'Dashboard', invoices:'Invoice Register', customers:'Customer Summary', advice:'Payment Advice', bank:'Bank Reconciliation', returns:'Sales & Price Returns', debit:'Debit Note Register',claims:'Claim settlements with Brand', unallocated:'Unallocated Transactions', reports:'Reports', sync:'Data Synchronisation', settings:'Settings' })[view] || view; }
function showToast(message) { const el=document.createElement('div');el.className='toast';el.textContent=message;document.getElementById('toastWrap').append(el);setTimeout(()=>el.remove(),3200); }
function esc(str='') { return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function kpi(label, amount, type, footer) { return `<div class="kpi"><div class="kpi-header"><span>${label}</span><span class="kpi-icon ${type === 'returns' ? 'yellow' : type === 'pending' ? 'red' : type === 'payment' ? 'teal' : ''}">${icon(type)}</span></div><div class="kpi-value">${shortMoney(amount)}</div><div class="kpi-foot">${footer}</div></div>`; }
function dashboardData(){
  const all=allInvoices().filter(matchesCustomerScope),brands=new Map();let unassigned=0;
  const parts=invoice=>invoice.brandAmounts || [{brandName:invoice.brandName || '',amount:invoice.amount}];
  for(const invoice of all)for(const part of parts(invoice)){const name=String(part.brandName).trim();if(!name){unassigned++;continue;}const key=name.toLowerCase();if(!brands.has(key))brands.set(key,name);}
  const options=[{value:'all',label:'All brands'},...([...brands].sort((a,b)=>a[1].localeCompare(b[1])).map(([key,label])=>({value:'brand:'+key,label}))),...(unassigned?[{value:'unassigned',label:'Unassigned brand'}]:[])];
  if(!options.some(option=>option.value===dashboardBrand))dashboardBrand='all';
  const ratios=new Map();const invoices=[];
  for(const invoice of all){
    if(dashboardBrand==='all'){invoices.push(invoice);ratios.set(invoice.id,1);continue;}
    const selected=parts(invoice).filter(part=>dashboardBrand==='unassigned'?!part.brandName.trim():'brand:'+part.brandName.trim().toLowerCase()===dashboardBrand);
    if(!selected.length)continue;
    const amount=sum(selected,part=>part.amount),ratio=amount/invoice.amount,scoped={...invoice,amount,brandName:selected.map(part=>part.brandName).join(' / ')};
    for(const key of ['qtyReturn','priceReturn','debitAdjustment','otherDebit','roundOff','manualRoundOff','autoRoundOff','Payment','TDS','PPV','PQV','CCOGS','TaxD','EPC','pending','deducted'])scoped[key]=invoice[key]*ratio;
    invoices.push(scoped);ratios.set(invoice.id,ratio);
  }
  return {invoices,options,label:options.find(option=>option.value===dashboardBrand).label,total:all.length,payments:state.advice.filter(row=>row.type==='Payment'&&ratios.has(row.invoice)).map(row=>({...row,amount:row.amount*ratios.get(row.invoice)}))};
}
function renderDashboard() {
  const scope=dashboardData();const inv=scope.invoices,t=totals(inv);
  const months=Array.from({length:6},(_,i)=>{
    const date=new Date(localToday.getFullYear(),localToday.getMonth()-5+i,1);
    const key=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
    return {label:date.toLocaleDateString('en-IN',{month:'short'}),invoice:sum(inv.filter(x=>x.recordType!=='openingBalance' && x.date.startsWith(key)),x=>x.amount),payment:sum(scope.payments.filter(x=>x.date.startsWith(key)),x=>x.amount)};
  });
  const chartMax=Math.max(1,...months.flatMap(m=>[m.invoice,m.payment]));
  const buckets=[sum(inv.filter(x=>x.pending>1&&x.age>90),x=>x.pending),sum(inv.filter(x=>x.pending>1&&x.age>60&&x.age<=90),x=>x.pending),sum(inv.filter(x=>x.pending>1&&x.age>30&&x.age<=60),x=>x.pending),sum(inv.filter(x=>x.pending>1&&x.age<=30),x=>x.pending)];
  const grossPending=sum(buckets); const edges=buckets.map((_,index)=>sum(buckets.slice(0,index+1))/Math.max(1,grossPending)*100);
  const donutStyle=grossPending?`conic-gradient(#ec6b70 0 ${edges[0]}%,#f1b74a ${edges[0]}% ${edges[1]}%,#3fc1a1 ${edges[1]}% ${edges[2]}%,#5b79e5 ${edges[2]}% 100%)`:'#edf0f5';
  const customerOutstanding = customerRows(inv).sort((a,b)=>b.pending-a.pending).slice(0,4);
  return `<section class="view">
    <div class="page-heading"><div><h1>Welcome, ${esc(sharedSession?.user.name || 'Finance team')} <span style="font-size:19px">👋</span></h1><p>Here’s the current picture of your receivables.</p></div><div class="heading-actions"><button class="btn" data-action="export-dashboard"><span>⇩</span> Export report</button><button class="btn primary" data-action="sync"><span>↻</span> Refresh shared data</button></div></div>
    <section class="panel" style="margin-bottom:16px"><div class="filter-bar" style="flex-wrap:wrap"><label for="dashboardBrandFilter"><strong>Brand</strong></label><select class="filter-select" style="max-width:100%" id="dashboardBrandFilter" aria-label="Filter dashboard by brand">${scope.options.map(option=>`<option value="${esc(option.value)}" ${option.value===dashboardBrand?'selected':''}>${esc(option.label)}</option>`).join('')}</select><span>${inv.length.toLocaleString('en-IN')} of ${scope.total.toLocaleString('en-IN')} invoices</span></div>${scope.options.some(option=>option.value.startsWith('brand:'))?'':'<p style="margin:0 16px 14px;color:#778197">Add brand names in the Invoice Register to view data by brand.</p>'}</section>
    <div class="kpi-grid">
      ${kpi('Invoice value',sum(inv.filter(x=>x.recordType!=='openingBalance'),x=>x.amount),'invoice',`<span>${dashboardBrand==='all'?'Sales invoices':esc(scope.label)}</span>`)}
      ${kpi('Opening balance',sum(inv.filter(x=>x.recordType==='openingBalance'),x=>x.amount),'invoice','<span>Carried forward receivables</span>')}
      ${kpi('Payments received',t.payment,'payment','<span>Allocated payment advice</span>')}
      ${kpi('Total returns',t.qtyReturn+t.priceReturn,'returns','<span>Qty & price adjustments</span>')}
      ${kpi('TDS & deductions',t.tds+t.ppv+t.pqv+t.ccogs+t.taxd+t.epc+t.otherDebit,'returns','<span>Payment advice and debit notes</span>')}
      ${kpi('Overdue receivables',t.overdue,'pending','<span>Past customer credit terms</span>')}
      ${kpi('Due receivables',t.due,'returns','<span>Within customer credit terms</span>')}
    </div>
    <div class="dashboard-main-grid">
      <section class="panel chart-panel"><div class="panel-head"><div><h2>Invoice raised vs. payment received</h2><p>Monthly comparison of invoiced and allocated amounts</p></div><div class="panel-actions"><div class="chart-legend"><span><i class="legend-dot blue"></i>Invoice</span><span><i class="legend-dot teal"></i>Payment</span></div><span style="font-size:9px;color:#7c879b">Last 6 months</span></div></div><div class="chart-wrap"><div class="bar-chart">${months.map(m=>`<div class="bar-group"><div class="bar invoice" title="${fMoney(m.invoice)}" style="height:${m.invoice/chartMax*100}%"></div><div class="bar payment" title="${fMoney(m.payment)}" style="height:${m.payment/chartMax*100}%"></div><label>${m.label}</label></div>`).join('')}</div></div></section>
      <section class="panel chart-panel"><div class="panel-head"><div><h2>Outstanding ageing</h2><p>Pending balance by invoice age</p></div><button class="btn" data-view="invoices">View all</button></div><div class="donut-flex"><div class="donut" style="background:${donutStyle}"><div class="donut-center"><b>${shortMoney(grossPending)}</b><small>TOTAL PENDING</small></div></div><ul class="age-list"><li><span class="age-label"><i class="age-dot" style="background:#ec6b70"></i>Over 90 days</span><b>${shortMoney(buckets[0])}</b></li><li><span class="age-label"><i class="age-dot" style="background:#f1b74a"></i>61 – 90 days</span><b>${shortMoney(buckets[1])}</b></li><li><span class="age-label"><i class="age-dot" style="background:#3fc1a1"></i>31 – 60 days</span><b>${shortMoney(buckets[2])}</b></li><li><span class="age-label"><i class="age-dot" style="background:#5b79e5"></i>0 – 30 days</span><b>${shortMoney(buckets[3])}</b></li></ul></div></section>
    </div>
    <div class="lower-grid">
      <section class="panel"><div class="panel-head"><div><h2>Customer-wise outstanding</h2><p>Customers with the highest pending balance</p></div><button class="btn" data-view="customers">View summary</button></div><div class="customers-list">${customerOutstanding.map((c,i)=>`<div class="customer-row"><div class="customer-name"><span class="customer-avatar">${c.customer.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><span>${esc(c.customer)}<small>${c.count} invoices · ${esc(c.code)}</small></span></div><div><small>Invoice value</small><b>${shortMoney(c.invoice)}</b></div><div><small>Overdue</small><b class="amount-red">${shortMoney(c.overdue)}</b></div><div class="align-right"><small>Due</small><b>${shortMoney(c.due)}</b></div></div>`).join('')}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>Workspace activity</h2><p>Recent updates across the shared workspace</p></div><button class="btn" data-view="sync">Sync history</button></div><div class="activity">${state.logs.map((log,i)=>`<div class="activity-row"><div class="activity-icon ${log.kind==='warn'?'warning':log.kind==='info'?'info':''}">${log.kind==='ok'?'✓':log.kind==='warn'?'!':'↻'}</div><p><b>${esc(log.event)}</b><br><span>${esc(log.detail)}</span></p><time>${esc(log.time)}</time></div>`).join('')}</div></section>
    </div></section>`;
}

function invoiceTable(rows) { return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Invoice</th><th>Order number</th><th>Brand name</th><th>Customer</th><th>Invoice date</th><th>Credit terms</th><th class="right">Ageing (days) ↓</th><th class="right">Invoice value</th><th class="right">Adjustments</th><th class="right">Round off</th><th class="right">Received</th><th class="right">Pending</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr class="clickable" data-invoice="${esc(x.id)}"><td><b class="strong">${esc(x.id)}</b>${x.recordType==='openingBalance'?'<br><span class="status review">Opening balance</span>':''}<br><small style="color:#8d97a8">${esc(x.code)}</small></td><td>${esc(x.orderNumber || '—')}</td><td>${esc(x.brandName || '—')}</td><td>${esc(x.customer)}</td><td>${dateText(x.date)}</td><td><b>${x.recordType==='openingBalance'?'Opening balance':x.creditDays+' days'}</b><br><small style="color:#8d97a8">Due ${dateText(x.dueDate)}</small></td><td class="right">${x.ageing}</td><td class="right">${fMoney(x.amount)}</td><td class="right">${fMoney(x.qtyReturn+x.priceReturn+x.PPV+x.PQV+x.CCOGS+x.TaxD+x.EPC+x.otherDebit)}</td><td class="right">${fMoney(x.roundOff)}</td><td class="right amount-green">${fMoney(x.Payment+x.TDS)}</td><td class="right ${x.pending<0?'pending-negative':x.pending>0?'pending-positive':'amount-green'}">${fMoney(x.pending)}</td><td>${statusMarkup(x.status)}</td><td><button class="btn" data-invoice="${esc(x.id)}" style="padding:5px 7px">View</button>${deleteButton('invoices',x)}</td></tr>`).join('')}</tbody></table></div>`; }
function invoiceRegisterData(){
  const all=allInvoices(),brandMap=new Map(),customerMap=new Map();
  const names=invoice=>invoice.brandAmounts?.map(part=>part.brandName) || [invoice.brandName || ''];
  const brandKey=name=>name.trim()?'brand:'+name.trim().toLowerCase():'unassigned';
  for(const invoice of all){
    customerMap.set('customer:'+customerKey(invoice.customer),invoice.customer);
    for(const name of names(invoice))if(!brandMap.has(brandKey(name)))brandMap.set(brandKey(name),name.trim() || 'Unassigned brand');
  }
  invoiceFilter.brand??='all';invoiceFilter.customer??='all';
  if(invoiceFilter.brand!=='all'&&!brandMap.has(invoiceFilter.brand))invoiceFilter.brand='all';
  if(invoiceFilter.customer!=='all'&&!customerMap.has(invoiceFilter.customer))invoiceFilter.customer='all';
  const invoices=all.filter(matchesCustomerScope).filter(x=>(`${x.id} ${x.openingReference || ''} ${x.recordType==='openingBalance'?'Opening balance':''} ${x.orderNumber || ''} ${x.brandName || ''} ${x.customer} ${x.code}`).toLowerCase().includes(invoiceFilter.search.toLowerCase()) && (invoiceFilter.status==='all'||x.status===invoiceFilter.status) && (invoiceFilter.brand==='all'||names(x).some(name=>brandKey(name)===invoiceFilter.brand)) && (invoiceFilter.customer==='all'||'customer:'+customerKey(x.customer)===invoiceFilter.customer)).sort((a,b)=>b.ageing-a.ageing || a.id.localeCompare(b.id));
  return {invoices,brands:[...brandMap].sort((a,b)=>a[1].localeCompare(b[1])),customers:[...customerMap].sort((a,b)=>a[1].localeCompare(b[1]))};
}
function renderInvoices() {
  const scope=invoiceRegisterData(),filtered=scope.invoices,t=totals(filtered);
  return `<section class="view"><div class="page-heading"><div><h1>Invoice register</h1><p>Ageing = today minus due date, sorted highest first. Negative days mean the invoice is not yet due. Pending balances from ₹-10 to ₹10 are rounded off automatically.</p></div><div class="heading-actions"><button class="btn" data-action="export-invoices">⇩ Export Excel</button><button class="btn primary" data-action="new-invoice">＋ Add invoice</button></div></div><section class="panel"><div class="summary-strip"><div class="summary-item"><small>Invoices + opening entries</small><b>${filtered.length}</b></div><div class="summary-item"><small>Invoices + opening value</small><b>${shortMoney(t.invoice)}</b></div><div class="summary-item"><small>Fully settled</small><b style="color:#16a77f">${filtered.filter(x=>x.status==='settled').length}</b></div><div class="summary-item"><small>Pending amount</small><b style="color:#d18d1b">${shortMoney(t.pending)}</b></div></div><div class="filter-bar"><div class="search-box">⌕<input id="invoiceSearch" value="${esc(invoiceFilter.search)}" placeholder="Search invoice, order, brand or customer" /></div><label style="display:flex;flex-direction:column;gap:4px;font-size:10px;font-weight:700">Invoice status<select class="filter-select" id="statusFilter" aria-label="Filter invoices by status"><option value="all">All invoice statuses</option><option value="settled" ${invoiceFilter.status==='settled'?'selected':''}>Fully settled</option><option value="due" ${invoiceFilter.status==='due'?'selected':''}>Due</option><option value="overdue" ${invoiceFilter.status==='overdue'?'selected':''}>Overdue</option><option value="overadjusted" ${invoiceFilter.status==='overadjusted'?'selected':''}>Excess paid</option></select></label><select class="filter-select" id="invoiceBrandFilter" aria-label="Filter invoices by brand"><option value="all">All brands</option>${scope.brands.map(([value,label])=>`<option value="${esc(value)}" ${invoiceFilter.brand===value?'selected':''}>${esc(label)}</option>`).join('')}</select><button class="btn" data-action="clear-filters">Clear filters</button></div>${invoiceTable(pageRows(filtered,'invoices'))}<div class="pagination"><span>Showing ${filtered.length} of ${state.invoices.length} invoices</span></div></section></section>`;
}
function customerRows(invoices=allInvoices().filter(matchesCustomerScope)) { const map=Object.create(null); invoices.forEach(i=>{if(!map[i.customer])map[i.customer]={customer:i.customer,code:i.code,count:0,invoice:0,returns:0,payment:0,tds:0,ppv:0,pqv:0,ccogs:0,taxd:0,epc:0,debitAdjustment:0,otherDebit:0,pending:0,overdue:0,due:0};const x=map[i.customer];x.count++;x.invoice+=i.amount;x.returns+=i.qtyReturn+i.priceReturn;x.payment+=i.Payment;x.tds+=i.TDS;x.ppv+=i.PPV;x.pqv+=i.PQV;x.ccogs+=i.CCOGS;x.taxd+=i.TaxD;x.epc+=i.EPC;x.debitAdjustment+=i.debitAdjustment;x.otherDebit+=i.otherDebit;x.pending+=i.pending;if(i.status==='overdue')x.overdue+=i.pending;if(i.status==='due')x.due+=i.pending;});return Object.values(map); }
function renderCustomers() { const rows=customerRows().sort((a,b)=>b.pending-a.pending);return `<section class="view"><div class="page-heading"><div><h1>Customer summary</h1><p>Overdue and due receivables, including opening balances from before reconciliation started.</p></div><div class="heading-actions"><button class="btn primary" data-action="opening-balances">Opening balances</button><button class="btn" data-action="customer-terms">Manage credit days</button><button class="btn" data-action="export" data-report="Customer Outstanding">⇩ Export Excel</button></div></div><div class="customer-cards">${rows.slice(0,3).map(c=>`<section class="panel customer-card" data-customer="${esc(c.customer)}"><div class="customer-card-head"><span class="customer-avatar">${c.customer.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><div><h3>${esc(c.customer)}</h3><p>${esc(c.code)} · ${c.count} invoices</p></div></div><div class="balance-split"><div><small>Overdue</small><b class="amount-red">${shortMoney(c.overdue)}</b></div><div><small>Due</small><b>${shortMoney(c.due)}</b></div></div><span class="status ${c.pending?'partial':'settled'}">${c.pending?'Outstanding balance':'Fully settled'}</span><div class="meter"><span style="width:${Math.min(100,((c.invoice-c.pending)/c.invoice)*100)}%"></span></div><div class="customer-card-foot"><span>Collection rate</span><b>${((c.invoice-c.pending)/c.invoice*100).toFixed(1)}%</b></div></section>`).join('')}</div><section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2>All customers</h2><p>Click a customer to drill into their invoice ledger.</p></div><div class="search-box">⌕<input placeholder="Search customer" /></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Customer</th><th class="right">Invoices + opening balances</th><th class="right">Returns</th><th class="right">Payment</th><th class="right">TDS</th><th class="right">Other deductions</th><th>Credit days</th><th class="right">Overdue</th><th class="right">Due</th><th class="right">Pending amount</th><th></th></tr></thead><tbody>${pageRows(rows,'customers').map(c=>`<tr class="clickable" data-customer="${esc(c.customer)}"><td><b class="strong">${esc(c.customer)}</b><br><small style="color:#8c96a7">${esc(c.code)} · ${c.count} invoices</small></td><td class="right">${fMoney(c.invoice)}</td><td class="right">${fMoney(c.returns)}</td><td class="right amount-green">${fMoney(c.payment)}</td><td class="right">${fMoney(c.tds)}</td><td class="right">${fMoney(c.ppv+c.pqv+c.ccogs+c.taxd+c.epc+c.otherDebit)}</td><td>${customerCreditDays(c.customer)} days</td><td class="right amount-red">${fMoney(c.overdue)}</td><td class="right">${fMoney(c.due)}</td><td class="right ${c.pending?'pending-positive':'amount-green'}">${fMoney(c.pending)}</td><td>›</td></tr>`).join('')}</tbody></table></div></section></section>`; }

function filteredAdvice(){return state.advice.filter(matchesCustomerScope).filter(row=>(adviceFilter.type==='all'||row.type===adviceFilter.type) && [row.id,row.customer,row.invoice,row.utr,row.description].join(' ').toLowerCase().includes(adviceFilter.search.toLowerCase()));}
function renderAdvice() { const rows=filteredAdvice();const unallocated=rows.filter(x=>!x.invoice);return `<section class="view"><div class="page-heading"><div><h1>Payment advice</h1><p>Invoice-level allocation instructions submitted by customers. Bank reference / UTR is mandatory and selected from unmapped bank receipts.</p></div><div class="heading-actions"><button class="btn" data-action="export-advice">⇩ Export Excel</button>${['admin','editor'].includes(sharedSession?.user.role)?'<button class="btn" data-action="bulk-import-advice">⇧ Bulk import</button>':''}<button class="btn primary" data-action="add-advice">＋ Add advice</button></div></div><section class="panel"><div class="summary-strip"><div class="summary-item"><small>Advice allocation rows</small><b>${rows.length}</b></div><div class="summary-item"><small>Allocated entries</small><b style="color:#16a77f">${rows.length-unallocated.length}</b></div><div class="summary-item"><small>Unallocated entries</small><b style="color:#4870df">${unallocated.length}</b></div><div class="summary-item"><small>Classification rules</small><b>7 permitted types</b></div></div><div class="filter-bar"><div class="search-box">⌕<input id="adviceSearch" value="${esc(adviceFilter.search)}" placeholder="Search customer, invoice, description or UTR" /></div><select class="filter-select" id="adviceTypeFilter" aria-label="Filter advice by transaction type"><option value="all">All transaction types</option>${['Payment','TDS','PPV','PQV','CCOGS','TaxD','EPC'].map(type=>`<option value="${type}" ${adviceFilter.type===type?'selected':''}>${type}</option>`).join('')}</select><button class="btn" data-view="unallocated">View unallocated</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Customer</th><th>Invoice</th><th>Transaction type</th><th>Transaction description</th><th>Bank reference / UTR</th><th class="right">Amount</th><th>Allocation</th><th></th></tr></thead><tbody>${pageRows(rows,'advice').map(x=>`<tr><td>${esc(x.customer)}</td><td>${x.invoice?`<button data-invoice="${esc(x.invoice)}" style="color:#4268dc;font-weight:800">${esc(x.invoice)}</button>`:'<span style="color:#5576dc;font-weight:800">Unallocated</span>'}</td><td><span class="status ${x.type==='Payment'?'matched':x.type==='TDS'?'review':'unallocated'}">${esc(x.type)}</span></td><td>${esc(x.description||'—')}</td><td style="font-family:DM Mono">${x.utr||'—'}</td><td class="right strong">${fMoney(x.amount)}</td><td>${statusMarkup(x.invoice?'matched':'unallocated')}</td><td>${deleteButton('advice',x)}</td></tr>`).join('')}</tbody></table></div></section></section>`; }
function renderBank(){
  const bank=bankRows().filter(matchesCustomerScope),receipts=filteredBankReceipts(bank),matched=bank.filter(row=>row.status==='matched'),open=bank.filter(row=>row.status!=='matched');
  const actionFor=row=>row.customer?.trim()?(row.pendingToMatch>0&&row.referenceCount===1&&!row.invalidAllocations?'allocate-receipt':'review-receipt'):'map-bank';
  return `<section class="view"><div class="page-heading"><div><h1>Bank reconciliation</h1><p>A bank receipt can fund multiple invoices for the same buyer. Pending to match = receipt amount minus allocated Payment advice.</p></div><div class="heading-actions"><button class="btn" data-action="export" data-report="Bank Reconciliation">⇩ Export report</button><button class="btn" data-action="new-bank">＋ Add bank receipt</button><button class="btn primary" data-action="match-selected">⇄ Recheck matching</button></div></div><div class="recon-cards"><div class="panel mini-kpi"><small>Bank credits</small><b>${shortMoney(sum(bank,row=>row.amount))}</b><span>${bank.length} receipt transactions</span></div><div class="panel mini-kpi"><small>Allocated Payment</small><b>${shortMoney(sum(bank,row=>row.allocatedAmount))}</b><span>Cash allocated across invoices</span></div><div class="panel mini-kpi"><small>Pending to match</small><b>${shortMoney(sum(bank,row=>Math.max(0,row.pendingToMatch)))}</b><span>${open.length} receipts need attention</span></div><div class="panel mini-kpi"><small>Fully matched receipts</small><b>${matched.length}</b><span>${shortMoney(sum(matched,row=>row.amount))} allocated</span></div></div><div class="bank-split"><section class="panel"><div class="panel-head"><div><h2>Receipt matching queue</h2><p>Only the remaining difference is pending to match. Negative differences indicate excess allocation.</p></div></div>${pageRows(open,'bank-queue').map(row=>`<div class="recon-item"><div class="recon-check ${row.status==='review'?'warn':'bad'}">${row.status==='review'?'±':'!'}</div><div><b>${esc(row.ref)}</b><small>${dateText(row.date)} · ${esc(row.customer || 'Customer not identified')}</small><small>Receipt ${fMoney(row.amount)} · Allocated ${fMoney(row.allocatedAmount)} · ${row.allocationCount} allocations</small></div><div class="amt"><b>${fMoney(row.pendingToMatch)}</b><small>Pending to match</small><div>${statusMarkup(row.status)}</div></div><button class="btn" data-action="${actionFor(row)}" data-ref="${esc(row.ref)}">${actionFor(row)==='allocate-receipt'?'Allocate':actionFor(row)==='map-bank'?'Map':'Review'}</button></div>`).join('')||'<div class="empty-state"><h3>Everything is reconciled</h3><p>No receipts are pending allocation.</p></div>'}</section><section class="panel"><div class="panel-head"><div><h2>Reconciliation controls</h2><p>Matching policy</p></div></div><div class="detail-section"><div class="allocation-row"><span>Same buyer across receipt and invoices</span><b>Required</b></div><div class="allocation-row"><span>Multiple invoices per reference</span><b>Enabled</b></div><div class="allocation-row"><span>Duplicate bank references</span><b>${bank.length-new Set(bank.map(row=>row.ref)).size} found</b></div><div class="allocation-row"><span>Allowed bank difference</span><b>₹0.00</b></div></div><p style="padding:0 17px 17px">Only Payment advice consumes bank cash. EPC, TDS and other deductions reduce invoice balances separately.</p></section></div><section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2>All bank receipts</h2><p>Allocation totals update automatically after advice is saved.</p></div></div>${bankReceiptFilterMarkup(bank)}<div class="table-wrap"><table class="data-table"><thead><tr><th>Transaction date</th><th>Bank reference / UTR</th><th>Customer</th><th>Narration</th><th>Bank name</th><th>Advice reference</th><th class="right">Credit amount</th><th class="right">Allocated Payment</th><th class="right">Pending to match</th><th>Allocations</th><th>Status</th><th></th></tr></thead><tbody>${pageRows(receipts,'bank').map(row=>`<tr><td>${dateText(row.date)}</td><td class="strong">${esc(row.ref)}</td><td>${esc(row.customer || '—')}</td><td>${esc(row.narration || '—')}</td><td>${esc(row.bankName || '—')}</td><td>${esc(row.advice || '—')}</td><td class="right strong">${fMoney(row.amount)}</td><td class="right">${fMoney(row.allocatedAmount)}</td><td class="right strong">${fMoney(row.pendingToMatch)}</td><td>${row.allocationCount}</td><td>${statusMarkup(row.status)}</td><td>${row.status!=='matched'?`<button class="btn" data-action="${actionFor(row)}" data-ref="${esc(row.ref)}">${actionFor(row)==='allocate-receipt'?'Allocate':actionFor(row)==='map-bank'?'Map':'Review'}</button>`:'✓'}${deleteButton('bank',row)}</td></tr>`).join('') || '<tr><td colspan="12">No bank receipts match these selections.</td></tr>'}</tbody></table></div></section></section>`;
}

function renderReturns() { const rows=[...state.returns.map(x=>({...x,kind:'Qty return'})),...state.priceReturns.map(x=>({...x,kind:'Price return',qty:'—',product:x.reason}))].filter(matchesCustomerScope).sort((a,b)=>b.date.localeCompare(a.date)); return `<section class="view"><div class="page-heading"><div><h1>Sales & price returns</h1><p>Document no., Type, Date, Original invoice and Amount are mandatory. Customer is taken from the original invoice.</p></div><div class="heading-actions"><button class="btn" data-action="export" data-report="Returns">⇩ Export report</button><button class="btn primary" data-action="import">⇧ Import return file</button></div></div><section class="panel"><div class="summary-strip"><div class="summary-item"><small>Quantity returns</small><b>${fMoney(sum(state.returns.filter(matchesCustomerScope),x=>x.amount))}</b></div><div class="summary-item"><small>Price returns</small><b>${fMoney(sum(state.priceReturns.filter(matchesCustomerScope),x=>x.amount))}</b></div><div class="summary-item"><small>Mapped to invoices</small><b style="color:#1ca37d">${rows.filter(row=>row.invoice).length}</b></div><div class="summary-item"><small>Unmapped returns</small><b>${rows.filter(row=>!row.invoice).length}</b></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Document no. *</th><th>Type *</th><th>Date *</th><th>Original invoice *</th><th class="right">Amount *</th><th></th></tr></thead><tbody>${pageRows(rows,'returns').map(x=>`<tr><td class="strong">${esc(x.id)}</td><td><span class="status ${x.kind==='Qty return'?'review':'unallocated'}">${x.kind}</span></td><td>${dateText(x.date)}</td><td>${x.invoice?`<button data-invoice="${esc(x.invoice)}" style="color:#4168dc;font-weight:800">${esc(x.invoice)}</button>`:statusMarkup('unallocated')}</td><td class="right strong">${fMoney(x.amount)}</td><td>${deleteButton(x.kind==='Price return'?'priceReturns':'returns',x)}</td></tr>`).join('')}</tbody></table></div></section></section>`; }
function renderDebit(){
  const notes=state.debitNotes.filter(matchesCustomerScope),editable=sharedSession?.user.role!=='viewer',detail=x=>window.ReconcileIQBank.debitNote(x);
  return `<section class="view"><div class="page-heading"><div><h1>Debit note register</h1><p>The linked invoice is adjusted by DN amount minus CN amount. A CN number settles the debit note.</p></div><div class="heading-actions"><button class="btn" data-action="export" data-report="Debit Note Register">⇩ Export report</button>${['admin','editor'].includes(sharedSession?.user.role)?'<button class="btn" data-action="bulk-import-debit">⇧ Bulk import</button>':''}${editable?'<button class="btn primary" data-action="new-debit">＋ Add debit note</button>':''}</div></div><section class="panel"><div class="summary-strip"><div class="summary-item"><small>Total debit notes</small><b>${notes.length}</b></div><div class="summary-item"><small>Debit note value</small><b>${shortMoney(sum(notes,x=>x.amount))}</b></div><div class="summary-item"><small>Settled</small><b>${notes.filter(x=>detail(x).status==='Settled').length}</b></div><div class="summary-item"><small>Unsettled</small><b>${notes.filter(x=>detail(x).status==='Unsettled').length}</b></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Debit note number</th><th>Date</th><th>Customer</th><th>Customer code</th><th>Original invoice</th><th>Type</th><th class="right">Amount</th><th>Related credit note</th><th class="right">Credit note amount</th><th class="right">Invoice adjustment</th><th>Status</th><th></th></tr></thead><tbody>${pageRows(notes,'debit').map(x=>`<tr><td class="strong">${esc(x.id)}</td><td>${dateText(x.date)}</td><td>${esc(x.customer)}</td><td>${esc(x.customerCode || '—')}</td><td>${x.invoice?'<button data-invoice="'+esc(x.invoice)+'">'+esc(x.invoice)+'</button>':'Not linked'}</td><td>${esc(x.type || 'Unknown')}</td><td class="right">${fMoney(x.amount)}</td><td>${esc(x.creditNoteNumber || '—')}</td><td class="right">${fMoney(x.creditNoteAmount || 0)}</td><td class="right">${x.settlementMode==='creditNote'?fMoney(detail(x).difference)+(x.invoice?'':' (not linked)'):'Legacy audit only'}</td><td><span class="status ${detail(x).status==='Settled'?'matched':'review'}">${detail(x).status}</span></td><td>${editable?'<button class="btn" data-action="edit-debit" data-ref="'+esc(x.id)+'">Edit / add CN</button>':''}${deleteButton('debitNotes',x)}</td></tr>`).join('')}</tbody></table></div></section></section>`;
}
function bankRows(){return window.ReconcileIQBank.rows(state);}
function unallocatedRows(){
  return [
    ...state.advice.filter(row=>!row.invoice).map(row=>({source:'Payment Advice',date:row.date,ref:row.id,customer:row.customer,type:row.type,amount:row.amount,issue:'Missing invoice reference',status:'unallocated',action:'map-advice'})),
    ...bankRows().filter(row=>row.status!=='matched').map(row=>({source:'Bank Statement',date:row.date,ref:row.ref,customer:row.customer || '—',type:'Bank credit',amount:row.pendingToMatch,issue:row.status==='review'?'Difference / reconciliation review required':'No matched payment advice',status:row.status==='review'?'review':'unallocated',action:row.customer?.trim()?(row.pendingToMatch>0&&row.referenceCount===1&&!row.invalidAllocations?'allocate-receipt':'review-receipt'):'map-bank'}))
  ].filter(matchesCustomerScope);
}
function renderUnallocated() { const rows=unallocatedRows(),advice=rows.filter(row=>row.source==='Payment Advice'),bank=rows.filter(row=>row.source==='Bank Statement'); return `<section class="view"><div class="page-heading"><div><h1>Unallocated transactions</h1><p>Unallocated advice and bank receipts that are unmatched or need reconciliation review.</p></div><div class="heading-actions"><button class="btn" data-action="export" data-report="Unallocated Transactions">⇩ Export report</button></div></div><div class="recon-cards"><div class="panel mini-kpi"><small>Unallocated advice</small><b>${advice.length}</b><span>${shortMoney(sum(advice,x=>x.amount))} to allocate</span></div><div class="panel mini-kpi"><small>Unmatched / Difference receipts</small><b>${bank.length}</b><span>${shortMoney(sum(bank,x=>x.amount))} to review</span></div><div class="panel mini-kpi"><small>Import exceptions</small><b>0</b><span>All source schemas valid</span></div><div class="panel mini-kpi"><small>Open work items</small><b style="color:#d6535c">${advice.length+bank.length}</b><span>Awaiting finance review</span></div></div><section class="panel"><div class="panel-head"><div><h2>Allocation queue</h2><p>Assign a customer and original invoice, or retain an item as an exception.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Source</th><th>Date</th><th>Reference</th><th>Customer</th><th>Transaction type</th><th class="right">Amount</th><th>Issue</th><th></th></tr></thead><tbody>${pageRows(rows,'unallocated').map(x=>`<tr><td>${x.source}</td><td>${dateText(x.date)}</td><td class="strong">${esc(x.ref)}</td><td>${esc(x.customer)}</td><td>${esc(x.type)}</td><td class="right strong">${fMoney(x.amount)}</td><td>${statusMarkup(x.status)} <small style="color:#8791a2">${esc(x.issue)}</small></td><td><button class="btn primary" data-action="${x.action}" data-ref="${esc(x.ref)}" style="padding:6px 8px">Allocate</button></td></tr>`).join('')}</tbody></table></div></section></section>`; }
function renderReports() { const reports=[['Invoice-wise Outstanding Report','Invoice balance, adjustment and ageing status by invoice.','Invoice Outstanding'],['Customer-wise Outstanding Report','Consolidated receivables and collection position by customer.','Customer Outstanding'],['Bank Reconciliation Report','Cleared bank receipts compared to payment advice.','Bank Reconciliation'],['Debit Note Register','Buyer debit notes and double-count protection review.','Debit Note Register'],['Unallocated Transaction Report','Payment advice and bank credits without an invoice mapping.','Unallocated Transactions'],['Fully Settled Invoice Report','Invoices with zero balance after reconciled adjustments.','Settled Invoices'],['Ageing Report','Outstanding balance bucketed by number of days open.','Ageing']];return `<section class="view"><div class="page-heading"><div><h1>Reports</h1><p>Export operational reconciliation reports to Excel-compatible CSV files.</p></div></div><section class="panel"><div class="panel-head"><div><h2>Available reports</h2><p>All exports use the live reconciliation data in this workspace.</p></div></div><div class="report-list">${reports.map(([name,desc,kind])=>`<div class="report-row"><div class="report-icon">▤</div><div><b>${name}</b><p>${desc}</p></div><button class="btn" data-action="export" data-report="${kind}">⇩ Export Excel</button></div>`).join('')}</div></section></section>`; }
function renderSync() {return `<section class="view"><div class="page-heading"><div><h1>Shared data</h1><p>Changes are saved centrally and checked for updates every 30 seconds.</p></div><button class="btn primary" data-action="sync">Refresh shared data</button></div><section class="panel"><div class="panel-head"><div><h2>Workspace status</h2><p>Revision ${workspaceRevision} · ${state.invoices.length} invoices · ${state.bank.length} bank receipts</p></div><span class="status matched">Shared database</span></div></section><section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2>Microsoft OneDrive</h2><p>Saved OneDrive mappings run every 15 minutes. New records are imported; changes to existing records need review. Refresh shared data reloads saved app records.</p></div>${['admin','editor'].includes(sharedSession?.user.role)?'<button class="btn" data-action="auto-sync">Automatic sync</button>':''}${sharedSession?.user.role === 'admin'?'<button class="btn" data-action="connect-onedrive">Manage connection</button>':''}</div></section></section>`;}

function renderSettings() { return `<section class="view"><div class="page-heading"><div><h1>Settings</h1><p>Shared workspace access, data recovery and integrations.</p></div></div>
<section class="panel"><div class="panel-head"><div><h2>Your account</h2><p>${esc(sharedSession?.user.email || '')} · ${esc(sharedSession?.user.role || 'test')}</p></div><button class="btn" data-team-action="password">Change password</button></div></section>
${sharedSession?.user.role === 'admin' ? `<section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2>Team access</h2><p>Create accounts, assign roles, reset passwords or disable access.</p></div><button class="btn primary" data-team-action="users">Manage users</button></div></section>
<section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2>Backups & history</h2><p>Download a workspace backup, review changes or restore a previous revision.</p></div></div><div class="team-actions"><button class="btn" data-team-action="backup">Download backup</button><button class="btn" data-team-action="restore">Import / restore JSON</button><button class="btn" data-team-action="legacy">Import existing browser data</button><button class="btn" data-team-action="snapshots">Previous revisions</button><button class="btn" data-team-action="audit">Activity history</button></div></section>` : ''}
<section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2>Microsoft OneDrive</h2><p>Connect your Microsoft 365 account and browse source files.</p></div>${['admin','editor'].includes(sharedSession?.user.role)?'<button class="btn" data-action="auto-sync">Automatic sync</button>':''}${sharedSession?.user.role === 'admin'?'<button class="btn primary" data-action="connect-onedrive">Manage connection</button>':'<span>Connection administrator managed</span>'}</div></section></section>`; }


function render() { document.getElementById('bankBadge').textContent=state.bank.filter(row=>row.status!=='matched').length;document.getElementById('unallocatedBadge').textContent=state.advice.filter(row=>!row.invoice).length+state.bank.filter(row=>row.status==='unmatched').length;document.getElementById('breadcrumb').innerHTML=`<span>Workspace</span><b>/</b><strong>${navTitle(currentView)}</strong>`;document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===currentView)); const renderers={dashboard:renderDashboard,invoices:renderInvoices,customers:renderCustomers,advice:renderAdvice,bank:renderBank,returns:renderReturns,debit:renderDebit,claims:renderBrandClaims,unallocated:renderUnallocated,reports:renderReports,sync:renderSync,settings:renderSettings}; pageCounts=Object.create(null);normalizeCustomerScope();const content=renderers[currentView]();app.innerHTML=customerScopeMarkup()+content+pageControls(); bindPageEvents(); }
function updateSearch(event,filter,key){
  const {id,value,selectionStart,selectionEnd}=event.target;filter.search=value;pagePositions[key]=0;render();
  const field=document.getElementById(id);field?.focus?.();if(Number.isInteger(selectionStart))field?.setSelectionRange?.(selectionStart,selectionEnd);
}
function bindPageEvents() {
  bindBankReceiptFilters();
  for(const [id,key] of [['claimMonthFilter','month'],['claimBrandFilter','brand'],['claimTypeFilter','type'],['claimStatusFilter','status']]){const input=document.getElementById(id);if(input)input.onchange=()=>{brandClaimFilter[key]=input.value;pagePositions.claims=0;render();};}
  for(const [id,key] of [['scopeBuyer','buyer'],['scopeCustomer','customer']]){const select=document.getElementById(id);if(select)select.addEventListener('change',event=>{customerScope[key]=event.target.value;invoiceFilter.customer='all';if(key==='buyer')customerScope.customer='all';for(const page of Object.keys(pagePositions))pagePositions[page]=0;render();});}
  const clearScope=document.getElementById('clearCustomerScope');if(clearScope)clearScope.onclick=()=>{customerScope={buyer:'all',customer:'all'};invoiceFilter.customer='all';for(const page of Object.keys(pagePositions))pagePositions[page]=0;render();};

  bindDeleteButtons(app);
  const brand=document.getElementById('dashboardBrandFilter');if(brand)brand.addEventListener('change',event=>{dashboardBrand=event.target.value;render();});
  app.querySelectorAll('[data-page-key]').forEach(button=>button.onclick=()=>{pagePositions[button.dataset.pageKey]=Number(button.dataset.pageNumber);render();});
  app.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.view)));
  app.querySelectorAll('[data-invoice]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openInvoice(b.dataset.invoice)}));
  app.querySelectorAll('[data-customer]').forEach(b=>b.addEventListener('click',()=>openCustomer(b.dataset.customer)));
  app.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();Promise.resolve(action(b.dataset.action,b.dataset)).catch(error=>showToast(error.message))}));
  if (sharedSession?.user.role === 'viewer') app.querySelectorAll('[data-action]').forEach(button=>{if(!['export','export-dashboard','export-invoices','export-advice','clear-filters','sync'].includes(button.dataset.action)){button.disabled=true;button.title='Viewer access';}});
  window.bindTeamControls?.();
  for(const [id,filter,key] of [['invoiceSearch',invoiceFilter,'invoices'],['adviceSearch',adviceFilter,'advice']]){const search=document.getElementById(id);if(search)search.addEventListener('input',event=>updateSearch(event,filter,key));}
  const adviceType=document.getElementById('adviceTypeFilter');if(adviceType)adviceType.addEventListener('change',event=>{adviceFilter.type=event.target.value;pagePositions.advice=0;render();});
  for(const [id,key] of [['invoiceBrandFilter','brand']]){const select=document.getElementById(id);if(select)select.addEventListener('change',event=>{invoiceFilter[key]=event.target.value;pagePositions.invoices=0;render();});}
  const status=document.getElementById('statusFilter');if(status)status.addEventListener('change',e=>{invoiceFilter.status=e.target.value;pagePositions.invoices=0;render();});
}
function go(view) { currentView=view;document.getElementById('sidebar').classList.remove('open');render();window.scrollTo(0,0); }

function action(name,data) { if(name==='bulk-import-brand-claims')return openRegisterBulkImport('brandClaims');if(name==='add-brand-claim')return openBrandClaim();if(name==='edit-brand-claim')return openBrandClaim(data.ref);if(name==='brand-credit-days')return openBrandCreditDays();if(name==='download-claim-file')return downloadClaimAttachment(data.ref);if(name==='export-brand-claims')return exportBrandClaims();if(name==='clear-claim-filters'){brandClaimFilter={month:'',brand:'all',type:'all',status:'all'};pagePositions.claims=0;return render();} if(name==='opening-balances')return openOpeningBalances(); if(name==='buyer-groups')return openBuyerGroups(); if(name==='bulk-import-advice')return openRegisterBulkImport('advice');if(name==='bulk-import-debit')return openRegisterBulkImport('debitNotes'); if(name==='review-receipt'){adviceFilter={search:data.ref,type:'Payment'};return go('advice');} if(name==='allocate-receipt')return openAdvice(data.ref); if(name==='export-advice')return exportReport('Payment Advice',filteredAdvice()); if(name==='export-invoices')return exportReport('Invoice Outstanding',invoiceRegisterData().invoices); if(name==='export-dashboard')return exportReport('Invoice Outstanding',dashboardData().invoices); if(name==='export') return exportReport(data.report); if(name==='auto-sync')return openSyncSources().catch(error=>showToast(error.message)); if(name==='sync') return runSync(); if(name==='import') return openImport();if(name==='connect-onedrive') return openConnect();if(name==='new-invoice')return openNewInvoice();if(name==='new-bank')return openBankReceipt();if(name==='customer-terms')return openCustomerTerms();if(name==='add-advice')return openAdvice();if(name==='new-debit')return openDebit();if(name==='edit-debit')return openDebit(data.ref);if(name==='map-bank'||name==='map-advice'||name==='map-debit')return openMap(name,data.ref);if(name==='match-selected')return matchEligible();if(name==='clear-filters'){invoiceFilter={search:'',status:'all',brand:'all',customer:'all'};pagePositions.invoices=0;return render();}if(name==='reset-data'){if(sharedSession)return showToast('Shared data can only be replaced through an administrator backup restore.');state=clone(seed);initializeCustomerTerms();persist();render();return showToast('Sample workspace restored.');}if(name==='view-errors')return showToast('Source-file import is not configured.'); }
function modal(title,subtitle,content,footer='') { const layer=document.getElementById('modalLayer');layer.classList.remove('advice-batch');layer.innerHTML=`<div class="modal"><div class="modal-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle||'')}</p></div><button class="modal-close" data-close-modal>×</button></div><div class="modal-content">${content}</div>${footer?`<div class="modal-foot">${footer}</div>`:''}</div>`;layer.classList.remove('hidden');layer.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=closeModal);layer.onclick=e=>{if(e.target===layer)closeModal();};bindDeleteButtons(layer);return layer; }
function deleteButton(collection,row){
  if(sharedSession?.user.role!=='admin'||!row)return '';
  const index=collection==='bank'&&Number.isInteger(row.originalIndex)?row.originalIndex:['bank','advice'].includes(collection)?state[collection].indexOf(row):state[collection].findIndex(entry=>entry.id===row.id);
  return index<0?'':`<button class="btn danger" data-delete-collection="${collection}" data-delete-index="${index}">Delete</button>`;
}
function bindDeleteButtons(container){container.querySelectorAll('[data-delete-collection]').forEach(button=>button.onclick=event=>{event.stopPropagation();openDeleteEntry(button.dataset.deleteCollection,Number(button.dataset.deleteIndex));});}
function openDeleteEntry(collection,index){
  if(sharedSession?.user.role!=='admin')return showToast('Only administrators can delete entries.');
  if(saving)return showToast('Wait for the current save to finish.');
  const labels={invoices:'invoice',bank:'bank receipt',debitNotes:'debit note',advice:'payment advice',returns:'sales return',priceReturns:'price return',brandClaims:'brand claim'};
  if(!Object.hasOwn(labels,collection)||!Number.isInteger(index))return;
  const row=state[collection][index];if(!row)return showToast('This entry no longer exists. Refresh the register.');
  const revision=workspaceRevision,identifier=collection==='bank'?row.ref:row.id,links=[];
  if(collection==='invoices')for(const [key,label] of [['advice','payment advice'],['returns','sales returns'],['priceReturns','price returns'],['debitNotes','debit notes']]){const count=state[key].filter(entry=>entry.invoice===identifier).length;if(count)links.push(`${count} ${label}`);}
  if(collection==='bank'){const count=state.advice.filter(entry=>entry.utr===identifier).length;if(count)links.push(`${count} payment advice`);}
  const blocked=links.length>0;
  const layer=modal(`Delete ${labels[collection]}`,identifier,`<p>${blocked?'Remove the linked entries before deleting this record: '+esc(links.join(', '))+'.':(collection==='advice'?'This removes one invoice allocation row. Other rows under the same UTR remain. A previous revision is kept for recovery.':'This removes one entry from the shared workspace. A previous revision is kept for recovery.')}</p><div class="detail-top"><div><small>Reference</small><b>${esc(identifier)}</b></div><div><small>Customer</small><b>${esc(row.customer || '—')}</b></div><div><small>Date</small><b>${dateText(row.date)}</b></div><div><small>Amount</small><b>${fMoney(row.amount)}</b></div>${row.invoice?`<div><small>Invoice</small><b>${esc(row.invoice)}</b></div>`:''}${row.type?`<div><small>Type</small><b>${esc(row.type)}</b></div>`:''}</div>${collection==='advice'&&row.type==='Payment'?'<p>Deleting a payment allocation reopens its bank receipt for allocation and recalculates the invoice balance.</p>':''}<p id="deleteError" class="form-error" role="alert"></p>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn danger" id="confirmDelete" ${blocked?'disabled':''}>Delete entry</button>`);
  layer.querySelector('#confirmDelete').onclick=async()=>{
    if(saving||blocked)return;const button=layer.querySelector('#confirmDelete');button.disabled=true;saving=true;
    try{
      const result=await window.workspaceAPI('/api/records/delete','POST',{revision,collection,index,identifier});
      state=result.state;workspaceRevision=result.revision;savedState=clone(state);sharedSession.state=clone(state);sharedSession.revision=workspaceRevision;closeModal(true);render();showToast(`${labels[collection]} deleted.`);
    }catch(error){
      document.getElementById('deleteError').textContent=error.message;
      if(error.status===409){try{const latest=await window.workspaceAPI('/api/state');state=latest.state;initializeCustomerTerms();workspaceRevision=latest.revision;savedState=clone(state);sharedSession.state=clone(state);sharedSession.revision=workspaceRevision;render();}catch(refreshError){document.getElementById('deleteError').textContent=refreshError.message;}}
      else button.disabled=false;
    }finally{saving=false;}
  };
}
function closeModal(force=false){if(saving && force!==true)return;document.getElementById('modalLayer').classList.add('hidden');}
function openInvoice(id) { const x=allInvoices().find(i=>i.id===id);if(!x)return;const ret=state.returns.filter(r=>r.invoice===id),pr=state.priceReturns.filter(r=>r.invoice===id),adv=state.advice.filter(a=>a.invoice===id),dn=state.debitNotes.filter(note=>note.invoice===id && note.settlementMode==='creditNote'),utrs=new Set(adv.map(a=>a.utr)),bank=state.bank.filter(b=>utrs.has(b.ref));const deducted=[['Qty return',x.qtyReturn],['Price return',x.priceReturn],['Payment',x.Payment],['TDS',x.TDS],['PPV',x.PPV],['PQV',x.PQV],['CCOGS',x.CCOGS],['TaxD',x.TaxD],['EPC',x.EPC],...(x.otherDebit?[['Unknown',x.otherDebit]]:[]),['Manual round off',x.manualRoundOff],['Automatic round off',x.autoRoundOff]];modal(`${x.recordType==='openingBalance'?'Opening balance':'Invoice'} ${x.id}`,`${x.customer} · ${x.code}`,`<div class="detail-top"><div><small>Invoice date</small><b>${dateText(x.date)}</b></div><div><small>Invoice value</small><b>${fMoney(x.amount)}</b></div><div><small>Total adjusted</small><b>${fMoney(x.deducted+x.roundOff)}</b></div><div><small>Pending amount</small><b class="detail-highlight">${fMoney(x.pending)}</b></div></div><div class="detail-grid"><section class="detail-section"><h3>Reconciliation allocation</h3>${deducted.map(([n,v])=>`<div class="allocation-row"><span>${n}</span><b class="amount">${fMoney(v)}</b></div>`).join('')}<div class="allocation-row" style="margin-top:4px"><b>Final pending</b><b class="amount ${x.pending?'detail-highlight':''}">${fMoney(x.pending)}</b></div></section><section class="detail-section"><h3>${x.recordType==='openingBalance'?'Opening receivable':'Original invoice'}</h3>${x.recordType==='openingBalance'?`<div class="allocation-row"><span>Earlier invoice / reference</span><b>${esc(x.openingReference || 'Consolidated balance')}</b></div>`:''}<div class="allocation-row"><span>Brand name</span><b>${esc(x.brandName || '—')}</b><button class="btn" id="editBrandName">Edit brand name</button></div><div class="allocation-row"><span>Order number</span><b>${esc(x.orderNumber || '—')}</b></div><div class="allocation-row"><span>Credit terms</span><b>${x.recordType==='openingBalance'?'Original due date applies':x.creditDays+' days'}</b></div><div class="allocation-row"><span>Due date</span><b>${dateText(x.dueDate)}</b></div><div class="allocation-row"><span>Ageing (today − due date)</span><b>${x.ageing} days</b></div><div class="allocation-row"><span>Reconciliation status</span>${statusMarkup(x.status)}</div></section></div>${invoiceRemarksMarkup(x)}<section class="detail-section" style="margin-top:15px"><h3>Transaction history</h3><table class="data-table" style="min-width:0"><thead><tr><th>Date</th><th>Reference</th><th>Transaction</th><th class="right">Amount</th></tr></thead><tbody>${[...ret.map(r=>({date:r.date,ref:r.id,type:'Quantity return',amount:r.amount})),...pr.map(r=>({date:r.date,ref:r.id,type:'Price return',amount:r.amount})),...adv.map(a=>({date:a.date,ref:a.id+' · '+a.utr,type:a.type,amount:a.amount})),...dn.map(note=>({date:note.date,ref:note.id+(note.creditNoteNumber?' · '+note.creditNoteNumber:''),type:note.type==='TAXD'?'TaxD':note.type || 'Unknown',amount:window.ReconcileIQBank.debitNote(note).difference})),...bank.map(b=>({date:b.date,ref:b.ref,type:'Verified bank receipt',amount:b.amount}))].sort((a,b)=>a.date.localeCompare(b.date)).map(r=>`<tr><td>${dateText(r.date)}</td><td>${esc(r.ref)}</td><td>${esc(r.type)}</td><td class="right strong">${fMoney(r.amount)}</td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:#8d97a8">No adjustments recorded</td></tr>'}</tbody></table></section>`,` ${deleteButton('invoices',state.invoices.find(row=>row.id===id))}<button class="btn" data-close-modal>Close</button>${x.recordType==='openingBalance' && sharedSession?.user.role==='admin'?'<button class="btn primary" id="editOpeningBalance">Edit opening balance</button>':''}<button class="btn" id="editOrderNumber">Edit order number</button><button class="btn" id="editRoundOff">Edit round off</button><button class="btn primary" data-modal-export="${esc(x.id)}">⇩ Export reconciliation</button>`);if(x.recordType==='openingBalance' && sharedSession?.user.role==='admin')document.getElementById('editOpeningBalance').onclick=()=>openNewOpeningBalance(id);document.getElementById('editBrandName').disabled=sharedSession?.user.role==='viewer'||!!x.brandAmounts||(x.recordType==='openingBalance' && sharedSession?.user.role!=='admin');document.getElementById('editBrandName').onclick=()=>openBrandName(id);document.getElementById('editOrderNumber').disabled=sharedSession?.user.role==='viewer'||(x.recordType==='openingBalance' && sharedSession?.user.role!=='admin');document.getElementById('editOrderNumber').onclick=()=>openOrderNumber(id);document.getElementById('editRoundOff').disabled=sharedSession?.user.role==='viewer'||(x.recordType==='openingBalance' && sharedSession?.user.role!=='admin');document.getElementById('editRoundOff').onclick=()=>openRoundOff(id);document.querySelector('[data-modal-export]')?.addEventListener('click',()=>exportReport('Invoice Outstanding',[x]));bindInvoiceRemarks(id); }
function openCustomer(customer) { const rows=allInvoices().filter(x=>x.customer===customer);const c=customerRows().find(x=>x.customer===customer);modal(customer,`${c.code} · ${c.count} invoice${c.count>1?'s':''}`,`<div class="detail-top"><div><small>Invoice value</small><b>${fMoney(c.invoice)}</b></div><div><small>Returns</small><b>${fMoney(c.returns)}</b></div><div><small>Payment received</small><b>${fMoney(c.payment)}</b></div><div><small>Pending amount</small><b class="detail-highlight">${fMoney(c.pending)}</b></div></div><div class="balance-split"><div><small>Overdue</small><b class="amount-red">${fMoney(c.overdue)}</b></div><div><small>Due</small><b>${fMoney(c.due)}</b></div></div><div style="margin-top:16px">${invoiceTable(rows)}</div>`,`<button class="btn" data-close-modal>Close</button><button class="btn primary" data-modal-export="customer">⇩ Export customer ledger</button>`);document.querySelector('[data-modal-export]')?.addEventListener('click',()=>exportReport('Customer Outstanding',rows)); }
function invoiceRemarksMarkup(invoice){
  const canEdit=['admin','editor'].includes(sharedSession?.user.role);
  return `<section class="detail-section" style="margin-top:15px"><h3>Remarks</h3>${canEdit?`<label class="account-form">Comments against this invoice<textarea id="invoiceRemarks" rows="4" maxlength="2000" placeholder="Enter your comments…">${esc(invoice.remarks || '')}</textarea></label><p id="invoiceRemarksError" class="form-error" role="alert"></p><button class="btn primary" id="saveInvoiceRemarks">Save remarks</button>`:`<p style="white-space:pre-wrap">${esc(invoice.remarks || 'No remarks added.')}</p>`}</section>`;
}
function bindInvoiceRemarks(id){
  if(!['admin','editor'].includes(sharedSession?.user.role))return;
  const button=document.getElementById('saveInvoiceRemarks');if(!button)return;
  button.onclick=async()=>{
    if(saving)return;
    const errorField=document.getElementById('invoiceRemarksError');errorField.textContent='';
    try{
      const remarks=document.getElementById('invoiceRemarks').value.trim();
      if(remarks.length>2000 || /[<>\x00-\x08\x0b-\x1f]/.test(remarks))throw Error('Use up to 2,000 characters of plain text without angle brackets or control characters.');
      const invoice=state.invoices.find(row=>row.id===id);if(!invoice)throw Error('This invoice is no longer available.');
      invoice.remarks=remarks;await persist();render();openInvoice(id);showToast('Invoice remarks saved.');
    }catch(error){errorField.textContent=error.message;}
  };
}
function openOrderNumber(id){
  if(sharedSession?.user.role==='viewer')return showToast('Viewer access cannot edit invoices.');
  const invoice=state.invoices.find(row=>row.id===id);if(!invoice)return;
  modal('Edit order number',id,`<label class="account-form">Order number<input id="editInvoiceOrder" value="${esc(invoice.orderNumber || '')}" maxlength="2000" placeholder="Optional" /></label>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveInvoiceOrder">Save order number</button>`);
  document.getElementById('saveInvoiceOrder').onclick=async()=>{
    try{const value=document.getElementById('editInvoiceOrder').value.trim();const current=state.invoices.find(row=>row.id===id);if(!current)throw new Error('This invoice is no longer available.');current.orderNumber=value;await persist();closeModal();render();showToast('Order number saved.');}catch(error){showToast(error.message);}
  };
}
function openBrandName(id){if(state.invoices.find(x=>x.id===id)?.brandAmounts)return showToast('This invoice has brand amounts from import. Correct its brand breakdown in the source.');
  if(sharedSession?.user.role==='viewer')return showToast('Viewer access cannot edit invoices.');
  const invoice=state.invoices.find(row=>row.id===id);if(!invoice)return;
  modal('Edit brand name',id,`<label class="account-form">Brand name<input id="editInvoiceBrand" value="${esc(invoice.brandName || '')}" maxlength="2000" placeholder="Optional" /></label>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveInvoiceBrand">Save brand name</button>`);
  document.getElementById('saveInvoiceBrand').onclick=async()=>{
    try{const value=document.getElementById('editInvoiceBrand').value.trim();const current=state.invoices.find(row=>row.id===id);if(!current)throw new Error('This invoice is no longer available.');current.brandName=value;await persist();closeModal();render();showToast('Brand name saved.');}catch(error){showToast(error.message);}
  };
}
function openImport() {return openConnect();}

const registerImportTemplates={
  advice:['Customer name','Invoice number','Transaction type','Amount','Transaction description','UTR'],
  brandClaims:['Related month','Brand','Customer name','Claim type','Claim received date','Buyer DN/Invoice number','Buyer DN amount','Buyer CN number if cancelled','Buyer CN amount','Related CN date','Related CN number','Related CN amount','Claim reference'],
  debitNotes:['Debit note number','Customer name','Date','Amount','Invoice number','Type','Customer code','Related credit note','Credit note amount'],
};
function openScopedCsvImport(type){
  const layer=modal(type==='brandClaims'?'Import brand claims':type==='advice'?'Import payment advice':'Import debit notes',Array.isArray(sharedSession?.user.buyerGroupIds)?'Import records for your assigned buyer groups.':'Import records into the shared workspace.',`<p>Choose a UTF-8 CSV file from your computer, up to 2 MB and 5,000 data rows. Save an Excel worksheet as CSV first. Every row must belong to your assigned customers.</p><label class="account-form">CSV file<input id="scopedImportFile" type="file" accept=".csv,text/csv" /></label><p id="scopedImportError" class="form-error" role="alert"></p>`,`<button class="btn" id="scopedImportTemplate">Download template</button><button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="readScopedCsv">Read file</button>`);
  layer.querySelector('#scopedImportTemplate').onclick=()=>downloadRegisterImportTemplate(type);
  layer.querySelector('#readScopedCsv').onclick=async()=>{
    const button=layer.querySelector('#readScopedCsv');if(button.disabled)return;button.disabled=true;
    try{const file=layer.querySelector('#scopedImportFile').files?.[0];if(!file || !/\.csv$/i.test(file.name))throw Error('Choose a UTF-8 CSV file.');if(file.size>2*1024*1024)throw Error('Use a CSV file up to 2 MB.');
      const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
      const [book,{definitions}]=await Promise.all([window.workspaceAPI('/api/import/file','POST',{name:'upload.csv',data:btoa(binary)}),window.workspaceAPI('/api/import/definitions')]);
      openImportMapping(book,definitions,0,type);
    }catch(error){layer.querySelector('#scopedImportError').textContent=error.message;button.disabled=false;}
  };
}
function downloadRegisterImportTemplate(type){
  const headers=registerImportTemplates[type];if(!headers)return;
  const blob=new Blob([headers.map(csvEscape).join(',')+'\r\n'],{type:'text/csv;charset=utf-8;'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=type==='brandClaims'?'brand-claims-template.csv':type==='advice'?'payment-advice-template.csv':'debit-notes-template.csv';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}
function openRegisterBulkImport(type){
  if(!['admin','editor'].includes(sharedSession?.user.role))return showToast('Administrator or editor access is required to bulk import records.');
  if(!Object.hasOwn(registerImportTemplates,type))return;
  if(type==='brandClaims')return openClaimBulkImport();
  const advice=type==='advice';
  if(sharedSession?.user.buyerGroupIds!==null && sharedSession?.user.buyerGroupIds!==undefined)return openScopedCsvImport(type);
  const layer=modal(advice?'Bulk import payment advice':'Bulk import debit notes','Import an Excel (.xlsx) or CSV file from OneDrive.',`<p>Download the CSV template, fill it in using Excel, and save it to your connected OneDrive. You can also use an existing file and map its columns.</p><p><strong>Required columns:</strong> ${advice?'Customer name, Invoice number, Transaction type, Amount, Transaction description and UTR.':'Debit note number, Customer name, Customer code, Date, Amount, Invoice number and Type. Only Related credit note and Credit note amount are optional.'}</p><p>${advice?'Use one row per invoice allocation. Repeat a UTR across multiple rows to allocate a receipt to several invoices for the same buyer. Types: Payment, TDS, PPV, PQV, CCOGS, TaxD and EPC. Import invoices and bank receipts first. Payment totals cannot exceed the available bank balance.':'Types: PPV, PQV, CCOGS, TAXD and EPC. Use YYYY-MM-DD dates or select your date format during mapping. The linked invoice is adjusted by DN amount minus CN amount immediately. Add a CN number to settle the debit note. Do not also allocate the same deduction in Payment Advice.'}</p><p>Files up to 100 MB and up to 200,000 rows per register are supported. Review the full-file validation results and confirm before saving. Identical records are skipped; invalid or conflicting records must be corrected.</p>`,`<button class="btn" id="downloadRegisterTemplate">Download template</button><button class="btn" id="resumeRegisterImport">Resume prepared file</button><button class="btn primary" id="chooseRegisterImport">Choose OneDrive file</button><button class="btn" data-close-modal>Cancel</button>`);
  layer.querySelector('#downloadRegisterTemplate').onclick=()=>downloadRegisterImportTemplate(type);
  layer.querySelector('#resumeRegisterImport').onclick=()=>openBulkImports(type).catch(error=>showToast(error.message));
  layer.querySelector('#chooseRegisterImport').onclick=()=>openConnect(type).catch(error=>showToast(error.message));
}

async function openConnect(importType='invoices'){
  if(sharedSession?.user.role==='editor' && !Array.isArray(sharedSession.user.buyerGroupIds))return openOneDriveFolder('root',[],'',importType);
  if(sharedSession?.user.role !== 'admin') return showToast('Ask your administrator to connect OneDrive.');
  const status=await window.workspaceAPI('/api/onedrive/status');
  const missing=[...status.missing,...status.invalid];
  const content=status.ready
    ? `<p>${status.connected ? `Connected as <strong>${esc(status.account)}</strong>.` : 'Sign in with the Microsoft 365 account that owns your source files.'}</p><p>The connection can read files. Browsing does not change your financial records.</p>${status.connected?'<button class="btn primary" id="onedriveBrowse">Browse files</button> ':''}<button class="btn" id="onedriveAuthorize">${status.connected?'Reconnect':'Connect Microsoft 365'}</button>${status.connected?' <button class="btn" id="onedriveDisconnect">Disconnect</button>':''}`
    : `<p>Complete the Microsoft 365 registration, then add these Production environment variables in Netlify with the Functions scope:</p><ul>${[...new Set(missing)].map(key=>`<li><code>${esc(key)}</code>${status.invalid.includes(key)?' — check the format':''}</li>`).join('')}</ul><p>Use a <strong>Web</strong> redirect URI:</p><p><code>https://reconcileiq-urbanretail.netlify.app/api/onedrive/callback</code></p><p>Microsoft Graph delegated permission: <strong>Files.Read</strong>. Set the client secret and token key as secrets, then redeploy.</p><p><a href="https://entra.microsoft.com/" target="_blank" rel="noopener noreferrer">Open Microsoft Entra</a> · <a href="https://app.netlify.com/projects/reconcileiq-urbanretail/configuration/env" target="_blank" rel="noopener noreferrer">Open Netlify variables</a></p>`;
  const recovery=status.credentialError?'<p>The saved credentials cannot be opened with the current token key. Restore the original key, or reconnect to replace the saved connection.</p><button class="btn" id="onedriveDisconnect">Clear saved connection</button>':'';
  const layer=modal('Microsoft OneDrive',status.connected?'Connected':status.ready?'Ready to connect':'Setup required',content+recovery+(status.connected?' <button class="btn" id="onedriveJobs">Bulk imports</button> <button class="btn" id="onedriveAutoSync">Automatic sync</button>':''),'<button class="btn" data-close-modal>Close</button>');
  const autoSync=layer.querySelector('#onedriveAutoSync');if(autoSync)autoSync.onclick=()=>openSyncSources().catch(error=>showToast(error.message));
  const jobs=layer.querySelector('#onedriveJobs');if(jobs)jobs.onclick=()=>openBulkImports(importType).catch(error=>showToast(error.message));
  const connect=layer.querySelector('#onedriveAuthorize');
  if(connect) connect.onclick=async()=>{connect.disabled=true;try{const result=await window.workspaceAPI('/api/onedrive/connect','POST',{});window.location.assign(result.url);}catch(error){connect.disabled=false;showToast(error.message);}};
  const disconnect=layer.querySelector('#onedriveDisconnect');
  if(disconnect) disconnect.onclick=async()=>{disconnect.disabled=true;try{await window.workspaceAPI('/api/onedrive/disconnect','POST',{});await openConnect(importType);showToast('OneDrive disconnected.');}catch(error){disconnect.disabled=false;showToast(error.message);}};
  const browse=layer.querySelector('#onedriveBrowse');if(browse) browse.onclick=()=>openOneDriveFolder('root',[],'',importType).catch(error=>showToast(error.message));
}
async function openOneDriveFolder(folder='root',trail=[],page='',importType='invoices'){
  const result=await window.workspaceAPI(`/api/onedrive/files?folder=${encodeURIComponent(folder)}&page=${encodeURIComponent(page)}`);
  const layer=modal('OneDrive files',trail.map(item=>item.name).join(' / ') || 'My files',`<p>Choose Import for an Excel (.xlsx) or CSV file, map the columns, then review the preview before saving. Files up to 100 MB use background preparation. Up to 200,000 records per register; the preview checks workspace capacity.</p><div class="table-wrap"><table><thead><tr><th>Name</th><th>Last modified</th><th>Action</th></tr></thead><tbody>${result.items.map((item,index)=>`<tr><td>${item.folder?'📁 ':''}${esc(item.name)}</td><td>${esc((item.modified || '').slice(0,10))}</td><td>${item.folder?`<button class="btn small" data-folder-index="${index}">Open folder</button>`:`${/\.(xlsx|csv)$/i.test(item.name)?`<button class="btn small primary" data-import-index="${index}">Import</button> `:''}${item.webUrl?`<a class="btn small" href="${esc(item.webUrl)}" target="_blank" rel="noopener noreferrer">Open file</a>`:''}`}</td></tr>`).join('') || '<tr><td colspan="3">This folder is empty.</td></tr>'}</tbody></table></div>`,`<button class="btn" id="onedriveBack">${page?'First page':trail.length?'Back':'Connection settings'}</button>${result.nextPage?'<button class="btn" id="onedriveNext">Next page</button>':''}<button class="btn" data-close-modal>Close</button>`);
  const navigate=task=>Promise.resolve(task).catch(error=>showToast(error.message));
  layer.querySelectorAll('[data-folder-index]').forEach(button=>button.onclick=()=>{const item=result.items[Number(button.dataset.folderIndex)];navigate(openOneDriveFolder(item.id,[...trail,{id:folder,name:item.name}],'',importType));});
  layer.querySelectorAll('[data-import-index]').forEach(button=>button.onclick=async()=>{button.disabled=true;button.textContent='Reading…';try{await openOneDriveImport(result.items[Number(button.dataset.importIndex)].id,importType);}catch(error){button.disabled=false;button.textContent='Import';showToast(error.message);}});
  layer.querySelector('#onedriveBack').onclick=()=>navigate(page?openOneDriveFolder(folder,trail,'',importType):trail.length?openOneDriveFolder(trail.at(-1).id,trail.slice(0,-1),'',importType):(sharedSession?.user.role==='editor'?openRegisterBulkImport(importType):openConnect(importType)));
  const next=layer.querySelector('#onedriveNext');if(next) next.onclick=()=>navigate(openOneDriveFolder(folder,trail,result.nextPage,importType));
}

async function openOneDriveImport(id,importType='invoices'){
  const [workbook,{definitions}]=await Promise.all([window.workspaceAPI('/api/onedrive/workbook?id='+encodeURIComponent(id)),window.workspaceAPI('/api/import/definitions')]);
  if(workbook.large){const job=await window.workspaceAPI('/api/import-jobs','POST',{fileId:id});return watchBulkImport(job.id,importType);}
  return openImportMapping(workbook,definitions,0,importType);
}
async function openBulkImports(importType='invoices'){
  const {jobs}=await window.workspaceAPI('/api/import-jobs');
  const layer=modal('Bulk imports','Prepared data is available for six hours. Financial records change only after you confirm the preview.',`<div class="table-wrap"><table class="data-table"><thead><tr><th>File</th><th>Status</th><th>Action</th></tr></thead><tbody>${jobs.map(job=>`<tr><td>${esc(job.info.name)}</td><td>${esc(job.status)}${job.error?`<p>${esc(job.error)}</p>`:''}</td><td>${['queued','processing','ready'].includes(job.status)?`<button class="btn" data-bulk-job="${job.id}">${job.status==='ready'?'Map columns':'View progress'}</button>`:'—'}</td></tr>`).join('') || '<tr><td colspan="3">No recent bulk imports.</td></tr>'}</tbody></table></div>`,'<button class="btn" data-close-modal>Close</button>');
  layer.querySelectorAll('[data-bulk-job]').forEach(button=>button.onclick=()=>watchBulkImport(button.dataset.bulkJob,importType).catch(error=>showToast(error.message)));
}
async function openSyncSources(){
  if(!['admin','editor'].includes(sharedSession?.user.role))return showToast('Administrator or editor access required.');
  const {sources,runs,templates=[],scoped=false}=await window.workspaceAPI('/api/sync-sources');
  const time=value=>value?esc(new Date(value).toLocaleString('en-IN')):'Not yet';
  const layer=modal('Automatic OneDrive sync','Checks saved file mappings every 15 minutes, even when the app is closed.',`<p>New records are imported and identical rows are skipped. Existing amounts, customers and other changed fields are kept for administrator review. Rows removed from Excel are kept in the app. ${scoped?'Choose an approved mapping below to sync your assigned customers.':'To add a file, browse OneDrive, choose Import, map its columns, then choose Enable automatic sync.'} Payment advice requires manual import.</p>${scoped?`<h3>Approved mappings</h3><p>Enable a separate sync for your assigned buyer groups. Shared mappings and other users’ syncs stay unchanged.</p>${templates.map(t=>`<p><b>${esc(t.name)} · ${esc(t.sheetName)}</b> (${esc(t.type)}) <button class="btn small" data-approved-sync="${esc(t.id)}">Enable for my buyer groups</button></p>`).join('') || '<p>No approved mappings are available yet. Ask an administrator or editor with all-customer access to save a mapping.</p>'}`:''}<div class="table-wrap"><table><thead><tr><th>File / worksheet</th><th>Register</th><th>Status</th><th>Last processed</th><th>Actions</th></tr></thead><tbody>${sources.map(s=>`<tr><td>${esc(s.config.name)}<br>${esc(s.config.sheetName)}</td><td>${esc(s.config.type)}</td><td>${esc(s.enabled?s.status:'paused')}</td><td>${time(s.last_success)}</td><td><button class="btn small" data-sync-id="${esc(s.id)}" data-sync-action="${s.enabled?'pause':'resume'}">${s.enabled?'Pause':'Resume'}</button>${s.enabled?` <button class="btn small" data-sync-id="${esc(s.id)}" data-sync-action="run">Run now</button>`:''}</td></tr>`).join('') || '<tr><td colspan="5">No saved mappings yet.</td></tr>'}</tbody></table></div><h3>Recent checks</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>File</th><th>Status</th><th>Result</th></tr></thead><tbody>${runs.map(r=>{const c=r.summary.counts || {};return `<tr><td>${time(r.created_at)}</td><td>${esc(r.summary.name || sources.find(s=>s.id===r.source_id)?.config.name || '')}</td><td>${esc(r.status)}</td><td>${r.error?esc(r.error):r.summary.unchanged?'File unchanged':`${c.added || 0} added · ${c.skipped || 0} duplicates · ${c.review || 0} changed rows to review · ${c.unmatched || 0} missing invoices`}${(r.summary.reviews || []).length?`<details><summary>Review changed rows</summary>${r.summary.reviews.map(item=>`<p><b>Row ${item.row} · ${esc(item.identifier)}</b><br>${item.changes.map(change=>`${esc(change.field)}: app ${esc(change.existing)} → file ${esc(change.source)}`).join('<br>')}</p>`).join('')}<p>Existing app records were kept. Correct the source or resolve the app record, then run again. Showing up to 50 changed rows.</p></details>`:''}${(r.summary.warnings || []).map(w=>`<p>Row ${w.row}: ${esc(w.message)}</p>`).join('')}</td></tr>`;}).join('') || '<tr><td colspan="4">No checks yet.</td></tr>'}</tbody></table></div>`,`${!scoped?'<button class="btn primary" id="addAutoSyncMapping">Add file mapping</button>':''}<button class="btn" id="refreshAutoSync">Refresh status</button><button class="btn" data-close-modal>Close</button>`);
  const addMapping=layer.querySelector('#addAutoSyncMapping');if(addMapping)addMapping.onclick=()=>openOneDriveFolder('root',[],'','invoices').catch(error=>showToast(error.message));
  layer.querySelectorAll('[data-approved-sync]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await window.workspaceAPI('/api/sync-sources','POST',{approvedSourceId:button.dataset.approvedSync});await openSyncSources();showToast('Automatic sync enabled for your buyer groups.');}catch(error){button.disabled=false;showToast(error.message);}});
  layer.querySelector('#refreshAutoSync').onclick=()=>openSyncSources().catch(error=>showToast(error.message));
  layer.querySelectorAll('[data-sync-action]').forEach(button=>button.onclick=async()=>{if(saving)return;button.disabled=true;try{await window.workspaceAPI('/api/sync-sources/'+button.dataset.syncId,'POST',{action:button.dataset.syncAction});await openSyncSources();}catch(error){button.disabled=false;showToast(error.message);}});
}
async function watchBulkImport(id,importType='invoices'){
  const layer=modal('Preparing bulk import','The workbook is read in the background. You can close this dialog and resume under Microsoft OneDrive → Bulk imports.',`<p id="bulkJobMarker" data-job="${esc(id)}">Checking progress…</p>`,'<button class="btn" data-close-modal>Close</button><button class="btn" id="cancelBulkImport">Cancel preparation</button>');
  layer.querySelector('#cancelBulkImport').onclick=async()=>{if(saving)return;try{await window.workspaceAPI('/api/import-jobs/'+id,'DELETE',{});await openBulkImports(importType);}catch(error){showToast(error.message);}};
  const active=()=>!layer.classList.contains('hidden') && layer.querySelector('#bulkJobMarker')?.dataset.job===id;
  while(active()){
    const job=await window.workspaceAPI('/api/import-jobs/'+id);if(!active())return;
    if(job.status==='ready'){
      const {definitions}=await window.workspaceAPI('/api/import/definitions');if(!active())return;
      return openImportMapping({jobId:id,fileId:job.file_id,name:job.info.name,sheets:job.info.sheets},definitions,0,importType);
    }
    layer.querySelector('#bulkJobMarker').textContent=job.error || job.info.progress || job.status;
    if(!['queued','processing'].includes(job.status)){layer.querySelector('#cancelBulkImport').disabled=true;return;}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
function suggestImportColumns(fields,headers,type){
  const normalize=value=>String(value).toLowerCase().replace(/[^a-z0-9]/g,'');
  const aliases={id:type==='brandClaims'?['claimreference','claimid']:type==='invoices'?['invoice','invoiceno','invoicenumber','invoiceid','billno']:['document','documentnumber','recordnumber','id','referenceno','documentno','adviceno','debitnoteno','debitnotenumber','returnno'],customer:['customer','customername','partyname','buyername'],date:['returncreatedate','returndate','date','invoicedate','billdate','receiptdate','transactiondate','debitnotedate'],amount:['amount','invoiceamount','netamount','creditamount','totalamount','debitnoteamount'],code:['customercode','code','partycode'],roundOff:['roundoff','rounding'],brandName:['brand','brandname','productbrand','itembrand'],orderNumber:['po','ordernumber','orderno','orderid','ponumber','pono','purchaseordernumber','customerordernumber','customerorderno'],creditDays:['creditdays','creditperiod','paymenttermsdays'],ref:['utr','bankreference','reference','bankref','transactionreference','transactionid','transactionno','transactionnumber'],invoice:['originalinvoice','originalinvoicenumber','invoiceno','invoicenumber','invoiceid','invoice'],type:['type','returntype','advicetype','deductiontype','transactiontype','debitnotetype'],utr:['utr','bankreference','paymentreference'],narration:['narration','description','transactiondescription','remarks','particulars'],bankName:['bank','bankname'],relatedMonth:['relatedmonth','claimmonth','month'],brand:['brand','brandname'],claimType:['claimtype','claimcategory'],receivedDate:['claimreceiveddate','receiveddate','claimdate'],buyerDocument:['buyerdninvoicenumber','buyerdninvoiceno','buyerdnnumber','buyerinvoicenumber','buyerdninvoice'],buyerDNAmount:['buyerdnamount','dnamount'],buyerCNNumber:['buyercnnumberifcancelled','buyercnnumber','buyercnno'],buyerCNAmount:['buyercnamount'],relatedCNDate:['relatedcndate','brandcndate'],relatedCNNumber:['relatedcnnumber','relatedcnno','brandcnnumber'],relatedCNAmount:['relatedcnamount','brandcnamount'],customerCode:['customercode','buyercode','partycode'],creditNoteNumber:['relatedcreditnote','creditnotenumber','creditnoteno','cnnumber','cnno'],creditNoteAmount:['creditnoteamount','cnamount'],description:['description','remarks','narration']};
  const used=new Set(),result={};for(const f of fields){const names=[normalize(f.label),normalize(f.key),...(aliases[f.key] || [])];const index=headers.findIndex((h,i)=>!used.has(i) && names.includes(normalize(h)));if(index>=0){result[f.key]=index;used.add(index);}}return result;
}
function openImportMapping(workbook,definitions,sheetIndex=0,type='invoices',headerRow=1,chosen=null,dateFormat='dmy',invoiceRows='single'){
  if(workbook.sheets[sheetIndex]?.error){sheetIndex=workbook.sheets.findIndex(sheet=>!sheet.error);if(sheetIndex<0)return showToast('No readable worksheet is available.');}
  const sheet=workbook.sheets[sheetIndex];const headers=sheet.rows[headerRow-1] || [];
  const width=Math.max(sheet.columnCount || 0,0,...sheet.rows.map(row=>row.length));const labels=Array.from({length:width},(_,i)=>`${i+1}: ${headers[i] || '(blank header)'}`);
  const fields=definitions[type].fields;const mapping=chosen || suggestImportColumns(fields,headers,type);
  const layer=modal('Map import columns',workbook.name,`<div class="mapping-grid"><label>Worksheet<select id="importSheet">${workbook.sheets.map((s,i)=>`<option value="${i}" ${i===sheetIndex?'selected':''} ${s.error?'disabled':''}>${esc(s.name)}${s.error?' — unavailable':''}</option>`).join('')}</select></label><label>Data type<select id="importType">${Object.entries(definitions).map(([key,d])=>`<option value="${key}" ${key===type?'selected':''}>${esc(d.label)}</option>`).join('')}</select></label><label>Header row<input id="importHeader" type="number" min="1" max="${sheet.maxRow || sheet.rows.length}" value="${headerRow}" /></label><label>Text date format<select id="importDateFormat"><option value="dmy" ${dateFormat==='dmy'?'selected':''}>DD/MM/YYYY</option><option value="mdy" ${dateFormat==='mdy'?'selected':''}>MM/DD/YYYY</option><option value="iso" ${dateFormat==='iso'?'selected':''}>YYYY-MM-DD</option><option value="excel" ${dateFormat==='excel'?'selected':''}>Excel serial numbers</option></select></label></div>${workbook.sheets.some(s=>s.error)?`<p>Unavailable worksheets:</p><ul>${workbook.sheets.filter(s=>s.error).map(s=>`<li><strong>${esc(s.name)}</strong>: ${esc(s.error)}</li>`).join('')}</ul>`:''}${type==='invoices'?`<label>Invoice row layout<select id="invoiceRows"><option value="single" ${invoiceRows==='single'?'selected':''}>One row per invoice</option><option value="brandAmounts" ${invoiceRows==='brandAmounts'?'selected':''}>Separate brand amounts — combine by invoice</option></select></label><p>Choose separate brand amounts only when each row contains that brand’s amount. Amounts are added together; repeated invoice totals must use one row per invoice. Each invoice may have one subtotal per brand, with the same customer, date, order number and round off.</p>`:''}<p>Check the suggested columns. * Required. Excel date cells and YYYY-MM-DD dates are recognized automatically. For prepared workbooks, the table below is a sample of the first 50 rows.</p><div class="mapping-grid">${fields.map(f=>`<label>${esc(f.label)}${f.required?' *':''}<select data-import-field="${f.key}"><option value="">${f.required?'Choose column':'Not mapped'}</option>${labels.map((label,i)=>`<option value="${i}" ${mapping[f.key]===i?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`).join('')}</div><p>${type==='invoices'?'Credit days are managed per customer. Material description is not imported.':type==='customerTerms'?'Existing customer credit days will be updated after confirmation.':type==='brandClaims'?'Claim balances, due dates and statuses are calculated automatically. Add attachments after importing.':'Import invoices first if these rows refer to invoice numbers.'}</p><p>Identical records are skipped. Conflicting identifiers block the import. Unrelated records stay in the workspace.</p><div class="table-wrap" style="max-height:180px"><table><thead><tr>${labels.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${sheet.rows.slice(headerRow,headerRow+3).map(row=>`<tr>${labels.map((_,i)=>`<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,`<button class="btn" data-close-modal>Cancel</button>${workbook.jobId && !['advice','brandClaims'].includes(type) && ['admin','editor'].includes(sharedSession?.user.role) && !Array.isArray(sharedSession?.user.buyerGroupIds)?'<button class="btn" id="enableAutoSync">Enable automatic sync</button>':''}<button class="btn primary" id="previewImport" ${sharedSession?.user.role==='editor' && !['advice','debitNotes','brandClaims'].includes(type)?'disabled title="Use Enable automatic sync for this register"':''}>Preview import</button>`);
  const reload=()=>{const nextHeader=Number(layer.querySelector('#importHeader').value);if(!Number.isInteger(nextHeader)||nextHeader<1||nextHeader>(sheet.maxRow || sheet.rows.length))return showToast('Choose a valid header row.');openImportMapping(workbook,definitions,Number(layer.querySelector('#importSheet').value),layer.querySelector('#importType').value,nextHeader,null,layer.querySelector('#importDateFormat').value,layer.querySelector('#invoiceRows')?.value || 'single');};
  layer.querySelector('#importSheet').onchange=()=>openImportMapping(workbook,definitions,Number(layer.querySelector('#importSheet').value),layer.querySelector('#importType').value,1,null,layer.querySelector('#importDateFormat').value,layer.querySelector('#invoiceRows')?.value || 'single');
  layer.querySelector('#importType').onchange=reload;layer.querySelector('#importHeader').onchange=reload;
  const enableSync=layer.querySelector('#enableAutoSync');if(enableSync)enableSync.onclick=async()=>{
    if(saving)return;enableSync.disabled=true;saving=true;
    try{const selected={};layer.querySelectorAll('[data-import-field]').forEach(select=>{if(select.value!=='')selected[select.dataset.importField]=Number(select.value);});
      await window.workspaceAPI('/api/sync-sources','POST',{jobId:workbook.jobId,sheetKey:sheet.key,type,mapping:selected,startRow:headerRow+1,dateFormat:layer.querySelector('#importDateFormat').value,invoiceRows:layer.querySelector('#invoiceRows')?.value || 'single'});
      await openSyncSources();showToast('Automatic sync enabled. The first check is queued.');
    }catch(error){enableSync.disabled=false;showToast(error.message);}finally{saving=false;}
  };
  layer.querySelector('#previewImport').onclick=async()=>{
    const button=layer.querySelector('#previewImport');button.disabled=true;
    const selected={};layer.querySelectorAll('[data-import-field]').forEach(select=>{if(select.value!=='')selected[select.dataset.importField]=Number(select.value);});
    const format=layer.querySelector('#importDateFormat').value;const layout=layer.querySelector('#invoiceRows')?.value || 'single';
    const back=()=>openImportMapping(workbook,definitions,sheetIndex,type,headerRow,selected,format,layout);
    try{await showImportPreview({type,...(workbook.jobId?{jobId:workbook.jobId,sheetKey:sheet.key}:{rows:sheet.rows.slice(headerRow)}),mapping:selected,startRow:headerRow+1,dateFormat:format,invoiceRows:layout},back);}catch(error){button.disabled=false;showToast(error.message);}
  };
}
async function showImportPreview(input,back){
  const preview=await window.workspaceAPI('/api/import/preview','POST',input);const counts=preview.counts;
  const layer=modal('Review import','Nothing is saved until you confirm.',`<p><strong>${counts.added}</strong> new · <strong>${counts.updated}</strong> credit-day updates · <strong>${counts.skipped}</strong> duplicates skipped · <strong>${counts.invalid}</strong> invalid · ${counts.blank} blank rows ignored${counts.unmatched?` · <strong>${counts.unmatched}</strong> unknown-invoice rows skipped`:""}${counts.combined?` · ${counts.combined} brand rows combined`:""}</p>${preview.warnings?.length?`<p><strong>Warnings — these rows will be skipped; the valid rows can still be imported.</strong> Import the missing invoices and re-import this file later. Existing returns will be skipped as duplicates.</p><ul>${preview.warnings.map(w=>`<li>Row ${w.row}: ${esc(w.message)}</li>`).join('')}</ul>${counts.unmatched>preview.warnings.length?`<p>Showing the first ${preview.warnings.length} of ${counts.unmatched} warnings.</p>`:''}`:''}${preview.errors.length?`<p>Fix these issues in the file or column mapping, then preview again. No rows will be imported while errors remain.</p><ul>${preview.errors.map(e=>`<li>${e.row?`Row ${e.row}: `:''}${esc(e.message)}</li>`).join('')}</ul>`:''}<div class="table-wrap" style="max-height:330px"><table><thead><tr><th>Source row</th><th>Action</th><th>Mapped record (first 12)</th></tr></thead><tbody>${preview.sample.map(row=>`<tr><td>${row.sourceRow}</td><td>${esc(row.outcome)}</td><td>${esc(Object.entries(row.record).map(([k,v])=>`${k}: ${typeof v==='object'?JSON.stringify(v):v}`).join(' · '))}</td></tr>`).join('')}</tbody></table></div>${!preview.canImport&&!counts.invalid?(counts.unmatched?'<p>No valid new records are available to import. Resolve the missing invoices, then preview this file again.</p>':'<p>All records already exist, or this selection contains no new data.</p>'):''}`,`<button class="btn" id="importBack">Back to mapping</button><button class="btn primary" id="confirmImport" ${preview.canImport?'':'disabled'}>Confirm import</button>`);
  layer.querySelector('#importBack').onclick=back;
  layer.querySelector('#confirmImport').onclick=async()=>{
    if(saving)return;const button=layer.querySelector('#confirmImport');button.disabled=true;saving=true;
    try{
      const result=await window.workspaceAPI('/api/import','POST',{...input,revision:preview.revision});
      state=result.state;workspaceRevision=result.revision;savedState=clone(state);sharedSession.state=clone(state);sharedSession.revision=workspaceRevision;
      closeModal(true);render();showToast(`${counts.added} records imported${counts.updated?`; ${counts.updated} credit-day mappings updated`:''}${counts.unmatched?`; ${counts.unmatched} rows skipped because invoices were not found`:''}.`);
    }catch(error){showToast(error.message);if(error.status===409)await showImportPreview(input,back);else button.disabled=false;}
    finally{saving=false;}
  };
}

function openCustomerTerms() {
  modal('Customer credit days', 'Changes apply to every existing and future invoice for the customer.',
    `<div class="mapping-grid">${state.customerTerms.map((term,index)=>`<label>${esc(term.customer)}<input data-term-index="${index}" data-term-customer="${esc(term.customer)}" type="number" min="0" step="1" value="${term.creditDays}" /></label>`).join('')}</div>`,
    `<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveCustomerTerms">Save credit days</button>`);
  document.getElementById('saveCustomerTerms').onclick=async()=>{if(saving)return;try{
    const inputs=[...document.querySelectorAll('[data-term-index]')];
    if(inputs.some(input=>input.value.trim()===''||!Number.isInteger(Number(input.value))||Number(input.value)<0||Number(input.value)>3650)){
      showToast('Enter whole credit days from 0 to 3650 for each customer.');return;
    }
    inputs.forEach(input=>{const term=state.customerTerms.find(t=>customerKey(t.customer)===customerKey(input.dataset.termCustomer || state.customerTerms[Number(input.dataset.termIndex)].customer));if(term)term.creditDays=Number(input.value);});
    await persist();closeModal();render();showToast('Customer credit days saved. All invoice due dates recalculated.');
  }catch(error){showToast(error.message);}};
}

function openOpeningBalances(){
  const rows=allInvoices().filter(row=>row.recordType==='openingBalance' && matchesCustomerScope(row));
  const layer=modal('Customer opening balances','Receivables carried forward from before reconciliation started.',`<p>Record only the unpaid balance at the start of reconciliation. Use one consolidated entry per customer, or separate entries for earlier invoices with different due dates. Do not also import those invoices for the same amount.</p>${invoiceTable(rows)}`,`<button class="btn" data-close-modal>Close</button>${sharedSession?.user.role!=='viewer'?'<button class="btn primary" id="addOpeningBalance">Add opening balance</button>':''}`);
  layer.querySelectorAll('[data-invoice]').forEach(button=>button.addEventListener('click',()=>openInvoice(button.dataset.invoice)));
  if(sharedSession?.user.role!=='viewer')document.getElementById('addOpeningBalance').onclick=()=>openNewOpeningBalance();
}
function openingBalanceRecord(input,id){
  const plain=value=>typeof value==='string' && value.length<=2000 && !/[<>\x00-\x08\x0b-\x1f]/.test(value);
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  const customer=String(input.customer || '').trim(),amount=Number(input.amount),reference=String(input.reference || '').trim(),remarks=String(input.remarks || '').trim();
  if(!customer || ![customer,reference,remarks].every(plain))throw new Error('Enter a customer and use plain text (maximum 2,000 characters per field).');
  if(!Number.isFinite(amount)||amount<0.01||amount>1e12)throw new Error('Enter a positive opening balance of at least Rs 0.01.');
  if(!date(input.date)||!date(input.dueDate))throw new Error('Enter a valid balance date and original due date.');
  if(Array.isArray(sharedSession?.user.buyerGroupIds) && !knownCustomers().some(([key])=>key===customerKey(customer)))throw new Error('Choose a customer from your assigned buyer groups.');
  const canonical=knownCustomers().find(([key])=>key===customerKey(customer));
  return {id,recordType:'openingBalance',customer:canonical?.[1] || customer,date:input.date,openingDueDate:input.dueDate,amount:Math.round(amount*100)/100,openingReference:reference,remarks,code:'—',roundOff:0};
}
function openNewOpeningBalance(existingId){
  if(sharedSession?.user.role==='viewer' || (existingId && sharedSession?.user.role!=='admin'))return;
  const existing=existingId?state.invoices.find(row=>row.id===existingId && row.recordType==='openingBalance'):null;
  if(existingId && !existing)return showToast('This opening balance no longer exists. Refresh and try again.');
  updateCalendar();const id=existing?.id || 'OB-'+crypto.randomUUID();
  modal(existing?'Edit opening balance':'Add customer opening balance',existing?'The OB reference and existing allocations are retained. Changing the customer requires removing linked entries first.':'Enter the unpaid receivable as of the reconciliation start date.',`<div class="mapping-grid"><label>Customer *<input id="openingCustomer" list="openingCustomers" required maxlength="2000" value="${esc(customerScope.customer==='all'?'':knownCustomers().find(([key])=>key===customerScope.customer)?.[1] || '')}" /><datalist id="openingCustomers">${knownCustomers().map(([,name])=>`<option value="${esc(name)}"></option>`).join('')}</datalist></label><label>Opening balance date / reconciliation start *<input id="openingDate" type="date" value="${today}" required /></label><label>Original due date *<input id="openingDueDate" type="date" value="${today}" required /></label><label>Unpaid opening amount *<input id="openingAmount" type="number" min="0.01" step="0.01" required /></label><label>Earlier invoice / reference (optional)<input id="openingReference" maxlength="2000" /></label><label>Remarks (optional)<textarea id="openingRemarks" maxlength="2000"></textarea></label></div><p>The original due date controls Overdue / Due and ageing. Customer credit days are not added again. This balance can be selected in Payment Advice using its OB reference. The existing ₹10 automatic round-off rule applies.</p><p id="openingError" class="form-error" role="alert"></p>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveOpeningBalance">${existing?'Save changes':'Save opening balance'}</button>`);
  if(existing){
    for(const [field,key] of [['Customer','customer'],['Date','date'],['DueDate','openingDueDate'],['Amount','amount'],['Reference','openingReference'],['Remarks','remarks']])document.getElementById('opening'+field).value=existing[key] ?? '';
    document.getElementById('openingCustomer').disabled=['advice','returns','priceReturns','debitNotes'].some(key=>state[key].some(row=>row.invoice===id));
  }
  let previousDate=existing?.date || today;
  document.getElementById('openingDate').onchange=()=>{const date=document.getElementById('openingDate').value;if(document.getElementById('openingDueDate').value===previousDate)document.getElementById('openingDueDate').value=date;previousDate=date;};
  document.getElementById('saveOpeningBalance').onclick=async()=>{
    if(saving)return;
    try{
      const record=openingBalanceRecord({customer:document.getElementById('openingCustomer').value,date:document.getElementById('openingDate').value,dueDate:document.getElementById('openingDueDate').value,amount:document.getElementById('openingAmount').value,reference:document.getElementById('openingReference').value,remarks:document.getElementById('openingRemarks').value},id);
      if(existing){
        if(sharedSession?.user.role!=='admin')throw new Error('Only administrators can edit opening balances.');
        const target=state.invoices.find(row=>row.id===id && row.recordType==='openingBalance');
        if(!target)throw new Error('This opening balance no longer exists. Refresh and try again.');
        const linked=['advice','returns','priceReturns','debitNotes'].some(key=>state[key].some(row=>row.invoice===id));
        if(linked && customerKey(target.customer)!==customerKey(record.customer))throw new Error('Remove linked entries before changing the customer.');
        for(const key of ['customer','date','openingDueDate','amount','openingReference','remarks'])target[key]=record[key];
      }else{
        if(state.invoices.some(row=>row.id===id))throw new Error('This opening balance is already saved. Close this form and refresh.');
        state.invoices.unshift(record);
      }
      initializeCustomerTerms();await persist();closeModal();render();if(existing)openInvoice(id);showToast(existing?'Opening balance updated; allocations retained.':'Opening balance saved. Select its OB reference in Payment Advice to allocate receipts.');
    }catch(error){document.getElementById('openingError').textContent=error.message;}
  };
}
function openNewInvoice(){modal('Add invoice','Create a sales invoice record. Credit days are applied automatically from the customer mapping (45 days for a new customer).',`<div class="mapping-grid"><label>Invoice number<input id="newInvId" placeholder="INV-2026-00XXX" /></label><label>Order number<input id="newInvOrderNumber" placeholder="Order number (optional)" maxlength="2000" /></label><label>Brand name<input id="newInvBrandName" placeholder="Brand name (optional)" maxlength="2000" /></label><label>Customer name<input id="newInvCustomer" list="invoiceCustomers" placeholder="Customer name" /><datalist id="invoiceCustomers">${state.customerTerms.map(t=>`<option value="${esc(t.customer)}"></option>`).join('')}</datalist></label><label>Customer code<input id="newInvCode" placeholder="CUS-001" /></label><label>Invoice date<input id="newInvDate" type="date" value="${today}" /></label><label>Invoice amount<input id="newInvAmount" type="number" placeholder="0" /></label><label>Round off<input id="newInvRoundOff" type="number" step="0.01" value="0" /></label></div>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveInvoice">Save invoice</button>`);document.getElementById('saveInvoice').onclick=async()=>{if(saving)return;try{const id=document.getElementById('newInvId').value.trim(),customer=document.getElementById('newInvCustomer').value.trim(),amount=+document.getElementById('newInvAmount').value,roundOff=+document.getElementById('newInvRoundOff').value;if(!id||!customer||!Number.isFinite(amount)||amount<=0||!Number.isFinite(roundOff)){showToast('Invoice number, customer, positive amount and valid round off are required.');return;}if(state.invoices.some(x=>x.id===id)){showToast('That invoice number already exists.');return;}state.invoices.unshift({id,customer,orderNumber:document.getElementById('newInvOrderNumber').value.trim(),brandName:document.getElementById('newInvBrandName').value.trim(),code:document.getElementById('newInvCode').value||'—',date:document.getElementById('newInvDate').value,amount,roundOff,qty:0,rate:0});initializeCustomerTerms();await persist();closeModal();render();showToast('Invoice saved and added to reconciliation.');}catch(error){showToast(error.message);}}; }
function openRoundOff(id){const invoice=state.invoices.find(x=>x.id===id);if(!invoice)return;const calculated=invoiceData(invoice);modal(`Round off · ${id}`,'Set a manual adjustment. Positive values reduce pending. Remaining balances from ₹-10 to ₹10 are rounded off automatically and recalculated when transactions change.',`<div class="detail-top"><div><small>Current pending</small><b>${fMoney(calculated.pending)}</b></div><div><small>Automatic round off</small><b>${fMoney(calculated.autoRoundOff)}</b></div><div><small>Credit days</small><b>${calculated.creditDays} days</b></div><div><small>Due date</small><b>${dateText(calculated.dueDate)}</b></div></div><div class="mapping-grid" style="margin-top:16px"><label>Manual round off amount<input id="roundOffAmount" type="number" step="0.01" value="${calculated.manualRoundOff}" /></label></div>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveRoundOff">Save round off</button>`);document.getElementById('saveRoundOff').onclick=async()=>{if(saving)return;try{const roundOff=Number(document.getElementById('roundOffAmount').value);if(!Number.isFinite(roundOff)){showToast('Enter a valid round-off value.');return;}const target=state.invoices.find(x=>x.id===id);if(!target)throw new Error('This invoice no longer exists. Close this form and refresh.');target.roundOff=roundOff;await persist();closeModal();render();showToast('Round off saved; pending status recalculated.');}catch(error){showToast(error.message);}};}
function availableBankReceipts(type='Payment'){
  return bankRows().filter(row=>row.referenceCount===1&&String(row.customer || '').trim()&&row.invalidAllocations===0&&(type!=='Payment'||row.pendingToMatch>0));
}

function paymentBuyer(utr){const receipts=state.bank.filter(row=>row.ref===utr);return receipts.length===1?String(receipts[0].customer || '').trim():'';}
function adviceBatchRecords(lines,utr,id){
  updateCalendar();
  if(!Array.isArray(lines)||!lines.length||lines.length>100)throw new Error('Add between 1 and 100 invoice rows.');
  const receipt=bankRows().find(row=>row.ref===utr);
  if(!receipt||receipt.referenceCount!==1||!receipt.customer?.trim()||receipt.invalidAllocations)throw new Error('Choose a unique bank receipt with an identified buyer.');
  const customer=receipt.customer.trim(),invoices=new Map(state.invoices.map(row=>[row.id,row])),seen=new Set();
  const records=lines.map((line,index)=>{
    const label=`Row ${index+1}`,invoice=invoices.get(line.invoice),type=line.type,amount=Number(line.amount),description=String(line.description || '').trim();
    if(!invoice||customerKey(invoice.customer)!==customerKey(customer))throw new Error(`${label}: choose an invoice for the bank receipt buyer.`);
    if(!['Payment','TDS','PPV','PQV','CCOGS','TaxD','EPC'].includes(type))throw new Error(`${label}: choose a valid transaction type.`);
    if(!Number.isFinite(amount)||amount<0.01||amount>1e12)throw new Error(`${label}: enter a positive amount of at least Rs 0.01.`);
    if(!description||description.length>2000)throw new Error(`${label}: enter a transaction description (maximum 2,000 characters).`);
    const key=JSON.stringify([invoice.id,type]);if(seen.has(key))throw new Error(`${label}: this invoice already has a ${type} row. Combine the amounts or choose another type.`);seen.add(key);
    return {id,customer,date:today,invoice:invoice.id,type,description,amount,utr};
  });
  const cash=Math.round(sum(records.filter(row=>row.type==='Payment'),row=>row.amount)*100);
  if(cash>0&&cash>Math.round(receipt.pendingToMatch*100))throw new Error(`The combined Payment amount exceeds the ${fMoney(receipt.pendingToMatch)} remaining on this receipt.`);
  return records;
}
function openAdvice(initialUtr=''){
  const adviceId='PA-'+crypto.randomUUID(),types=['Payment','TDS','PPV','PQV','CCOGS','TaxD','EPC'];let nextUid=1;
  let lines=[{uid:0,invoice:'',type:'Payment',amount:'',description:'',search:''}],invoiceBuyer='',invoiceState=null,buyerInvoices=[];
  const fieldId=(name,line)=>`adv${name}${line.uid?'-'+line.uid:''}`;
  const layer=modal('Add payment advice entry','Allocate one UTR across invoices or opening balances for the same buyer. All rows are saved together.',`<div class="mapping-grid"><label>Bank reference / UTR *<select id="advUtr" required><option value="">Select a bank receipt</option></select></label><label>Buyer<input id="advCustomer" readonly placeholder="Filled from bank receipt" /></label><label>Bank pending to match<input id="advPending" readonly /></label></div><p>Add up to 100 invoice rows below. Payment uses bank cash; EPC, TDS and other deductions are separate.</p><div id="advRows"></div><button class="btn" id="advAddLine" type="button">＋ Add invoice row</button><p id="adviceBatchError" class="form-error" role="alert"></p>`,`<div style="width:100%"><p id="adviceBatchSummary" role="status" style="font-size:11px;margin:0 0 10px"></p><div style="display:flex;justify-content:space-between;gap:10px"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveAdvice">Save all allocations</button></div></div>`);
  layer.classList.add('advice-batch');
  const read=()=>{for(const line of lines)for(const [name,key] of [['Invoice','invoice'],['Type','type'],['Amount','amount'],['Description','description'],['Search','search']])line[key]=document.getElementById(fieldId(name,line)).value;};
  const receipt=()=>bankRows().find(row=>row.ref===document.getElementById('advUtr').value);
  const updateTotals=()=>{
    const bank=receipt(),cash=sum(lines.filter(line=>line.type==='Payment'),line=>Number(line.amount)||0),deductions=sum(lines.filter(line=>line.type!=='Payment'),line=>Number(line.amount)||0),remaining=(Math.round((bank?.pendingToMatch || 0)*100)-Math.round(cash*100))/100;
    document.getElementById('advCustomer').value=bank?.customer || '';document.getElementById('advPending').value=bank?fMoney(bank.pendingToMatch):'';
    document.getElementById('adviceBatchSummary').textContent=`${lines.length} invoice rows · Payment in this entry: ${fMoney(cash)} · Deductions: ${fMoney(deductions)} · Bank pending after saving: ${fMoney(remaining)}`;
    document.getElementById('adviceBatchError').textContent=bank&&cash>0&&remaining<0?'The combined Payment amount exceeds the available bank balance.':bank&&bank.pendingToMatch<0?'This receipt already has excess cash allocations. Review its existing Payment advice.':'';
  };
  const fillInvoices=line=>{
    const buyer=paymentBuyer(document.getElementById('advUtr').value),select=document.getElementById(fieldId('Invoice',line)),search=String(line.search || '').toLowerCase();
    if(invoiceBuyer!==buyer||invoiceState!==state){invoiceBuyer=buyer;invoiceState=state;buyerInvoices=state.invoices.filter(row=>buyer&&customerKey(row.customer)===customerKey(buyer));}
    const matching=buyerInvoices,selected=matching.find(row=>row.id===line.invoice);
    const choices=matching.filter(row=>[row.id,row.openingReference || '',row.recordType==='openingBalance'?'Opening balance':'',row.orderNumber || '',row.brandName || ''].join(' ').toLowerCase().includes(search)).slice(0,100);
    if(selected&&!choices.includes(selected))choices.unshift(selected);
    select.innerHTML='<option value="">Select invoice</option>'+choices.map(row=>`<option value="${esc(row.id)}">${row.recordType==='openingBalance'?'Opening balance · ':''}${esc(row.id)}${row.openingReference?' · '+esc(row.openingReference):''} — ${esc(row.customer)}</option>`).join('');
    select.value=selected?selected.id:'';select.disabled=!buyer;line.invoice=select.value;
  };
  const renderRows=()=>{
    document.getElementById('advRows').innerHTML=lines.map((line,index)=>`<section class="detail-section" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Invoice row ${index+1}</h3><button class="btn" id="advRemove-${line.uid}" type="button" ${lines.length===1?'disabled':''}>Remove row</button></div><div class="mapping-grid"><label>Find invoice<input id="${fieldId('Search',line)}" placeholder="Search invoice, opening balance, order or brand" maxlength="2000" value="${esc(line.search)}" /></label><label>Invoice *<select id="${fieldId('Invoice',line)}" required></select></label><label>Transaction type *<select id="${fieldId('Type',line)}" required>${types.map(type=>`<option value="${type}" ${line.type===type?'selected':''}>${type}</option>`).join('')}</select></label><label>Amount *<input id="${fieldId('Amount',line)}" type="number" min="0.01" step="0.01" required value="${esc(line.amount)}" /></label><label>Transaction description *<input id="${fieldId('Description',line)}" required maxlength="2000" value="${esc(line.description)}" /></label></div><small>Search to find invoices beyond the first 100 matching results.</small></section>`).join('');
    for(const line of lines){
      for(const [name,key] of [['Type','type'],['Amount','amount'],['Description','description'],['Search','search']])document.getElementById(fieldId(name,line)).value=line[key];
      fillInvoices(line);
      document.getElementById(fieldId('Invoice',line)).onchange=()=>{read();updateTotals();};
      document.getElementById(fieldId('Search',line)).oninput=()=>{read();fillInvoices(line);};
      for(const name of ['Amount','Description'])document.getElementById(fieldId(name,line)).oninput=()=>{read();updateTotals();};
      document.getElementById(fieldId('Type',line)).onchange=()=>{read();refreshChoices(false);};
      document.getElementById('advRemove-'+line.uid).onclick=()=>{if(saving||lines.length===1)return;read();lines=lines.filter(row=>row.uid!==line.uid);refreshChoices(false);};
    }
    document.getElementById('advAddLine').disabled=lines.length>=100;updateTotals();
  };
  const refreshChoices=clearInvoices=>{
    const utr=document.getElementById('advUtr'),selected=utr.value,needsCash=lines.some(line=>line.type==='Payment'),receipts=availableBankReceipts(needsCash?'Payment':'EPC');
    utr.innerHTML='<option value="">Select a bank receipt</option>'+receipts.map(row=>`<option value="${esc(row.ref)}">${esc(row.ref)} · ${esc(row.customer)} · Pending ${fMoney(row.pendingToMatch)} of ${fMoney(row.amount)}</option>`).join('');
    utr.value=receipts.some(row=>row.ref===selected)?selected:'';
    if(clearInvoices||!utr.value)for(const line of lines){line.invoice='';line.search='';}
    renderRows();
  };
  document.getElementById('advUtr').onchange=()=>{read();refreshChoices(true);};
  document.getElementById('advAddLine').onclick=()=>{if(saving||lines.length>=100)return;read();const last=lines[lines.length-1];const added={uid:nextUid++,invoice:'',type:last.type,amount:'',description:last.description,search:''};lines.push(added);refreshChoices(false);const field=document.getElementById(fieldId('Search',added));field?.focus?.();field?.scrollIntoView?.({block:'nearest'});};
  document.getElementById('saveAdvice').onclick=async()=>{
    if(saving)return;read();let records;
    try{
      records=adviceBatchRecords(lines,document.getElementById('advUtr').value,adviceId);
      state.advice.unshift(...records);await persist();closeModal();render();showToast(`Payment advice saved with ${records.length} invoice rows.`);
    }catch(error){
      const saved=state.advice.filter(row=>row.id===adviceId);
      const alreadySaved=records&&saved.length===records.length&&records.every(row=>saved.some(existing=>existing.invoice===row.invoice&&existing.type===row.type&&existing.amount===row.amount&&existing.utr===row.utr&&existing.description===row.description&&customerKey(existing.customer)===customerKey(row.customer)));
      if(alreadySaved){closeModal();render();showToast('These allocations are already saved.');return;}
      document.getElementById('adviceBatchError').textContent=error.message;showToast(error.message);updateTotals();document.getElementById('adviceBatchError').textContent=error.message;
    }
  };
  refreshChoices(false);
  if(initialUtr&&availableBankReceipts().some(row=>row.ref===initialUtr)){document.getElementById('advUtr').value=initialUtr;document.getElementById('advUtr').onchange();}
}

function openDebit(existingId){
  if(sharedSession?.user.role==='viewer')return;
  const existing=existingId?state.debitNotes.find(row=>row.id===existingId):null;
  if(existingId && !existing)return showToast('This debit note no longer exists. Refresh and try again.');
  updateCalendar();
  modal(existing?'Edit debit note / credit note':'Add debit note','Invoice adjustment = debit note amount minus credit note amount.',`<div class="mapping-grid"><label>Debit note number *<input id="dnId" required maxlength="2000" /></label><label>Customer name *<select id="dnCustomer" required><option value="">Select customer</option>${knownCustomers().map(([,name])=>`<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></label><label>Customer code *<input id="dnCustomerCode" required maxlength="2000" /></label><label>Date *<input id="dnDate" type="date" required /></label><label>Original invoice *<select id="dnInvoice" required></select></label><label>Amount *<input id="dnAmount" type="number" min="0.01" step="0.01" required /></label><label>Debit note type *<select id="dnType" required><option value="">Select type</option><option>PPV</option><option>PQV</option><option>CCOGS</option><option>TAXD</option><option>EPC</option></select></label><label>Related credit note<input id="dnCreditNote" maxlength="2000" placeholder="CN number" /></label><label>Credit note amount<input id="dnCreditAmount" type="number" min="0" step="0.01" /></label></div><p>Without a CN, the full DN amount adjusts the linked invoice and the DN remains Unsettled. Enter a CN number and amount to mark it Settled and recalculate the difference. Customer, customer code, original invoice and debit note type are mandatory.</p><p>Do not also record this same deduction in Payment Advice.${existing && existing.settlementMode!=='creditNote'?' Saving this legacy audit note activates the new invoice adjustment workflow. Review any earlier deductions first.':''}</p><p id="debitError" class="form-error" role="alert"></p>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveDebit">${existing?'Save changes':'Save debit note'}</button>`);
  for(const [field,value] of [['Id',existing?.id || ''],['Customer',existing?.customer || ''],['CustomerCode',existing?.customerCode || ''],['Date',existing?.date || today],['Amount',existing?.amount ?? ''],['Type',existing?.type==='Unknown'?'':existing?.type || ''],['CreditNote',existing?.creditNoteNumber || ''],['CreditAmount',existing?.creditNoteAmount ?? '']])document.getElementById('dn'+field).value=value;
  document.getElementById('dnId').disabled=!!existing;
  const fillInvoices=(selected=document.getElementById('dnInvoice').value)=>{
    const customer=document.getElementById('dnCustomer').value.trim(),select=document.getElementById('dnInvoice');
    const rows=state.invoices.filter(row=>customer && customerKey(row.customer)===customerKey(customer));select.disabled=!customer;
    select.innerHTML='<option value="">Select an invoice for this customer</option>'+rows.map(row=>`<option value="${esc(row.id)}">${esc(row.id)} — ${esc(row.customer)}</option>`).join('');
    select.value=rows.some(row=>row.id===selected)?selected:'';
  };
  fillInvoices(existing?.invoice || '');
  document.getElementById('dnCustomer').onchange=()=>{fillInvoices('');const customer=document.getElementById('dnCustomer').value,invoice=state.invoices.find(row=>customerKey(row.customer)===customerKey(customer) && row.code && row.code!=='—');document.getElementById('dnCustomerCode').value=invoice?.code || '';};
  document.getElementById('dnInvoice').onchange=()=>{const invoice=state.invoices.find(row=>row.id===document.getElementById('dnInvoice').value);if(invoice){document.getElementById('dnCustomer').value=invoice.customer;document.getElementById('dnCustomerCode').value=invoice.code==='—'?'':invoice.code || '';}};
  document.getElementById('saveDebit').onclick=async()=>{
    if(saving)return;
    try{
      const id=document.getElementById('dnId').value.trim(),customer=document.getElementById('dnCustomer').value.trim(),amount=Number(document.getElementById('dnAmount').value),creditNoteNumber=document.getElementById('dnCreditNote').value.trim(),rawCredit=document.getElementById('dnCreditAmount').value,creditNoteAmount=rawCredit===''?0:Number(rawCredit),date=document.getElementById('dnDate').value,invoice=document.getElementById('dnInvoice').value,customerCode=document.getElementById('dnCustomerCode').value.trim();
      if(!id || !customer || ![id,customer,customerCode,creditNoteNumber].every(value=>value.length<=2000 && !/[<>\x00-\x08\x0b-\x1f]/.test(value)))throw new Error('Debit note number and customer are required. Use plain text, up to 2,000 characters.');
      if(!Number.isFinite(amount)||amount<0.01||amount>1e12 || !Number.isFinite(creditNoteAmount)||creditNoteAmount<0||creditNoteAmount>1e12)throw new Error('Enter a positive DN amount and a valid non-negative CN amount.');
      if(creditNoteNumber && rawCredit==='')throw new Error('Enter the credit note amount (enter 0 for a zero-value CN).');
      if(!creditNoteNumber && creditNoteAmount)throw new Error('Enter the related credit note number for its amount.');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date)throw new Error('Enter a valid debit note date.');
      if(!invoice || !knownCustomers().some(([,name])=>name===customer) || !customerCode || customerCode==='—' || !['PPV','PQV','CCOGS','TAXD','EPC'].includes(document.getElementById('dnType').value))throw new Error('Select a customer, its original invoice and debit note type, and enter the customer code.');
      if(invoice && !state.invoices.some(row=>row.id===invoice && customerKey(row.customer)===customerKey(customer)))throw new Error('Customer must match the selected invoice.');
      const record={id:existing?.id || id,customer,customerCode,date,invoice,amount:Math.round(amount*100)/100,type:document.getElementById('dnType').value,creditNoteNumber,creditNoteAmount:Math.round(creditNoteAmount*100)/100,settlementMode:'creditNote',status:creditNoteNumber?'Settled':'Unsettled'};
      if(existing){const target=state.debitNotes.find(row=>row.id===existingId);if(!target)throw new Error('This debit note no longer exists. Refresh and try again.');Object.assign(target,record);}
      else {if(state.debitNotes.some(row=>row.id===id))throw new Error('That debit note number already exists.');state.debitNotes.unshift(record);}
      await persist();closeModal();render();showToast('Debit note saved; invoice adjustment recalculated.');
    }catch(error){document.getElementById('debitError').textContent=error.message;}
  };
}

function openMap(kind,ref){ const candidate=kind==='map-bank'?state.bank.find(x=>x.ref===ref):kind==='map-advice'?state.advice.find(x=>x.id===ref):state.debitNotes.find(x=>x.id===ref);if(!candidate)return;const lockedBuyer=kind==='map-advice'?paymentBuyer(candidate.utr):kind==='map-bank'?String(candidate.customer || '').trim():'';if(kind==='map-advice'&&!lockedBuyer)return showToast('Assign a buyer to a unique bank receipt before allocating.');const invoiceChoices=state.invoices.filter(row=>!lockedBuyer||customerKey(row.customer)===customerKey(lockedBuyer));const source=kind==='map-bank'?'bank receipt':kind==='map-advice'?'payment advice':'debit note';modal(`Map ${source}`,'Choose the customer and invoice to resolve this transaction.',`<div class="detail-top"><div><small>Reference</small><b>${esc(candidate.ref||candidate.id)}</b></div><div><small>Date</small><b>${dateText(candidate.date)}</b></div><div><small>Amount</small><b>${fMoney(candidate.amount)}</b></div><div><small>Current customer</small><b>${esc(candidate.customer||'Unknown')}</b></div></div><div class="mapping-grid" style="margin-top:16px"><label>Customer<select id="mapCustomer"><option value="">Select customer</option>${[...new Set(invoiceChoices.map(x=>x.customer))].map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label><label>Invoice<select id="mapInvoice"><option value="">Select invoice</option>${invoiceChoices.map(x=>`<option value="${esc(x.id)}">${esc(x.id)} — ${esc(x.customer)}</option>`).join('')}</select></label>${kind==='map-advice'?`<label>Transaction description *<input id="mapDescription" required maxlength="2000" value="${esc(candidate.description || '')}" /></label>`:''}</div>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveMap">Confirm mapping</button>`);document.getElementById('mapInvoice').onchange=e=>{if(e.target.value){const i=state.invoices.find(x=>x.id===e.target.value);document.getElementById('mapCustomer').value=i.customer;}};document.getElementById('saveMap').onclick=async()=>{if(saving)return;try{const invoice=document.getElementById('mapInvoice').value,customer=document.getElementById('mapCustomer').value;const description=kind==='map-advice'?document.getElementById('mapDescription').value.trim():'';if(kind==='map-advice'&&!description){showToast('Transaction description is required.');return;}if(!invoice||!customer){showToast('Select both customer and invoice to complete mapping.');return;}const requiredBuyer=kind==='map-advice'?paymentBuyer(candidate.utr):kind==='map-bank'?paymentBuyer(ref):'';if((lockedBuyer||kind==='map-advice')&&(!requiredBuyer||customerKey(requiredBuyer)!==customerKey(customer))){showToast('The invoice buyer must match the bank receipt buyer.');return;}const selectedInvoice=state.invoices.find(row=>row.id===invoice);if(!selectedInvoice||customerKey(selectedInvoice.customer)!==customerKey(customer)){showToast('Customer must match the selected invoice.');return;}const target=kind==='map-bank'?state.bank.find(x=>x.ref===ref):kind==='map-advice'?state.advice.find(x=>x.id===ref):state.debitNotes.find(x=>x.id===ref);if(!target)throw new Error('This transaction no longer exists. Refresh and try again.');if(kind==='map-bank'){target.customer=customer;target.status='review';target.advice='Manual mapping';}else if(kind==='map-advice'){target.invoice=invoice;target.customer=customer;target.description=description;}else{target.invoice=invoice;target.customer=customer;target.status='Included in adjustment';}await persist();closeModal();render();showToast(`${source[0].toUpperCase()+source.slice(1)} mapped successfully.`);}catch(error){showToast(error.message);}}; }
async function matchEligible(){if(saving)return;try{
  let changed=0;for(const calculated of bankRows()){const receipt=state.bank[calculated.originalIndex];if(receipt.status!==calculated.status || (receipt.advice || '')!==calculated.advice){receipt.status=calculated.status;receipt.advice=calculated.advice;changed++;}}
  if(changed){await persist();render();}
  showToast(changed?`${changed} receipt matching records updated.`:'Receipt allocation totals are already up to date.');
}catch(error){showToast(error.message);}}

async function runSync(){try{await window.refreshWorkspace();showToast('Shared workspace refreshed.');}catch(error){showToast(error.message);}}

function csvEscape(v){const raw=String(v??'');const s=typeof v==='string'&&/^(?:\s*[=+@-]|[\t\r\n])/.test(raw)?"'"+raw:raw;return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;}
function exportReport(kind, customRows){let rows,headers,file;
  const inv=customRows||allInvoices().filter(matchesCustomerScope);
  if(kind==='Customer Outstanding'){rows=customRows&&customRows[0]?.id?customerRows().filter(x=>customRows.some(i=>i.customer===x.customer)):customerRows();headers=['Customer','Code','Invoices','Invoices + Opening Balances','Returns','Payment','TDS','Other Deductions','Credit Days','Overdue','Due','Pending Amount'];rows=rows.map(x=>[x.customer,x.code,x.count,x.invoice,x.returns,x.payment,x.tds,x.ppv+x.pqv+x.ccogs+x.taxd+x.epc+x.otherDebit,customerCreditDays(x.customer),x.overdue,x.due,x.pending]);file='customer-outstanding';}
  else if(kind==='Bank Reconciliation'){headers=['Date','Bank Reference','Customer','Narration','Bank Name','Advice Reference','Credit Amount','Allocated Payment','Pending to Match','Allocation Count','Status'];rows=filteredBankReceipts().map(x=>[x.date,x.ref,x.customer,x.narration,x.bankName,x.advice,x.amount,x.allocatedAmount,x.pendingToMatch,x.allocationCount,x.status]);file='bank-reconciliation';}
  else if(kind==='Debit Note Register'){headers=['Debit Note','Date','Customer','Customer Code','Invoice','Debit Note Type','Amount','Related Credit Note','Credit Note Amount','Invoice Adjustment','Status','Workflow'];rows=state.debitNotes.filter(matchesCustomerScope).map(x=>[x.id,x.date,x.customer,x.customerCode || '',x.invoice,x.type||'Unknown',x.amount,x.creditNoteNumber || '',x.creditNoteAmount || 0,window.ReconcileIQBank.debitNote(x).difference,window.ReconcileIQBank.debitNote(x).status,x.settlementMode==='creditNote'?'DN / CN adjustment':'Legacy audit only']);file='debit-note-register';}
  else if(kind==='Unallocated Transactions'){headers=['Source','Date','Reference','Customer','Type','Amount','Issue'];rows=unallocatedRows().map(row=>[row.source,row.date,row.ref,row.customer,row.type,row.amount,row.issue]);file='unallocated-transactions';}
  else if(kind==='Payment Advice'){headers=['Customer','Invoice','Transaction Type','Transaction Description','Amount','Bank Reference / UTR'];rows=(customRows || state.advice.filter(matchesCustomerScope)).map(x=>[x.customer,x.invoice,x.type,x.description||'',x.amount,x.utr]);file='payment-advice';}
  else if(kind==='Returns'){headers=['Document','Type','Date','Invoice','Amount'];rows=[...state.returns.filter(matchesCustomerScope).map(x=>[x.id,'Qty Return',x.date,x.invoice,x.amount]),...state.priceReturns.filter(matchesCustomerScope).map(x=>[x.id,'Price Return',x.date,x.invoice,x.amount])];file='returns';}
  else if(kind==='Settled Invoices'){headers=['Invoice','Order number','Brand name','Customer','Invoice Date','Invoice Amount','Pending Amount','Status'];rows=allInvoices().filter(matchesCustomerScope).filter(x=>x.status==='settled').map(x=>[x.id,x.orderNumber || '',x.brandName || '',x.customer,x.date,x.amount,x.pending,'Fully settled']);file='settled-invoices';}
  else if(kind==='Ageing'){headers=['Invoice','Order number','Brand name','Customer','Invoice Date','Due Date','Ageing Days','Invoice Amount','Pending Amount','Age Bucket'];rows=allInvoices().filter(matchesCustomerScope).sort((a,b)=>b.ageing-a.ageing).map(x=>[x.id,x.orderNumber || '',x.brandName || '',x.customer,x.date,x.dueDate,x.ageing,x.amount,x.pending,x.ageing<0?'Not yet due':x.ageing>90?'Over 90':x.ageing>60?'61-90':x.ageing>30?'31-60':'0-30']);file='ageing-report';}
  else {headers=['Invoice','Order number','Brand name','Customer','Customer Code','Invoice Date','Credit Days','Due Date','Ageing Days','Invoice Amount','Qty Return','Price Return','Payment','TDS','PPV','PQV','CCOGS','TaxD','EPC','Manual Round Off','Automatic Round Off','Round Off','Pending Amount','Status'];rows=inv.map(x=>[x.id,x.orderNumber || '',x.brandName || '',x.customer,x.code,x.date,x.creditDays,x.dueDate,x.ageing,x.amount,x.qtyReturn,x.priceReturn,x.Payment,x.TDS,x.PPV,x.PQV,x.CCOGS,x.TaxD,x.EPC,x.manualRoundOff,x.autoRoundOff,x.roundOff,x.pending,x.status]);file='invoice-outstanding';}
  if(['Invoice Outstanding','Settled Invoices','Ageing'].includes(kind)){const exported=kind==='Settled Invoices'?allInvoices().filter(matchesCustomerScope).filter(x=>x.status==='settled'):kind==='Ageing'?allInvoices().filter(matchesCustomerScope).sort((a,b)=>b.ageing-a.ageing):inv;headers.push('Receivable Type','Earlier Invoice / Reference');rows=rows.map((row,i)=>[...row,exported[i].recordType==='openingBalance'?'Opening balance':'Invoice',exported[i].openingReference || '']);if(exported.some(row=>row.otherDebit)){headers.push('Unknown');rows=rows.map((row,i)=>[...row,exported[i].otherDebit || 0]);}}
  const csv=[headers,...rows].map(r=>r.map(csvEscape).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${file}-${today}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);showToast(`${kind} report exported.`);
}
document.getElementById('nav').addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)go(btn.dataset.view);});
document.getElementById('mobileMenu').addEventListener('click',()=>document.getElementById('sidebar').classList.toggle('open'));
render();

if (window.location?.search && new URLSearchParams(window.location.search).has('onedrive')) {
  const callback=new URLSearchParams(window.location.search);
  go('settings');
  showToast(callback.get('onedrive') === 'connected' ? 'Microsoft OneDrive connected. Open Manage connection to browse your files.' : (callback.get('message') || 'OneDrive connection failed. Try again.'));
  window.history.replaceState(null,'',window.location.pathname);
}

if (sharedSession) {
  setInterval(()=>window.refreshWorkspace(true).catch(()=>{}),30000);
  window.addEventListener('focus',()=>window.refreshWorkspace(true).catch(()=>{}));
}

function openBankReceipt(){
  modal('Add bank receipt','Record a cleared bank credit before allocating payment advice.',`<div class="mapping-grid"><label>Bank reference / UTR<input id="bankRef" required /></label><label>Receipt date<input id="bankDate" type="date" value="${today}" /></label><label>Customer *<input id="bankCustomer" required /></label><label>Narration<input id="bankNarration" maxlength="2000" /></label><label>Bank name<input id="bankName" maxlength="2000" /></label><label>Credit amount<input id="bankAmount" type="number" min="0.01" step="0.01" /></label></div>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveBank">Save receipt</button>`);
  document.getElementById('saveBank').onclick=async()=>{if(saving)return;try{
    const ref=document.getElementById('bankRef').value.trim(),date=document.getElementById('bankDate').value,amount=Number(document.getElementById('bankAmount').value);
    const customer=document.getElementById('bankCustomer').value.trim();if(!customer)throw new Error('Customer is required.');
    if(!ref||!date||!Number.isFinite(amount)||amount<=0)throw new Error('Reference, date and positive amount are required.');
    if(state.bank.some(row=>row.ref===ref))throw new Error('That bank reference already exists. Review the existing receipt first.');
    state.bank.unshift({ref,date,amount,customer,narration:document.getElementById('bankNarration').value.trim(),bankName:document.getElementById('bankName').value.trim(),status:'unmatched',advice:''});
    await persist();closeModal();render();showToast('Bank receipt saved. It can now be selected in payment advice.');
  }catch(error){showToast(error.message);}};
}
