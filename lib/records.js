const {validateState}=require('./state');
const collections=['invoices','bank','debitNotes','advice','returns','priceReturns','brandClaims','vendorSales','vendorRTV'];
const labels={invoices:'invoice',bank:'bank receipt',debitNotes:'debit note',advice:'payment advice',returns:'sales return',priceReturns:'price return',brandClaims:'brand claim',vendorSales:'vendor sale',vendorRTV:'Urban RTV'};
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const identifier=(collection,row)=>collection==='bank'?row.ref:row.id;
function requireAdminForRemovals(before,after,role){
  if(role==='admin')return;
  for(const collection of collections){
    const counts=new Map();for(const row of after[collection] || []){const key=identifier(collection,row);counts.set(key,(counts.get(key)||0)+1);}
    for(const row of before[collection] || []){const key=identifier(collection,row),count=counts.get(key)||0;if(!count)fail(403,'Only administrators can delete financial entries.');counts.set(key,count-1);}
  }
}
function requireAdminForOpeningEdits(before,after,role){
  if(role==='admin')return;
  const previous=new Map(before.invoices.map(row=>[row.id,row]));
  // Comments remain available to editors; financial opening-balance fields
  // can only be changed by an administrator. New entries remain permitted.
  const signature=row=>JSON.stringify(Object.keys(row).filter(key=>key!=='remarks').sort().map(key=>[key,row[key]]));
  for(const row of after.invoices){
    const old=previous.get(row.id);
    if(old && (old.recordType==='openingBalance' || row.recordType==='openingBalance') && signature(old)!==signature(row))fail(403,'Only administrators can edit an existing opening balance.');
  }
}
function requireVendorSourceUnchanged(before,after){
  for(const collection of ['vendorSales','vendorRTV']){
    const old=new Map((before[collection] || []).map(row=>[row.id,row]));
    for(const row of after[collection] || [])if(!old.has(row.id) || ['vendor','date','number','amount'].some(key=>row[key]!==old.get(row.id)[key]))fail(403,'Vendor source fields must be imported or synchronized from Excel. Only GRN/CN details can be entered here.');
  }
}
function deleteRecord(state,input){
  const {collection,index}=input;
  if(!collections.includes(collection))fail(400,'Choose a supported record type.');
  if(!Number.isInteger(index)||index<0)fail(400,'Choose a valid entry.');
  const row=(state[collection] || [])[index];if(!row)fail(404,'This entry no longer exists. Refresh and review the register.');
  if(typeof input.identifier!=='string'||input.identifier!==identifier(collection,row))fail(409,'This entry changed. Refresh and review it before deleting.');
  if(collection==='invoices'){
    const linked=[['advice','payment advice'],['returns','sales returns'],['priceReturns','price returns'],['debitNotes','debit notes']].map(([key,label])=>({label,count:state[key].filter(entry=>entry.invoice===row.id).length})).filter(entry=>entry.count);
    if(linked.length)fail(409,'Remove the linked entries before deleting this invoice: '+linked.map(entry=>`${entry.count} ${entry.label}`).join(', ')+'.');
  }
  if(collection==='bank' && state.advice.some(entry=>entry.utr===row.ref))fail(409,'Remove the payment advice linked to this bank reference before deleting the receipt.');
  const next=structuredClone(state);next[collection].splice(index,1);let receiptsReopened=0;
  if(collection==='advice' && row.type==='Payment')for(const receipt of next.bank)if(receipt.ref===row.utr){receipt.status='unmatched';receipt.advice='';receiptsReopened++;}
  return {state:validateState(next),deleted:{collection,identifier:identifier(collection,row),label:labels[collection],invoice:row.invoice || '',type:row.type || '',amount:row.amount,receiptsReopened}};
}
module.exports={requireAdminForRemovals,requireAdminForOpeningEdits,requireVendorSourceUnchanged,deleteRecord};
