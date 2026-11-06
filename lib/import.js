const {validateState,bankReceiptIndex,allocationBuyerError,validatePaymentCapacity} = require('./state');
const {createHash}=require('node:crypto');
const fail = message => { throw Object.assign(new Error(message),{status:400}); };
// Field metadata drives the mapping form; imported values are validated again on
// the server. Optional unmapped fields do not overwrite existing records.
const field = (key,label,required=false,kind='text') => ({key,label,required,kind});
const common = [field('id','Record number',true),field('customer','Customer name',true),field('date','Date',true,'date'),field('amount','Amount',true,'number'),field('invoice','Invoice number')];
const returnFields=[field('id','Document no.',true),field('type','Type (Qty return / Price return)',true),field('date','Date',true,'date'),field('invoice','Original invoice',true),field('amount','Amount',true,'number')];
const definitions = {
  invoices:{label:'Invoices',fields:[field('id','Invoice number',true),field('orderNumber','Order number'),field('brandName','Brand name'),field('customer','Customer name',true),field('date','Invoice date',true,'date'),field('amount','Invoice amount',true,'number'),field('code','Customer code'),field('roundOff','Round off',false,'number')]},
  customerTerms:{label:'Customer credit days',fields:[field('customer','Customer name',true),field('creditDays','Credit days',true,'number')]},
  bank:{label:'Bank receipts',fields:[field('ref','Bank reference / UTR',true),field('date','Receipt date',true,'date'),field('amount','Credit amount',true,'number'),field('customer','Customer name',true),field('narration','Narration'),field('bankName','Bank name')]},
  returns:{label:'Sales & price returns',fields:returnFields},
  priceReturns:{label:'Price returns',fields:returnFields},
  debitNotes:{label:'Debit notes',fields:[...common,field('type','Type (PPV / PQV / CCOGS / TAXD / EPC)')]},
  advice:{label:'Payment advice',fields:[field('customer','Customer name',true),field('invoice','Invoice number',true),field('type','Transaction type (Payment / TDS / PPV / PQV / CCOGS / TaxD / EPC)',true),field('amount','Amount',true,'number'),field('description','Transaction description',true),field('utr','UTR',true)]},
};
function number(value) {
  if(typeof value === 'number' && Number.isFinite(value)) return value;
  let text=String(value ?? '').trim().replace(/^(?:₹|INR|Rs\.?)\s*/i,'');
  if(/^\(.*\)$/.test(text)) text='-'+text.slice(1,-1);
  if(!/^[+-]?(?:\d+|\d{1,3}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) fail(`Invalid number: ${String(value).slice(0,80)}`);
  const result=Number(text.replace(/,/g,''));if(!Number.isFinite(result)) fail('Number is out of range.');return result;
}
function date(value,format) {
  const text=String(value ?? '').trim();let result;
  if(/^\d{4}-\d{2}-\d{2}$/.test(text)) result=text;
  else if(format==='excel') {
    const serial=number(value);if(!Number.isInteger(serial) || serial<61 || serial>100000)fail('Invalid Excel date serial.');
    result=new Date(Date.UTC(1899,11,30)+serial*86400000).toISOString().slice(0,10);
  } else {
    const match=text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if(!match || !['dmy','mdy'].includes(format)) fail('Use an ISO date (YYYY-MM-DD), or select the correct date format.');
    const day=format==='dmy'?match[1]:match[2],month=format==='dmy'?match[2]:match[1];result=`${match[3]}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
  }
  if(!Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0,10)!==result)fail('Invalid calendar date.');
  return result;
}
function identity(type,row) {
  if(type==='customerTerms')return row.customer.trim().toLowerCase();
  if(type==='bank')return row.ref;
  if(type==='advice')return JSON.stringify([row.id,row.type,row.invoice || '',row.utr]);
  return row.id;
}
const adviceSignature=row=>JSON.stringify([row.customer.trim().toLowerCase(),row.invoice || '',row.type,row.amount,row.description || '',row.utr]);
function prepareImport(input,current,{reviewConflicts=false}={}) {
  if(!input || !Object.hasOwn(definitions,input.type))fail('Choose a supported data type.');
  const {type,rows,mapping}=input;const definition=definitions[type];
  if(!Array.isArray(rows) || !rows.length || rows.length>(input.bulk?200000:5000))fail(input.bulk?'Import up to 200,000 data rows at a time.':'Import 1 to 5,000 data rows at a time.');
  if(!mapping || typeof mapping!=='object' || Array.isArray(mapping))fail('Column mapping is required.');
  if(!Number.isInteger(input.startRow) || input.startRow<1 || input.startRow>1048576)fail('Invalid first data row.');
  const mapped=definition.fields.filter(f=>Number.isInteger(mapping[f.key]) && mapping[f.key]>=0 && mapping[f.key]<100);
  if(new Set(mapped.map(f=>mapping[f.key])).size!==mapped.length)fail('Map each source column to only one field.');
  for(const field of definition.fields)if(field.required && !mapped.includes(field))fail(`Map ${field.label}.`);
  const next=structuredClone(current);const index=new Map();const isReturn=['returns','priceReturns'].includes(type);
  const target=row=>type==='returns' && row.type==='Price return'?'priceReturns':type;
  const keyFor=(collection,row)=>isReturn?JSON.stringify([collection,row.id]):identity(type,row);
  for(const collection of type==='returns'?['returns','priceReturns']:[type])for(const row of next[collection]){const id=keyFor(collection,row);if(index.has(id))fail('Existing records contain duplicate identifiers. Resolve those duplicates before importing.');index.set(id,row);}
  const counts={added:0,skipped:0,updated:0,invalid:0,blank:0,unmatched:0};const errors=[];const warnings=[];const sample=[];const reviews=[];if(reviewConflicts)counts.review=0;
  const sourceKeys=new Map();const invoiceIndex=new Map(current.invoices.map(row=>[row.id,row]));const bankDates=new Map(current.bank.map(row=>[row.ref,row.date]));const existingAdvice=new Map(current.advice.map(row=>[adviceSignature(row),row]));const parsed=[];
  const combine=type==='invoices' && input.invoiceRows==='brandAmounts';
  const receiptIndex=type==='advice'?bankReceiptIndex(current.bank):null;
  if(input.invoiceRows && !['single','brandAmounts'].includes(input.invoiceRows))fail('Choose a valid invoice row layout.');
  if(combine && !mapped.some(f=>f.key==='brandName'))fail('Map Brand name to combine invoice amounts by brand.');
  rows.forEach((values,i)=>{
    try {
      if(!Array.isArray(values) || values.length>100 || values.some(v=>!['string','number'].includes(typeof v) && v!==null))fail('Invalid source row.');
      if(values.every(value=>value===null || String(value).trim()==='')){counts.blank++;return;}
      const row={};
      for(const f of mapped){const value=values[mapping[f.key]];if(value===undefined || value===null || String(value).trim()===''){if(f.required)fail(`${f.label} is required.`);continue;}row[f.key]=f.kind==='number'?number(value):f.kind==='date'?date(value,input.dateFormat):String(value).trim();}
      if(type==='invoices'){row.roundOff??=0;row.code??='—';}
      if(type==='bank')row.status='unmatched';
      if(isReturn){
        const kinds={qty:'Qty return',quantity:'Qty return',qtyreturn:'Qty return',qtyreturns:'Qty return',quantityreturn:'Qty return',quantityreturns:'Qty return',salereturn:'Qty return',salereturns:'Qty return',salesreturn:'Qty return',salesreturns:'Qty return',sales:'Qty return',price:'Price return',pricereturn:'Price return',pricereturns:'Price return'};
        const suppliedType=row.type,kind=suppliedType.toLowerCase().replace(/[^a-z]/g,'');row.type=Object.hasOwn(kinds,kind)?kinds[kind]:undefined;
        if(!row.type)fail(`Unrecognized return type: ${suppliedType.slice(0,80)}. Use Sale return, Qty return or Price return.`);
        if(type==='priceReturns' && row.type!=='Price return')fail('This row is a sales return. Choose Sales & price returns as the import data type.');
        row.customer=invoiceIndex.get(row.invoice)?.customer || '';
      }
      if(type==='debitNotes'){row.status='Unmapped';row.type=(row.type || 'Unknown').toUpperCase();if(row.type==='UNKNOWN')row.type='Unknown';}
      if(type==='advice'){const names={payment:'Payment',tds:'TDS',ppv:'PPV',pqv:'PQV',ccogs:'CCOGS',taxd:'TaxD',epc:'EPC'};const kind=row.type.toLowerCase();row.type=Object.hasOwn(names,kind)?names[kind]:row.type;row.description??='';}
      for(const value of Object.values(row))if(typeof value==='string' && (value.length>2000 || /[<>\x00-\x08\x0b-\x1f]/.test(value)))fail('Use plain text without angle brackets or control characters.');
      for(const f of mapped)if(f.kind==='number' && row[f.key]!==undefined && Math.abs(row[f.key])>1e12)fail(`${f.label} is out of range.`);
      if(row.amount!==undefined && row.amount<0.01)fail('Amount must be positive.');
      if(type==='customerTerms' && (!Number.isInteger(row.creditDays) || row.creditDays<0 || row.creditDays>3650))fail('Credit days must be a whole number from 0 to 3650.');
      if(type==='advice' && !['Payment','TDS','PPV','PQV','CCOGS','TaxD','EPC'].includes(row.type))fail('Invalid payment advice type.');
      if(type==='debitNotes' && !['PPV','PQV','CCOGS','TAXD','EPC','Unknown'].includes(row.type))fail('Invalid debit note type.');
      if(row.invoice){const invoice=invoiceIndex.get(row.invoice);if(!invoice){
        if(isReturn){counts.unmatched++;if(warnings.length<50)warnings.push({row:input.sourceRows?.[i] || input.startRow+i,message:`Document ${row.id}: unknown invoice ${row.invoice}. This row will be skipped. Import its invoice, then import this return again.`});return;}
        fail(`Unknown invoice ${row.invoice}. Import invoices first.`);
      }if(invoice.customer.trim().toLowerCase()!==row.customer.trim().toLowerCase())fail('Customer must match the linked invoice.');}
      if(type==='advice'){
        const buyerError=allocationBuyerError(row,receiptIndex);if(buyerError)fail(buyerError);
        row.id='PA-'+createHash('sha256').update(adviceSignature(row)).digest('hex').slice(0,32);
        row.date=bankDates.get(row.utr) || invoiceIndex.get(row.invoice).date;
      }
      parsed.push({row,sourceRow:input.sourceRows?.[i] || input.startRow+i});
    }catch(error){counts.invalid++;if(errors.length<50)errors.push({row:input.sourceRows?.[i] || input.startRow+i,message:error.message});}
  });
  let records=parsed;
  if(combine){
    const groups=new Map();records=[];counts.combined=0;
    for(const entry of parsed){
      const {row,sourceRow}=entry;
      try{
        if(!row.brandName)fail('Brand name is required for each brand amount.');
        let group=groups.get(row.id);
        if(!group){group={...entry,row:{...row,brandAmounts:[{brandName:row.brandName,amount:row.amount}]}};groups.set(row.id,group);records.push(group);continue;}
        for(const key of ['customer','date','code','orderNumber','roundOff'])if((group.row[key] ?? '')!==(row[key] ?? ''))fail(`Invoice ${row.id} differs in ${key} from row ${group.sourceRow}. Correct the source before combining.`);
        if(group.row.brandAmounts.some(part=>part.brandName.toLowerCase()===row.brandName.toLowerCase()))fail(`Invoice ${row.id} repeats brand ${row.brandName}. Use one subtotal per brand to avoid counting duplicates.`);
        group.row.brandAmounts.push({brandName:row.brandName,amount:row.amount});
        group.row.brandAmounts.sort((a,b)=>a.brandName.localeCompare(b.brandName));
        group.row.amount=Math.round(group.row.brandAmounts.reduce((n,part)=>n+part.amount,0)*100)/100;
        group.row.brandName=group.row.brandAmounts.map(part=>part.brandName).join(' / ');counts.combined++;
      }catch(error){counts.invalid++;if(errors.length<50)errors.push({row:sourceRow,message:error.message});}
    }
  }
  for(const {row,sourceRow} of records){
    try{
      const collection=target(row),key=keyFor(collection,row);const existing=index.get(key) || (type==='advice'?existingAdvice.get(adviceSignature(row)):undefined);
      const signature=JSON.stringify(type==='customerTerms'?{...row,customer:key}:row);if(sourceKeys.has(key) && sourceKeys.get(key)!==signature)fail('This identifier occurs more than once in the source with different values.'+(type==='invoices'?' If these are separate brand subtotals, choose Separate brand amounts in Invoice row layout.':''));sourceKeys.set(key,signature);
      let outcome='Add';
      if(existing){
        if(type==='invoices' && existing.recordType==='openingBalance')fail('This identifier belongs to an opening balance. Use a different invoice number to avoid double counting.');
        const equal=mapped.every(f=>{
          if(!Object.hasOwn(row,f.key))return true;
          if(isReturn && f.key==='type')return (existing.type || (collection==='returns'?'Qty return':'Price return'))===row.type;
          if(type==='customerTerms' && f.key==='customer')return existing.customer.trim().toLowerCase()===row.customer.toLowerCase();
          return (existing[f.key] ?? '')===row[f.key];
        });
        const sameBrands=!combine || JSON.stringify(existing.brandAmounts)===JSON.stringify(row.brandAmounts);
        if(equal && sameBrands){counts.skipped++;outcome='Skip duplicate';}
        else if(reviewConflicts){counts.review++;outcome='Review existing record';if(reviews.length<50)reviews.push({row:sourceRow,identifier:row.ref || row.id || row.customer,changes:mapped.filter(f=>Object.hasOwn(row,f.key) && (existing[f.key] ?? '')!==row[f.key]).map(f=>({field:f.label,existing:existing[f.key] ?? '',source:row[f.key]}))});}
        else if(type==='customerTerms'){existing.creditDays=row.creditDays;counts.updated++;outcome='Update credit days';}
        else fail('This identifier already exists with different values. Correct the source or existing record before importing.');
      } else {next[collection].push(row);index.set(key,row);counts.added++;}
      if(sample.length<12)sample.push({sourceRow,outcome,record:row});
    }catch(error){counts.invalid++;if(errors.length<50)errors.push({row:sourceRow,message:error.message});}
  }
  let state;
  if(!counts.invalid){try{state=validateState(next);validatePaymentCapacity(state,current);}catch(error){state=undefined;counts.invalid++;errors.push({row:null,message:error.message});}}
  return {state,counts,errors,warnings,sample,...(reviewConflicts?{reviews}:{}),canImport:!counts.invalid && counts.added+counts.updated>0};
}
module.exports={definitions,prepareImport};
