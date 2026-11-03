const collections = ['invoices', 'returns', 'priceReturns', 'advice', 'bank', 'debitNotes', 'logs', 'customerTerms'];
const emptyState = () => Object.fromEntries(collections.map(name => [name, []]));
const customerKey = name => String(name).trim().toLowerCase();
function invalid(message) { const error = new Error(message); error.status = 400; throw error; }

function validateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Workspace data must be an object.');
  const state = emptyState();
  for (const name of collections) {
    if (name === 'customerTerms' && input[name] === undefined) continue;
    if (!Array.isArray(input[name]) || input[name].length > 200000) invalid(`Invalid ${name} collection (maximum 200,000 records).`);
    state[name] = JSON.parse(JSON.stringify(input[name]));
    for (const row of state[name]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid(`Invalid ${name} record.`);
      for (const [key,value] of Object.entries(row)) {
        if(name==='invoices' && key==='brandAmounts')continue;
        // Legacy templates render some fields as HTML: only accept plain text.
        if (typeof value === 'string' && (value.length > 2000 || /[<>\x00-\x08\x0b-\x1f]/.test(value))) invalid(`Invalid text in ${name}. Use plain text without angle brackets.`);
        if (typeof value === 'object' || typeof value === 'boolean' || typeof value === 'number' && !Number.isFinite(value)) invalid(`Invalid value in ${name}.`);
      }
    }
  }
  const text = (row, field, required = true) => {
    if ((required || row[field] !== undefined) && (typeof row[field] !== 'string' || required && !row[field].trim())) invalid(`A valid ${field} is required.`);
  };
  const number = (row, field, min = 0, required = true) => {
    if ((required || row[field] !== undefined) && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < min || Math.abs(row[field]) > 1e12)) invalid(`Invalid ${field}.`);
  };
  const date = row => {
    text(row, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date) invalid('Invalid transaction date.');
  };
  const unique = (rows, field, normalize = x => x) => {
    const values = rows.map(row => normalize(row[field]));
    if (new Set(values).size !== values.length) invalid(`Duplicate ${field}.`);
  };
  for (const row of state.invoices) {
    text(row, 'id'); text(row, 'customer'); text(row, 'orderNumber', false); text(row, 'brandName', false); date(row); number(row, 'amount', 0.01);
    number(row, 'roundOff', -1e12, false);
    if(row.brandAmounts!==undefined){
      if(!Array.isArray(row.brandAmounts) || !row.brandAmounts.length || row.brandAmounts.length>100)invalid('Invalid invoice brand amounts.');
      for(const part of row.brandAmounts){
        if(!part || typeof part!=='object' || Array.isArray(part) || Object.keys(part).some(key=>!['brandName','amount'].includes(key)))invalid('Invalid invoice brand amount.');
        text(part,'brandName');number(part,'amount',0.01);
        if(part.brandName.length>2000 || /[<>\x00-\x08\x0b-\x1f]/.test(part.brandName))invalid('Invalid invoice brand name.');
      }
      unique(row.brandAmounts,'brandName',customerKey);
      if(Math.abs(row.brandAmounts.reduce((n,p)=>n+p.amount,0)-row.amount)>0.005)invalid('Brand amounts must equal the invoice amount.');
      if(row.brandName!==row.brandAmounts.map(p=>p.brandName).join(' / '))invalid('Brand names must match the invoice brand amounts.');
    }
    for (const field of ['qty', 'rate', 'gst']) number(row, field, 0, false);
    row.code = row.code || '—';
    if (row.roundOff === undefined) row.roundOff = 0;
  }
  unique(state.invoices, 'id');
  const invoices = new Map(state.invoices.map(row => [row.id, row]));
  for (const name of ['returns', 'priceReturns', 'advice', 'debitNotes']) {
    for (const row of state[name]) {
      text(row, 'id'); text(row, 'customer'); text(row, 'invoice', false); date(row); number(row, 'amount', 0.01);
      if (row.invoice && !invoices.has(row.invoice)) invalid(`Unknown invoice ${row.invoice}.`);
      if (row.invoice && customerKey(invoices.get(row.invoice).customer) !== customerKey(row.customer)) invalid('Customer must match the selected invoice.');
      if(['returns','priceReturns'].includes(name) && row.type!==undefined && row.type!==(name==='returns'?'Qty return':'Price return'))invalid('Invalid return type.');
      if (name === 'advice') {
        if (!['Payment', 'TDS', 'PPV', 'PQV', 'CCOGS', 'TaxD'].includes(row.type)) invalid('Invalid payment advice type.');
        text(row, 'utr');text(row,'description',false); row.description = row.description || '';
      }
      if (name === 'debitNotes') {
        row.type = row.type || 'Unknown';
        if (!['PPV', 'PQV', 'CCOGS', 'TAXD', 'EPC', 'Unknown'].includes(row.type)) invalid('Invalid debit note type.');
        text(row, 'status');
      }
    }
    if (name !== 'advice') unique(state[name], 'id');
    else {
      const keys=state.advice.map(row=>JSON.stringify([row.id,row.type,row.invoice || '',row.utr]));
      if(new Set(keys).size!==keys.length)invalid('Duplicate payment advice allocation. Each advice number, type, invoice and UTR combination must be unique.');
    }
  }
  for (const row of state.bank) {
    text(row, 'ref'); date(row); number(row, 'amount', 0.01);
    text(row,'customer',false);text(row,'narration',false);text(row,'bankName',false);
    if (!['matched', 'review', 'unmatched'].includes(row.status)) invalid('Invalid bank receipt status.');
  }
  for (const term of state.customerTerms) {
    text(term, 'customer'); number(term, 'creditDays');
    if (!Number.isInteger(term.creditDays) || term.creditDays > 3650) invalid('Credit days must be a whole number from 0 to 3650.');
  }
  unique(state.customerTerms, 'customer', customerKey);
  const termKeys=new Set(state.customerTerms.map(term=>customerKey(term.customer)));
  for (const invoice of state.invoices) {
    if (!termKeys.has(customerKey(invoice.customer))) {
      const days = invoice.creditDays;
      state.customerTerms.push({ customer: invoice.customer, creditDays: Number.isInteger(days) && days >= 0 && days <= 3650 ? days : 45 });
      termKeys.add(customerKey(invoice.customer));
    }
    delete invoice.creditDays;
  }
  return state;
}
// Keep unchanged legacy receipts readable; every new or edited receipt needs a customer.
function validateBankCustomers(next,previous){
  const signature=row=>JSON.stringify(Object.keys(row).sort().map(key=>[key,row[key]]));
  const legacy=new Map();
  for(const row of previous.bank)if(!row.customer?.trim()){const key=signature(row);legacy.set(key,(legacy.get(key)||0)+1);}
  for(const row of next.bank)if(!row.customer?.trim()){
    const key=signature(row),count=legacy.get(key)||0;
    if(!count)invalid(`Customer is required for bank receipt ${row.ref}.`);
    legacy.set(key,count-1);
  }
}
function validateAdviceFields(next,previous){
  const missing=row=>!row.invoice?.trim() || !row.description?.trim();
  const signature=row=>{const normalized={...row,description:row.description||''};return JSON.stringify(Object.keys(normalized).sort().map(key=>[key,normalized[key]]));};
  const legacy=new Map();
  for(const row of previous.advice)if(missing(row)){const key=signature(row);legacy.set(key,(legacy.get(key)||0)+1);}
  for(const row of next.advice)if(missing(row)){
    const key=signature(row),count=legacy.get(key)||0;
    if(!count)invalid('Invoice and transaction description are required for payment advice.');
    legacy.set(key,count-1);
  }
  const before=bankReceiptIndex(previous.bank),after=bankReceiptIndex(next.bank);
  const rowKey=row=>{const value={...row,description:row.description||''};return JSON.stringify(Object.keys(value).sort().map(key=>[key,value[key]]));};
  const unchanged=new Set(previous.advice.map(rowKey));
  const buyerKey=(index,utr)=>JSON.stringify((index.get(utr)||[]).map(row=>customerKey(row.customer||'')));
  for(const row of next.advice){
    if(unchanged.has(rowKey(row)) && buyerKey(before,row.utr)===buyerKey(after,row.utr))continue;
    const message=allocationBuyerError(row,after);if(message)invalid(message);
  }
}
function bankReceiptIndex(rows){
  const index=new Map();for(const row of rows){if(!index.has(row.ref))index.set(row.ref,[]);index.get(row.ref).push(row);}return index;
}
function allocationBuyerError(row,index){
  const receipts=index.get(row.utr)||[];
  if(!receipts.length)return `Unknown bank receipt ${row.utr}. Import the bank receipt and assign its buyer before allocating.`;
  if(receipts.length!==1)return `Bank reference ${row.utr} occurs more than once. Resolve the duplicate receipts before allocating.`;
  const buyer=receipts[0].customer;
  if(!buyer?.trim())return `Assign a buyer to bank receipt ${row.utr} before allocating it.`;
  if(customerKey(buyer)!==customerKey(row.customer))return `Bank receipt ${row.utr} is tagged to ${buyer}. Payment advice and invoice must use the same buyer.`;
  return '';
}
function validateReturnFields(next,previous){
  const signature=row=>JSON.stringify(Object.keys(row).sort().map(key=>[key,row[key]]));
  for(const collection of ['returns','priceReturns']){
    const legacy=new Map();
    const missing=row=>!row.invoice?.trim() || !row.type;
    for(const row of previous[collection])if(missing(row)){const key=signature(row);legacy.set(key,(legacy.get(key)||0)+1);}
    for(const row of next[collection])if(missing(row)){
      const key=signature(row),count=legacy.get(key)||0;
      if(!count)invalid('Document no., type, date, original invoice and positive amount are required for returns.');
      legacy.set(key,count-1);
    }
  }
}
module.exports = { emptyState, validateState, validateBankCustomers, validateAdviceFields, validateReturnFields, bankReceiptIndex, allocationBuyerError };
