/* Shared cash-allocation calculation used by the browser and server. */
(function(root){
  const buyer=value=>String(value || '').trim().toLowerCase();
  const cents=value=>Math.round(Number(value || 0)*100);
  function rows(state){
    const invoices=new Map(state.invoices.map(row=>[row.id,row]));const counts=new Map(),payments=new Map();
    for(const receipt of state.bank)counts.set(receipt.ref,(counts.get(receipt.ref)||0)+1);
    for(const row of state.advice)if(row.type==='Payment'){if(!payments.has(row.utr))payments.set(row.utr,[]);payments.get(row.utr).push(row);}
    return state.bank.map((receipt,originalIndex)=>{
      const candidates=payments.get(receipt.ref)||[],referenceCount=counts.get(receipt.ref),customer=buyer(receipt.customer);
      if(referenceCount!==1)return {...receipt,originalIndex,status:'review',advice:'',allocatedAmount:0,pendingToMatch:cents(receipt.amount)/100,allocationCount:0,referenceCount,invalidAllocations:candidates.length};
      const valid=candidates.filter(row=>{const invoice=invoices.get(row.invoice);return invoice&&customer&&buyer(row.customer)===customer&&buyer(invoice.customer)===customer;});
      const validSet=new Set(valid),invalidAllocations=candidates.filter(row=>row.invoice&&!validSet.has(row)).length;
      const allocatedCents=referenceCount===1?cents(valid.reduce((total,row)=>total+Number(row.amount),0)):0;
      const pendingCents=cents(receipt.amount)-allocatedCents;
      const blocked=referenceCount!==1||invalidAllocations>0;
      const status=!blocked&&customer&&valid.length&&pendingCents===0?'matched':blocked||allocatedCents>0||receipt.status==='review'?'review':'unmatched';
      const ids=[...new Set(valid.map(row=>row.id))],references=ids.join(', ');
      return {...receipt,originalIndex,status,advice:references.length<=1800?references:`${ids.length} payment allocations`,allocatedAmount:allocatedCents/100,pendingToMatch:pendingCents/100,allocationCount:valid.length,referenceCount,invalidAllocations};
    });
  }
  function synchronize(state){for(const row of rows(state)){state.bank[row.originalIndex].status=row.status;if(row.advice || Object.hasOwn(state.bank[row.originalIndex],'advice'))state.bank[row.originalIndex].advice=row.advice;}return state;}
  const api={rows,synchronize};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ReconcileIQBank=api;
})(typeof window==='undefined'?globalThis:window);
