const {emptyState,validateState}=require('./state');
const collections=['invoices','bank','advice','returns','priceReturns','debitNotes','customerTerms'];
const key=value=>String(value || '').trim().toLowerCase();
const fail=message=>{throw Object.assign(new Error(message),{status:403});};
function buyerGroupIds(user){
  if(user.role==='admin')return null;
  if(user.buyer_group_ids===undefined || user.buyer_group_ids==='null')return null;
  try{const ids=JSON.parse(user.buyer_group_ids);return Array.isArray(ids) && ids.every(id=>typeof id==='string')?ids:[];}catch{return [];}
}
const restricted=user=>buyerGroupIds(user)!==null;
function customerKeys(user,state){const ids=buyerGroupIds(user);return ids===null?null:new Set((state.buyerGroups || []).filter(group=>ids.includes(group.id)).flatMap(group=>group.customers.map(key)));}
function filterState(state,user){
  const keys=customerKeys(user,state);if(keys===null)return state;
  const next=emptyState();for(const collection of collections)next[collection]=(state[collection] || []).filter(row=>keys.has(key(row.customer)));
  const ids=buyerGroupIds(user);next.buyerGroups=(state.buyerGroups || []).filter(group=>ids.includes(group.id));next.logs=[];return next;
}
function validateBuyerGroupIds(value,state,role){
  if(value!==null && (!Array.isArray(value) || value.length>500 || value.some(id=>typeof id!=='string' || !(state.buyerGroups || []).some(group=>group.id===id)) || new Set(value).size!==value.length))throw Object.assign(new Error('Choose valid buyer groups, or all-customer access.'),{status:400});
  return role==='admin'?null:value;
}
function mergeState(before,incoming,user){
  const expected=filterState(before,user),groups=incoming.buyerGroups===undefined?(expected.buyerGroups || []):incoming.buyerGroups;
  if(user.role!=='admin' && JSON.stringify(groups)!==JSON.stringify(expected.buyerGroups || []))fail('Only administrators can change buyer-group membership.');
  const keys=customerKeys(user,before);
  if(keys===null)return validateState({...incoming,buyerGroups:groups});
  const next={...before,buyerGroups:before.buyerGroups || [],logs:before.logs};
  for(const collection of collections){
    const rows=incoming[collection] || [];
    if(rows.some(row=>!keys.has(key(row.customer))))fail('This customer is outside your assigned buyer groups.');
    const outside=(before[collection] || []).filter(row=>!keys.has(key(row.customer)));
    const id=row=>collection==='bank'?row.ref:collection==='customerTerms'?key(row.customer):row.id;
    const ownIds=new Set((expected[collection] || []).map(id)),otherIds=new Set(outside.map(id));
    if(rows.some(row=>otherIds.has(id(row))&&!ownIds.has(id(row))))fail('This record identifier is unavailable.');
    next[collection]=[...outside,...rows];
  }
  return validateState(next);
}
function assertImportScope(state,user,full){
  const keys=customerKeys(user,full);if(keys && collections.some(collection=>(state[collection] || []).some(row=>!keys.has(key(row.customer)))))fail('This import contains customers outside your assigned buyer groups.');
}
function requireSharedFileAccess(user){if(restricted(user))fail('Shared OneDrive files may contain other customers. Use a CSV file from your computer for your assigned buyer groups, or ask an administrator to import the shared file.');}
module.exports={buyerGroupIds,restricted,filterState,mergeState,validateBuyerGroupIds,assertImportScope,requireSharedFileAccess};
