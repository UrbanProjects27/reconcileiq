/* Account/session UI. Financial data is fetched only after authentication. */
(() => {
  const layer = document.getElementById('authLayer');
  let session;
  let appLoaded = false;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const errorText = (id, error) => { const element=document.getElementById(id);if(element)element.textContent = error.message; };
  async function api(route, method = 'GET', data) {
    let payload=data===undefined?undefined:JSON.stringify(data);
    if(payload && new Blob([payload]).size>256*1024 && typeof CompressionStream!=='undefined'){
      const bytes=new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());let binary='';
      for(let offset=0;offset<bytes.length;offset+=16384)binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
      // Keep transport ASCII JSON: some hosting gateways transform binary
      // Content-Encoding bodies before handing them to a native function.
      payload=JSON.stringify({__reconcileiqGzip:btoa(binary)});
    }
    const response = await fetch(route, {
      method, credentials:'same-origin', cache:'no-store',
      headers: {'Content-Type':'application/json', ...(session ? {'X-CSRF-Token':session.csrf} : {})},
      ...(payload === undefined ? {} : {body:payload}),
    });
    let result;try{result=await response.json();}catch{
      if(response.ok)throw new Error('The server returned an unreadable response. Refresh and try again.');
      result={error:response.status===429?'Too many requests. Wait a moment and try again.':'The server could not complete this request. Please try again.'};
    }
    if (!response.ok) {
      if (response.status === 401 && route !== '/api/login') showLogin('Your session ended. Sign in to continue.');
      const error = new Error(result?.error || 'Request failed.'); error.status = response.status; throw error;
    }
    if(!result || typeof result!=='object' || Array.isArray(result))throw new Error('The server returned an unreadable response. Refresh and try again.');
    return result;
  }
  window.workspaceAPI = api;
  function showAuth(content) {
    document.body.classList.add('signed-out'); layer.hidden = false;
    layer.innerHTML = `<div class="auth-card"><div class="auth-brand">reconcile<span>IQ</span></div>${content}</div>`;
  }
  function showLogin(message = '',email='') {
    showAuth(`<h1>Sign in to your workspace</h1><p>Work together on invoices, collections and reconciliation.</p>
      <form id="loginForm" class="account-form"><label>Email<input id="loginEmail" type="email" autocomplete="username" value="${escape(email)}" required /></label>
      <label>Password<input id="loginPassword" type="password" autocomplete="current-password" required maxlength="128" /></label>
      <p id="loginError" class="form-error" role="alert">${escape(message)}</p><button class="btn primary" type="submit">Sign in</button></form>
      <p class="auth-help"><button class="btn" type="button" id="forgotPassword">Forgot password?</button></p><p class="auth-help">Contact your finance administrator for a new account.</p>`);
    document.getElementById('forgotPassword').onclick=()=>showForgotPassword(document.getElementById('loginEmail').value);
    document.getElementById('loginForm').onsubmit = async event => {
      event.preventDefault(); const button = event.submitter; button.disabled = true;
      try {
        session = await api('/api/login','POST',{email:document.getElementById('loginEmail').value,password:document.getElementById('loginPassword').value});
        if (appLoaded) return location.reload();
        await openWorkspace();
      } catch(error) { errorText('loginError',error); }
      finally { button.disabled = false; }
    };
  }
  function showForgotPassword(email=''){
    showAuth(`<h1>Forgot password?</h1><p>Request a reset from your workspace administrators. An administrator must verify your identity and share a reset link with you. This app does not send reset emails automatically.</p><form id="forgotForm" class="account-form"><label>Account email<input id="forgotEmail" type="email" autocomplete="username" value="${escape(email)}" required maxlength="254" /></label><p id="forgotError" class="form-error" role="alert"></p><button class="btn primary" type="submit">Request password reset</button></form><button class="btn" id="forgotBack">Back to sign in</button>`);
    document.getElementById('forgotBack').onclick=()=>showLogin('',document.getElementById('forgotEmail').value);
    const form=document.getElementById('forgotForm');
    form.onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;const address=document.getElementById('forgotEmail').value;
      try{
        const result=await api('/api/password-reset/request','POST',{email:address});if(document.getElementById('forgotForm')!==form)return;
        showAuth(`<h1>Request submitted</h1><p>${escape(result.message)}</p><button class="btn primary" id="resetRequestedBack">Back to sign in</button>`);
        document.getElementById('resetRequestedBack').onclick=()=>showLogin('',address);
      }catch(error){errorText('forgotError',error);}finally{button.disabled=false;}
    };
  }
  function showResetLinkForm(token){
    showAuth(`<h1>Reset your password</h1><p>Choose a password of 12–128 characters. This link works once and expires after 30 minutes.</p><form id="resetLinkForm" class="account-form"><label>New password<input id="resetNewPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><label>Confirm new password<input id="resetConfirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><p id="resetLinkError" class="form-error" role="alert"></p><button class="btn primary" type="submit">Reset password</button></form><button class="btn" id="resetLinkBack">Request a new link</button>`);
    document.getElementById('resetLinkBack').onclick=()=>showForgotPassword();
    document.getElementById('resetLinkForm').onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;
      try{
        const password=document.getElementById('resetNewPassword').value;if(password!==document.getElementById('resetConfirmPassword').value)throw new Error('New passwords do not match.');
        await api('/api/password-reset/complete','POST',{token,password});session=null;showLogin('Password reset. Sign in with your new password.');
      }catch(error){errorText('resetLinkError',error);}finally{button.disabled=false;}
    };
  }
  async function openWorkspace() {
    if (session.user.mustChange) return showPassword(true);
    const snapshot = await api('/api/state');
    window.workspaceSession = {...session,...snapshot};
    for (const [id,value] of Object.entries({userName:session.user.name,userRole:session.user.role,userInitials:session.user.name.split(' ').map(word=>word[0]).slice(0,2).join('').toUpperCase()})) document.getElementById(id).textContent=value;
    if (!appLoaded) {
      await new Promise((resolve,reject)=>{
        const script = document.createElement('script'); script.src = '/app.js';
        script.onload = resolve; script.onerror = () => reject(new Error('Could not load the workspace. Reload to retry.'));
        document.body.append(script);
      });
      appLoaded = true;
    }
    layer.hidden = true; document.body.classList.remove('signed-out');
  }
  function showPassword(required = false) {
    showAuth(`<h1>${required ? 'Choose your own password' : 'Change password'}</h1><p>Use 12–128 characters. You will sign in again after changing it.</p>
      <form id="passwordForm" class="account-form"><label>Current ${required?'temporary ':''}password<input id="currentPassword" type="password" autocomplete="current-password" required /></label>
      <label>New password<input id="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label>
      <label>Confirm new password<input id="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label>
      <p id="passwordError" class="form-error" role="alert"></p><button class="btn primary" type="submit">Save password</button>
      ${required?'<button class="btn" type="button" id="cancelPassword">Sign out</button>':'<button class="btn" type="button" id="cancelPassword">Cancel</button>'}</form>`);
    document.getElementById('cancelPassword').onclick=async()=>{if(required){await api('/api/logout','POST',{});location.reload();}else{layer.hidden=true;document.body.classList.remove('signed-out');}};
    document.getElementById('passwordForm').onsubmit=async event=>{
      event.preventDefault(); const button=event.submitter; button.disabled=true;
      try {
        const password=document.getElementById('newPassword').value;
        if(password!==document.getElementById('confirmPassword').value) throw new Error('New passwords do not match.');
        await api('/api/password','POST',{currentPassword:document.getElementById('currentPassword').value,password});
        session=null; showLogin('Password changed. Sign in with your new password.');
      }catch(error){errorText('passwordError',error);}finally{button.disabled=false;}
    };
  }
  const footer = '<button class="btn" data-close-modal>Close</button>';
  function download(value, name) {
    const link=document.createElement('a');const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function showUsers() {
    const [{users},{requests}]=await Promise.all([api('/api/users'),api('/api/password-reset/requests')]);
    window.modal('Team access','Manage access and password recovery for your shared workspace.',`${requests.length?`<h3>Password reset requests</h3><p>Verify the requester’s identity before sharing a reset link.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>Account</th><th>Requested</th><th>Action</th></tr></thead><tbody>${requests.map(request=>`<tr><td>${escape(request.name)}<br>${escape(request.email)}</td><td>${escape(new Date(request.requested_at).toLocaleString())}</td><td>${request.user_id===session.user.id?'Ask another administrator':`<button class="btn primary" data-reset-user="${escape(request.user_id)}">Reset password</button>`}</td></tr>`).join('')}</tbody></table></div>`:''}<h3>All team members</h3><div class="table-wrap"><table class="data-table" style="min-width:580px"><thead><tr><th>User</th><th>Role</th><th>Access</th><th>Actions</th></tr></thead><tbody>${users.map(user=>`<tr><td><b>${escape(user.name)}</b><br>${escape(user.email)}</td><td>${escape(user.role)}</td><td>${user.active?'Active':'Disabled'}</td><td>${user.id===session.user.id?'<button class="btn" id="changeOwnPassword">Change password</button>':`<button class="btn" data-edit-user="${escape(user.id)}">Edit</button> <button class="btn" data-reset-user="${escape(user.id)}" ${user.active?'':'disabled'}>Reset password</button>`}</td></tr>`).join('')}</tbody></table></div>`,`${footer}<button class="btn primary" id="addUser">Add user</button>`);
    document.getElementById('addUser').onclick=()=>userForm();
    document.querySelectorAll('[data-edit-user]').forEach(button=>{button.onclick=()=>userForm(users.find(user=>user.id===button.dataset.editUser));});
    document.querySelectorAll('[data-reset-user]').forEach(button=>{button.onclick=()=>showUserReset(users.find(user=>user.id===button.dataset.resetUser));});
    document.getElementById('changeOwnPassword').onclick=()=>{window.closeModal();showPassword();};
  }
  function showUserReset(user){
    window.modal('Reset password',user.email,`<p><strong>${escape(user.name)}</strong></p><p>Create a reset link so this user can choose their own password. Share it privately after verifying their identity. The link expires in 30 minutes and works once.</p><p id="createResetError" class="form-error" role="alert"></p>`,`${footer}<button class="btn" id="temporaryPasswordOption">Set temporary password</button><button class="btn primary" id="createResetLink">Create reset link</button>`);
    document.getElementById('temporaryPasswordOption').onclick=()=>showTemporaryPassword(user);
    document.getElementById('createResetLink').onclick=async event=>{
      event.target.disabled=true;
      try{
        const result=await api(`/api/users/${user.id}/reset-link`,'POST',{});
        window.modal('Reset link created',user.email,`<p>Share this link privately with ${escape(user.name)}. It expires at ${escape(new Date(result.expiresAt).toLocaleString())} and works once. Existing sessions end when the user resets their password.</p><label class="account-form">Password reset link<input id="createdResetLink" type="text" value="${escape(result.url)}" readonly autocomplete="off" /></label>`,`${footer}<button class="btn" id="resetBackToUsers">Back to team</button><button class="btn primary" id="copyResetLink">Copy link</button>`);
        document.getElementById('resetBackToUsers').onclick=()=>showUsers().catch(error=>window.showToast(error.message));
        document.getElementById('copyResetLink').onclick=async()=>{try{await navigator.clipboard.writeText(result.url);window.showToast('Reset link copied. Share it privately.');}catch{document.getElementById('createdResetLink').select();window.showToast('Select and copy the link from the field.');}};
      }catch(error){errorText('createResetError',error);event.target.disabled=false;}
    };
  }
  function showTemporaryPassword(user){
    window.modal('Set temporary password',user.email,`<p>This signs the user out of every session. They must change the temporary password on their next sign-in.</p><form id="temporaryPasswordForm" class="account-form"><label>Temporary password<input id="temporaryPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><label>Confirm temporary password<input id="temporaryPasswordConfirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><button class="btn" type="button" id="generateTemporaryPassword">Generate password</button><p id="temporaryPasswordError" class="form-error" role="alert"></p><button class="btn primary" type="submit">Reset password</button></form>`,footer);
    document.getElementById('generateTemporaryPassword').onclick=()=>{
      const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';const value=Array.from(crypto.getRandomValues(new Uint8Array(18)),byte=>alphabet[byte&63]).join('');
      for(const id of ['temporaryPassword','temporaryPasswordConfirm']){const input=document.getElementById(id);input.value=value;input.type='text';}
    };
    document.getElementById('temporaryPasswordForm').onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;
      try{
        const password=document.getElementById('temporaryPassword').value;if(password!==document.getElementById('temporaryPasswordConfirm').value)throw new Error('Passwords do not match.');
        await api(`/api/users/${user.id}/reset-password`,'POST',{password});await showUsers();window.showToast('Password reset. Share the temporary password privately.');
      }catch(error){errorText('temporaryPasswordError',error);}finally{button.disabled=false;}
    };
  }
  function userForm(user) {
    window.modal(user?'Edit team member':'Add team member','Share temporary passwords privately. New users must change them on first sign-in.',`<form id="teamUserForm" class="account-form">
      ${user?`<p><b>${escape(user.name)}</b><br>${escape(user.email)}</p>`:'<label>Name<input id="teamName" required maxlength="100" /></label><label>Email<input id="teamEmail" type="email" required /></label>'}
      <label>Role<select id="teamRole">${['viewer','editor','admin'].map(role=>`<option ${role===(user?.role || 'viewer')?'selected':''}>${role}</option>`).join('')}</select></label>
      <p>Viewers can read and export. Editors can change financial records. Admins also manage accounts and restore backups.</p>
      ${user?`<label>Access<select id="teamActive"><option value="true" ${user.active?'selected':''}>Active</option><option value="false" ${user.active?'':'selected'}>Disabled</option></select></label>`:''}
      ${user?'':'<label>Temporary password<input id="teamPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label>'}
      <p id="teamError" class="form-error" role="alert"></p><button class="btn primary" type="submit">Save user</button></form>`,footer);
    document.getElementById('teamUserForm').onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;
      try{
        const payload={role:document.getElementById('teamRole').value};
        const password=document.getElementById('teamPassword')?.value;
        if(password) payload.password=password;
        if(user) payload.active=document.getElementById('teamActive').value==='true';
        else Object.assign(payload,{name:document.getElementById('teamName').value,email:document.getElementById('teamEmail').value});
        await api(user?`/api/users/${user.id}`:'/api/users',user?'PATCH':'POST',payload);
        await showUsers();window.showToast('Team access saved.');
      }catch(error){errorText('teamError',error);}finally{button.disabled=false;}
    };
  }
  function previewRestore(input, source) {
    if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('Choose a ReconcileIQ workspace JSON file.');
    const next=input.state || input;
    if(!next || !Array.isArray(next.invoices) || !Array.isArray(next.bank) || !Array.isArray(next.advice)) throw new Error('Choose a ReconcileIQ workspace JSON file.');
    window.modal('Review workspace import',source,`<p>This replaces the shared financial records for every user. The current revision will be retained in Previous revisions.</p><div class="detail-top"><div><small>Invoices</small><b>${next.invoices.length}</b></div><div><small>Advice entries</small><b>${next.advice.length}</b></div><div><small>Bank receipts</small><b>${next.bank.length}</b></div><div><small>Customer terms</small><b>${next.customerTerms?.length || 0}</b></div></div><p id="restoreError" class="form-error" role="alert"></p>`,`<button class="btn" data-close-modal>Cancel</button><button class="btn danger" id="confirmRestore">Replace shared records</button>`);
    document.getElementById('confirmRestore').onclick=async event=>{
      event.target.disabled=true;
      try{await window.replaceWorkspace(next);window.closeModal();window.showToast('Shared workspace imported.');}
      catch(error){errorText('restoreError',error);}finally{event.target.disabled=false;}
    };
  }
  function showRestore() {
    window.modal('Import / restore workspace','Select a workspace JSON backup. You will review its contents before replacing shared records.',`<label class="account-form">JSON backup<input id="backupFile" type="file" accept=".json,application/json" /></label><p id="fileError" class="form-error" role="alert"></p>`,footer);
    document.getElementById('backupFile').onchange=async event=>{
      try{
        const file=event.target.files[0];if(!file)return;
        if(file.size>64*1024*1024)throw new Error('Backup must be smaller than 64 MB.');
        previewRestore(JSON.parse(await file.text()),file.name);
      }catch(error){errorText('fileError',error);}
    };
  }
  function showLegacy() {
    const data=localStorage.getItem('reconcileiq-state');
    if(!data){window.modal('Existing browser data','No previous workspace was found on this address.','<p>Open the local app at its original address, sign in and choose Import existing browser data, then Download browser data. Upload that file here using Import / restore JSON.</p>',footer);return;}
    const next=JSON.parse(data);
    window.modal('Existing browser data','Your original browser copy will be kept.',`<p>Found ${next.invoices?.length || 0} invoices. Download this copy to transfer it to your live site, or review it for import into this workspace.</p>`,`${footer}<button class="btn" id="downloadLegacy">Download browser data</button><button class="btn primary" id="importLegacy">Review import</button>`);
    document.getElementById('downloadLegacy').onclick=()=>download({format:'reconcileiq-backup-v1',state:next},'reconcileiq-browser-data.json');
    document.getElementById('importLegacy').onclick=()=>previewRestore(next,'Existing browser data');
  }
  async function showAudit() {
    const {events}=await api('/api/audit');
    window.modal('Activity history','Latest 200 server-recorded events.',`<div class="table-wrap"><table class="data-table" style="min-width:600px"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody>${events.map(event=>`<tr><td>${escape(new Date(event.created_at).toLocaleString())}</td><td>${escape(event.actor_name)}</td><td>${escape(event.action)}</td><td class="audit-detail">${escape(JSON.stringify(event.detail))}</td></tr>`).join('') || '<tr><td colspan="4">No activity recorded.</td></tr>'}</tbody></table></div>`,footer);
  }
  async function showSnapshots() {
    const {snapshots}=await api('/api/snapshots');
    window.modal('Previous revisions','Recent saved revisions are available for recovery (20 for large workspaces; up to 100 for smaller workspaces).',`<div class="table-wrap"><table class="data-table" style="min-width:400px"><thead><tr><th>Revision</th><th>Saved</th><th></th></tr></thead><tbody>${snapshots.map(item=>`<tr><td>${item.revision}</td><td>${escape(new Date(item.created_at).toLocaleString())}</td><td><button class="btn" data-restore-revision="${item.revision}">Review restore</button></td></tr>`).join('') || '<tr><td colspan="3">No previous revisions yet.</td></tr>'}</tbody></table></div>`,footer);
    document.querySelectorAll('[data-restore-revision]').forEach(button=>{button.onclick=async()=>{
      try{previewRestore(await api(`/api/snapshots/${button.dataset.restoreRevision}`),`Revision ${button.dataset.restoreRevision}`);}
      catch(error){window.showToast(error.message);}
    };});
  }
  window.bindTeamControls=()=>{
    const actions={password:()=>showPassword(),users:showUsers,backup:async()=>download(await api('/api/backup'),`reconcileiq-backup-${new Date().toISOString().slice(0,10)}.json`),restore:showRestore,legacy:showLegacy,audit:showAudit,snapshots:showSnapshots};
    document.querySelectorAll('[data-team-action]').forEach(button=>{button.onclick=async()=>{
      try{await actions[button.dataset.teamAction]();}catch(error){window.showToast(error.message);}
    };});
  };
  document.getElementById('logoutButton').onclick=async()=>{
    try{await api('/api/logout','POST',{});location.reload();}catch(error){window.showToast?.(error.message);}
  };
  const resetToken=new URLSearchParams(location.hash.slice(1)).get('reset');
  if(resetToken){history.replaceState(null,'',location.pathname+location.search);showResetLinkForm(resetToken);}
  else api('/api/session').then(async value=>{session=value;await openWorkspace();}).catch(error=>showLogin(error.status===401?'':error.message));
})();
