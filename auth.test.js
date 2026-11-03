const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
async function screen(hash='',overrideFetch){
  const elements=new Map(),calls=[];let markup='';const classes=new Set();
  const element=()=>({value:'',disabled:false,textContent:'',classList:{add(){},remove(){}}});
  const layer={hidden:false,set innerHTML(value){markup=value;for(const key of [...elements.keys()])if(!['authLayer','logoutButton'].includes(key))elements.delete(key);for(const match of value.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)){const node=element();const valueMatch=match[0].match(/\bvalue="([^"]*)"/);node.value=valueMatch?.[1] || '';elements.set(match[1],node);}},get innerHTML(){return markup;}};
  elements.set('authLayer',layer);elements.set('logoutButton',element());
  const location={hash,pathname:'/',search:'',reload(){}};const history={replaceState(){location.hash='';}};
  const context={console,URLSearchParams,Blob,location,history,setTimeout,document:{getElementById:id=>elements.get(id)||null,body:{classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)}}},window:{},fetch:async(route,options)=>{
    if(overrideFetch){const result=overrideFetch(route,options);if(result)return result;}
    calls.push({route,options});if(route==='/api/session')return {ok:false,status:401,json:async()=>({error:'Please sign in.'})};
    if(route==='/api/password-reset/request')return {ok:true,status:202,json:async()=>({message:'If this email belongs to an active account, ask an administrator for a reset link.'})};
    if(route==='/api/password-reset/complete')return {ok:true,status:200,json:async()=>({ok:true})};throw Error('Unexpected route '+route);
  }};
  vm.runInNewContext(fs.readFileSync('auth.js','utf8'),context);await new Promise(setImmediate);
  return {elements,calls,location,html:()=>markup};
}
test('sign-in forgot-password control submits a real request and explains administrator delivery',async()=>{
  const page=await screen();assert.ok(page.html().includes('Forgot password?'));page.elements.get('loginEmail').value='person@example.com';page.elements.get('forgotPassword').onclick();
  assert.ok(page.html().includes('does not send reset emails automatically'));assert.equal(page.elements.get('forgotEmail').value,'person@example.com');
  await page.elements.get('forgotForm').onsubmit({preventDefault(){},submitter:{disabled:false}});
  assert.equal(page.calls.at(-1).route,'/api/password-reset/request');assert.equal(JSON.parse(page.calls.at(-1).options.body).email,'person@example.com');assert.ok(page.html().includes('Request submitted'));
});
test('reset-link fragment is removed before requests and mismatched passwords stay local',async()=>{
  const token='a'.repeat(43),page=await screen('#reset='+token);assert.equal(page.location.hash,'');assert.equal(page.calls.length,0);assert.ok(page.html().includes('Reset your password'));
  page.elements.get('resetNewPassword').value='New-password-2026';page.elements.get('resetConfirmPassword').value='Different-password-2026';
  await page.elements.get('resetLinkForm').onsubmit({preventDefault(){},submitter:{disabled:false}});assert.equal(page.calls.length,0);assert.equal(page.elements.get('resetLinkError').textContent,'New passwords do not match.');
  page.elements.get('resetConfirmPassword').value='New-password-2026';await page.elements.get('resetLinkForm').onsubmit({preventDefault(){},submitter:{disabled:false}});
  assert.equal(page.calls[0].route,'/api/password-reset/complete');assert.equal(JSON.parse(page.calls[0].options.body).token,token);assert.ok(!page.calls[0].route.includes(token));assert.ok(page.html().includes('Password reset. Sign in with your new password.'));
});
test('HTML gateway errors and invalid successful responses show useful errors instead of JSON parser failures',async()=>{
  const page=await screen('',route=>route==='/api/password-reset/request'?{ok:false,status:429,json:async()=>{throw new SyntaxError('Unexpected token <');}}:null);
  page.elements.get('forgotPassword').onclick();page.elements.get('forgotEmail').value='person@example.com';await page.elements.get('forgotForm').onsubmit({preventDefault(){},submitter:{disabled:false}});assert.equal(page.elements.get('forgotError').textContent,'Too many requests. Wait a moment and try again.');
  const invalid=await screen('',route=>route==='/api/password-reset/request'?{ok:true,status:200,json:async()=>null}:null);invalid.elements.get('forgotPassword').onclick();invalid.elements.get('forgotEmail').value='person@example.com';await invalid.elements.get('forgotForm').onsubmit({preventDefault(){},submitter:{disabled:false}});assert.match(invalid.elements.get('forgotError').textContent,/unreadable response/);
});
