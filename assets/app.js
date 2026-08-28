/* InfluenceOS — Agent & Influencer Management Platform. Powered by DoxTox. */
const $=s=>document.querySelector(s), app=$('#app');
let state=JSON.parse(localStorage.getItem('ios.session')||'null');

/* ═══════════ SILENT DATA LAYER — stale-while-revalidate ═══════════
   • api() returns cached data INSTANTLY (no spinner on navigation or refresh)
   • data revalidates in the BACKGROUND every ~15s (one key at a time, staggered)
   • a view re-renders ONLY when its data actually changed — same UI, values just update
   • identical renders are skipped entirely (no flicker, no scroll jump, no focus loss)
   • a transient error never blanks the screen: old data stays, a tiny chip says "Reconnecting…" */
const REFRESH_MS=15000;
const KEY_INTERVAL=k=>(k==='helpdesk'||k.startsWith('helpdesk/'))?12000:REFRESH_MS;
const dbCache=new Map();               // key -> {data,sig,at,inflight,jit}
const subs=new Map();                  // key -> Set<fn(data)>  focus-safe targeted updates
let viewPaint=null;                    // {keys:[], fn} active view repaint
let pendingRepaint=false;

const sig=x=>{try{return JSON.stringify(x)}catch{return null}};
const isStale=(k,c)=>Date.now()-c.at>=KEY_INTERVAL(k)+(c.jit||0);

function rawFetch(path,opt={}){
  const method=(opt.method||'GET').toUpperCase();
  return fetch('/api/ios/'+path,{cache:'no-store',method,
    headers:{'content-type':'application/json','cache-control':'no-store',
      ...(state?.token?{authorization:'Bearer '+state.token}:{}),
      ...(opt.fresh?{'x-fresh':'1'}:{})},
    ...(method==='GET'?{}:{body:opt.body})})
  .then(async r=>{let x=await r.json().catch(()=>({}));if(!r.ok)throw Error(x.error||'Request failed');return x});
}
function revalidate(key,opt={}){
  let c=dbCache.get(key);
  if(c?.inflight)return c.inflight;
  const p=(async()=>{
    try{
      const data=await rawFetch(key,opt);
      const s=sig(data),prev=dbCache.get(key),changed=!prev||prev.sig!==s;
      dbCache.set(key,{data,sig:s,at:Date.now(),inflight:null,jit:prev?prev.jit:Math.floor(Math.random()*4000)});
      if(changed)notify(key,data);
      syncOk();
      return dbCache.get(key);
    }catch(e){
      const prev=dbCache.get(key);
      if(prev){prev.inflight=null;prev.at=Date.now()-KEY_INTERVAL(key)+5000;if(prev.data)syncFail()}
      throw e;
    }
  })();
  if(c)c.inflight=p;else dbCache.set(key,{data:null,sig:null,at:0,inflight:p,jit:Math.floor(Math.random()*4000)});
  return p;
}
function notify(key,data){
  const s=subs.get(key);if(s)s.forEach(f=>{try{f(data)}catch(e){}});
  if(viewPaint&&viewPaint.keys.includes(key))queueRepaint();
}
function onKey(key,fn){let s=subs.get(key);if(!s){s=new Set();subs.set(key,s)}s.add(fn);return()=>s.delete(fn)}

/* the loader only ever shows on FIRST entry to a view (never during background refresh).
   If the screen is still showing a PREVIOUS view while the next one loads, show the loader
   so a click always gives immediate feedback. */
const loaderHtml=(text='')=>`<div class="loader-wrap"><div class="loader">
    <span class="bar"></span>
    <span class="bar"></span>
    <span class="bar"></span>
  </div>${text?`<div class="loader-text">${esc(text)}</div>`:''}</div>`;
const loading=main=>{if(main&&!main.children.length)main.innerHTML=loaderHtml('Loading…')};
const loadingFor=(main,view)=>{if(main&&(main.dataset.painted||'')!==view)main.innerHTML=loaderHtml('Loading…')};

/* cache-first data access for views: instant from cache, silent refresh behind it.
   • all keys cached  → paint instantly, refresh stale ones silently
   • some keys missing → show the loader ONLY if the screen still shows another view
   • a failing key never kills the view: we fall back to its last good data, and only
     show the full error panel when the PRIMARY key (first) has no data at all. */
async function needData(main,view,keys,opt){
  opt=opt||{};
  if(!main||main.dataset.view!==view)return null;
  const has=k=>{const c=dbCache.get(k);return !!(c&&c.data)};
  if(!keys.every(has))loadingFor(main,view);
  const settled=await Promise.all(keys.map(async k=>{
    const c=dbCache.get(k);
    if(c&&c.data&&!opt.forceFresh){if(isStale(k,c))revalidate(k).catch(()=>{});return {ok:true,data:c.data}}
    try{return {ok:true,data:await revalidate(k,{fresh:!!opt.forceFresh}).then(e=>e.data)}
    }catch(e){return {ok:false,err:e,data:(dbCache.get(k)||{}).data}}
  }));
  if(!main.isConnected||main.dataset.view!==view)return null;    // user moved on already
  const primary=settled[0];
  if(!primary.ok&&(primary.data===undefined||primary.data===null)){showViewError(main,primary.err);return null}
  if(settled.some(x=>!x.ok)){                                     // partial failure → degrade gracefully
    syncFail();
    if(primary.ok)return settled.map(x=>x.ok?x.data:(x.data!=null?x.data:(keys.length>1?[]:null)));
  }
  return settled.map(x=>x.ok?x.data:(x.data!=null?x.data:[]));
}
const need=async(main,view,key,opt)=>{const r=await needData(main,view,[key],opt);return r?r[0]:null};
/* a refresh/render problem must never wipe what the user is looking at:
   if this view already painted, keep it and toast; only a first paint may show the error panel. */
function keepOrShowError(main,view,e){
  if(main.dataset.painted===view&&main.children.length){toast('Could not update: '+(e&&e.message?e.message:'error'));syncFail();return}
  showViewError(main,e);
}
function showViewError(main,e){
  main.innerHTML=`<div class="empty" style="padding:60px 20px"><b style="font-size:16px">Could not load this view</b>
    <div style="font-size:12px;color:#999;margin-top:6px">${esc(e.message||'Network error')}</div>
    <div style="margin-top:16px"><button class="btn dark" id="viewRetry">↻ Retry</button></div></div>`;
  $('#viewRetry').onclick=()=>{main.innerHTML=loaderHtml('Loading…');(state.role==='admin'?renderAdmin():renderPartner()).catch(()=>{})};
}

/* guarded repaint: while the user types in the view or a modal is open we hold updates,
   then flush them the moment they are done — the UI is never disturbed. */
let repaintScheduled=false;
function queueRepaint(){
  if(repaintScheduled)return;repaintScheduled=true;
  requestAnimationFrame(()=>{repaintScheduled=false;flushRepaint()});
}
function flushRepaint(){
  if(!viewPaint)return;
  const main=$('#main');if(!main)return;
  const ae=document.activeElement;
  if(document.querySelector('.overlay')||(ae&&main.contains(ae)&&/INPUT|TEXTAREA|SELECT/.test(ae.tagName))){pendingRepaint=true;return}
  pendingRepaint=false;
  Promise.resolve(viewPaint.fn()).catch(()=>{});
}
document.addEventListener('focusout',()=>setTimeout(()=>{if(pendingRepaint)flushRepaint()},120));
new MutationObserver(()=>{if(pendingRepaint&&!document.querySelector('.overlay'))flushRepaint()}).observe(document.body,{childList:true});

/* background ticker — pulls ONE stale key at a time so requests never burst or freeze the screen */
setInterval(()=>{
  if(document.hidden||!viewPaint)return;
  const now=Date.now(),keys=[...new Set(viewPaint.keys.concat(['helpdesk']))];
  for(const k of keys){
    const c=dbCache.get(k);
    if(c&&c.data&&!c.inflight&&now-c.at>=KEY_INTERVAL(k)+(c.jit||0)){revalidate(k).catch(()=>{});break}
  }
},3000);
document.addEventListener('visibilitychange',()=>{
  if(document.hidden||!viewPaint)return;
  viewPaint.keys.forEach(k=>{const c=dbCache.get(k);if(c&&c.data&&!c.inflight&&Date.now()-c.at>5000)revalidate(k).catch(()=>{})});
  const h=dbCache.get('helpdesk');if(h&&h.data&&!h.inflight&&Date.now()-h.at>5000)revalidate('helpdesk').catch(()=>{});
});
window.addEventListener('online',()=>{if(viewPaint)viewPaint.keys.forEach(k=>revalidate(k).catch(()=>{}));revalidate('helpdesk').catch(()=>{})});

/* tiny non-blocking connection chip — never blocks or blanks the UI */
function syncFail(){let c=$('#syncchip');if(!c){c=document.createElement('div');c.id='syncchip';c.innerHTML='<span class="syncdot"></span>Reconnecting…';document.body.append(c)}c.classList.add('show')}
function syncOk(){const c=$('#syncchip');if(c)c.classList.remove('show')}

/* keep #main stable: identical HTML is skipped (zero DOM work), and when content
   does change, scroll position + focused input + caret are preserved automatically. */
function armMain(main){
  if(!main||main.__armed)return;
  const desc=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  main.__armed=true;
  let last='';
  Object.defineProperty(main,'innerHTML',{
    configurable:true,
    get(){return desc.get.call(main)},
    set(html){
      html=String(html);
      if(html===last)return;                       // nothing changed visually → don't touch the DOM at all
      const snap=snapView(main);
      desc.set.call(main,html);
      last=html;
      try{main.dataset.painted=main.dataset.view||''}catch(e){}
      restoreView(main,snap);
    }
  });
}
function snapView(root){
  const els=[root].concat([].slice.call(root.querySelectorAll('.chat,[style*="overflow"]'))).filter(el=>el.scrollHeight-el.clientHeight>4).slice(0,40);
  const ae=document.activeElement;
  const focus=(ae&&root.contains(ae)&&ae.id)?{id:ae.id,ss:ae.selectionStart,se:ae.selectionEnd,st:ae.scrollTop}:null;
  return {y:window.scrollY,tops:els.map(el=>el.scrollTop),focus:focus};
}
function restoreView(root,snap){
  try{
    const els=[root].concat([].slice.call(root.querySelectorAll('.chat,[style*="overflow"]'))).filter(el=>el.scrollHeight-el.clientHeight>4).slice(0,40);
    els.forEach((el,i)=>{if(snap.tops[i]!=null)el.scrollTop=snap.tops[i]});
    if(Math.abs(window.scrollY-snap.y)>1)window.scrollTo({top:snap.y});
    if(snap.focus){const el=root.querySelector('#'+CSS.escape(snap.focus.id));if(el){el.focus();if(snap.focus.ss!=null&&el.setSelectionRange){try{el.setSelectionRange(snap.focus.ss,snap.focus.se)}catch(e){}}if(snap.focus.st)el.scrollTop=snap.focus.st}}
  }catch(e){}
}

/* mutations land silently: fresh values arrive in the background and the screen updates in place */
function refreshActive(){
  const keys=viewPaint?Array.from(new Set(viewPaint.keys.concat(['helpdesk']))):['helpdesk'];
  keys.forEach(k=>{
    const c=dbCache.get(k);if(c)c.at=0;
    const go=()=>revalidate(k,{fresh:true}).catch(()=>{});
    const infl=c&&c.inflight;                                  // if a pre-mutation fetch is still running, chain the fresh one after it
    if(infl)Promise.resolve(infl).catch(()=>{}).then(go);else go();
  });
}
const api=async(path,opt={})=>{
  const method=(opt.method||'GET').toUpperCase();
  if(method!=='GET')return rawFetch(path,{'method':method,'body':opt.body,'fresh':true});
  const c=dbCache.get(path);
  if(c&&c.data){
    if(opt.forceFresh)return revalidate(path,{fresh:true}).then(e=>e.data);
    if(isStale(path,c))revalidate(path).catch(()=>{});
    return c.data;
  }
  return revalidate(path,{fresh:!!opt.forceFresh}).then(e=>e.data);
};
const upload=async(path,formData)=>{
  let r=await fetch('/api/ios/'+path,{method:'POST',cache:'no-store',headers:{'cache-control':'no-store',...(state?.token?{authorization:'Bearer '+state.token}:{})},body:formData});
  let x=await r.json().catch(()=>({}));if(!r.ok)throw Error(x.error||'Upload failed');refreshActive();return x;
};
const mutate=async(path,opt={})=>{const r=await rawFetch(path,{'method':(opt.method||'POST').toUpperCase(),'body':opt.body,'fresh':true});refreshActive();return r};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'$'+Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2});
const num=v=>Number(v)||0;
const initials=n=>String(n||'?').trim().split(/\s+/).map(w=>w[0]).filter(Boolean).slice(0,2).join('').toUpperCase();
const pct=(a,b)=>b>0?Math.min(999,Math.round(a/b*100)):0;
const fmtDate=d=>String(d||'').slice(0,10);
const fmtDT=d=>{const x=new Date(d);return isNaN(x)?String(d||''):x.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})};
const fmtSize=b=>{const n=Number(b)||0;return n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' B'};
const openFile=async(id,name,download)=>{
  try{
    const r=await fetch('/api/ios/files/'+id,{cache:'no-store',headers:{'cache-control':'no-store',...(state?.token?{authorization:'Bearer '+state.token}:{})}});
    if(!r.ok){const x=await r.json().catch(()=>({}));throw Error(x.error||'Could not open file')}
    const blob=await r.blob();const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener';
    if(download)a.download=name||'file';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(e){toast(e.message)}
};
function filesCell(files){
  if(!files||!files.length)return '—';
  return `<button class="btn small" data-files='${esc(JSON.stringify(files.map(f=>({id:f.id,n:f.file_name,s:f.file_size}))))}'>📁 ${files.length}</button>`;
}
function filesModal(files){
  const ov=modal(`<h2>Proof files (${files.length})</h2><p>Click a file to open it in a new tab.</p>
  ${files.map(f=>`<div class="target-row"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.n)}</b><span>${fmtSize(f.s)}</span><button class="btn small" data-view="${f.id}" data-name="${esc(f.n)}">View</button><button class="btn small" data-dl="${f.id}" data-name="${esc(f.n)}">Download</button></div>`).join('')}
  <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  ov.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>openFile(b.dataset.view,b.dataset.name,false));
  ov.querySelectorAll('[data-dl]').forEach(b=>b.onclick=()=>openFile(b.dataset.dl,b.dataset.name,true));
}
function toast(m){let e=$('#toast');e.textContent=m;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),3200)}

const TYPE_LABELS={youtuber:'YouTuber',facebook:'Facebook',tiktoker:'TikToker',instagram:'Instagram',telegram:'Telegram',marketing_agent:'Marketing Agent',agency:'Agency'};
const PARTNER_STATUS={disagree:['Disagree','red'],agree:['Agree','green'],not_response:['Not Response','yellow'],waiting:['Waiting','blue']};
const ALLOC_STATUS={on_target:['On Target','green'],active:['Active','blue'],behind:['Behind','red'],inactive:['Inactive','gray']};
const PAY_STATUS={scheduled:['Scheduled','blue'],paid:['Paid','green'],pending:['Pending','yellow']};
const CONTRIB_STATUS={pending:['Pending','yellow'],accepted:['Accepted','green'],rejected:['Rejected','red']};
const WD_STATUS={pending:['Pending','yellow'],accepted:['Accepted','green'],rejected:['Rejected','red']};
const TEAM_TYPE_LABELS={youtuber:'YouTuber',facebook:'Facebook',tiktoker:'TikToker',instagram:'Instagram',telegram:'Telegram',marketing_agent:'Marketing Agent',agency:'Agency'};
const TEAM_STATUS={active:['Active','green'],inactive:['Inactive','gray']};
const CATEGORIES=['views','clicks','sales','users','shares','reach','leads','profit','installs'];
const catLabel=c=>String(c||'users').charAt(0).toUpperCase()+String(c||'users').slice(1);
const pill=(map,key)=>{const m=map[key]||[String(key),'gray'];return `<span class="pill ${m[1]}">${m[0]}</span>`};
const projPill=s=>s==='active'?'<span class="pill green">Active</span>':'<span class="pill gray">Inactive</span>';

function save(s){state=s;localStorage.setItem('ios.session',JSON.stringify(s))}
function logout(){localStorage.removeItem('ios.session');state=null;dbCache.clear();subs.clear();viewPaint=null;pendingRepaint=false;syncOk();boot()}

/* ═══════════ MODAL SYSTEM ═══════════ */
function modal(html,cls=''){
  const ov=document.createElement('div');ov.className='overlay';
  ov.innerHTML=`<div class="modal ${cls}">${html}</div>`;
  document.body.append(ov);
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove()});
  ov.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>ov.remove());
  return ov;
}

/* ═══════════ LANDING PAGE ═══════════ */
function landing(){
  document.body.classList.add('landing-mode');
  document.body.classList.remove('dashboard-mode');
  document.title='InfluenceOS | DoxTox';
  app.innerHTML=`
  <header class="land-head"><div class="in">
    <div class="logo" style="padding:0">Influence<span>OS</span><small>powered by DoxTox</small></div>
    <nav class="land-nav">
      <a href="#features">Features</a><a href="#workflow">Workflow</a><a href="#roles">Roles</a>
      <button class="btn dark" id="loginBtn">Login</button>
    </nav>
  </div></header>

  <section class="hero">
    <div>
      <span class="pill blue">Marketing · Branding · Task Management</span>
      <h1>Run campaigns, brands &amp; creator tasks in <span>one OS</span></h1>
      <p class="lead">InfluenceOS is the operating system for marketing teams — plan brand campaigns, onboard creators and agents, assign targets as tasks, collect contribution proofs, approve deliverables and pay commissions without spreadsheets.</p>
      <div class="cta">
        <button class="btn dark big" id="heroLogin">Login to workspace</button>
        <a class="btn big" href="#features">See features</a>
      </div>
      <div class="stats">
        <div><b>Campaigns</b><span>Launches &amp; brand pushes</span></div>
        <div><b>Creators</b><span>Agents &amp; their teams</span></div>
        <div><b>Tasks</b><span>Targets, proofs &amp; approvals</span></div>
        <div><b>Payouts</b><span>Commissions &amp; withdrawals</span></div>
      </div>
    </div>
    <div class="hero-card">
      <div class="detail-head"><div><h2 style="font-size:16px">Summer Brand Launch</h2><p>25,000 target users · 5 creators on task</p></div>${pill(ALLOC_STATUS,'on_target')}</div>
      <div class="meta"><span>Campaign target</span><b>25,000</b></div>
      <div class="progress-lg"><i style="width:74%"></i></div>
      <div class="meta"><span>74% of goal reached</span><span>$18,400 budget</span></div>
      <div class="target-row"><b>Arif · YouTube</b><span>Task 7,000</span><span>Done 5,420</span><span class="right"><b>77%</b></span></div>
      <div class="target-row"><b>Shakib · Facebook</b><span>Task 3,000</span><span>Done 2,800</span><span class="right"><b>93%</b></span></div>
      <div class="target-row"><b>Trend Makers · Agency</b><span>Task 6,000</span><span>Done 2,980</span><span class="right"><b>50%</b></span></div>
    </div>
  </section>

  <section class="land-section" id="features">
    <h2>Marketing, branding &amp; task management in one place</h2>
    <p class="sub">A connected data structure — Agent → Task → Campaign → Proof → Payout. Nothing is entered twice.</p>
    <div class="feat-grid">
      <div class="feat"><div class="fi">◆</div><h3>Marketing campaigns</h3><p>Plan launches and brand pushes with budgets and clear audience goals. Targets, acquired users and used budget update automatically as work happens.</p></div>
      <div class="feat"><div class="fi">▣</div><h3>Brand management</h3><p>Keep every brand project organized — briefs, notes, budgets, progress and the exact creators behind each result, all in one branded workspace.</p></div>
      <div class="feat"><div class="fi">✓</div><h3>Task management</h3><p>Assign per-creator targets as tasks, collect proof files with every contribution, approve or reject with reasons, and track achievement on live progress bars.</p></div>
      <div class="feat"><div class="fi">◉</div><h3>Creator network</h3><p>Onboard agents, influencers and agencies — or let agents build their own teams with 4-digit codes, social accounts and login access control.</p></div>
      <div class="feat"><div class="fi">◫</div><h3>Performance analytics</h3><p>Achievement percentages, rankings and project-wise breakdowns are computed automatically from approved contributions.</p></div>
      <div class="feat"><div class="fi">$</div><h3>Payouts &amp; withdrawals</h3><p>Commissions build up as payments are marked paid; agents withdraw to bKash, Nagad or USDT with admin approval, provider numbers and transaction IDs.</p></div>
    </div>
  </section>

  <section class="land-section" id="workflow" style="padding-top:10px">
    <h2>From campaign brief to creator payout</h2>
    <p class="sub">The system keeps tasks, progress and finances in sync automatically.</p>
    <div class="card"><div class="target-row"><b>1 · Build the network</b><span>Onboard agents &amp; teams</span><span>4-digit codes generated</span><span class="right">Socials saved</span></div>
    <div class="target-row"><b>2 · Launch the campaign</b><span>Set the brand budget</span><span>Define the goal</span><span class="right">Go active</span></div>
    <div class="target-row"><b>3 · Assign &amp; track tasks</b><span>Targets per creator</span><span>Proofs submitted</span><span class="right">Approve or reject</span></div>
    <div class="target-row"><b>4 · Measure &amp; pay</b><span>Achievement auto-ranked</span><span>Commission on paid</span><span class="right">Withdrawals approved</span></div></div>
  </section>

  <section class="land-section" id="roles" style="padding-top:10px">
    <h2>Two roles, one workspace</h2>
    <p class="sub">Administrators run the marketing operation. Agents run their creator business.</p>
    <div class="two">
      <div class="card"><div class="fi" style="width:38px;height:38px;border-radius:9px;background:#f0f0f0;display:grid;place-items:center;font-size:18px;margin-bottom:12px">▦</div><h3 style="margin:0 0 8px;font-size:15px">Admin dashboard</h3><p style="margin:0;color:#777;font-size:12px;line-height:1.6">Campaign KPIs, agent directory, task allocations, contribution approvals with proof files, payouts with automatic commissions, withdrawal approvals and a continuous HelpDesk chat with every agent.</p></div>
      <div class="card"><div class="fi" style="width:38px;height:38px;border-radius:9px;background:#f0f0f0;display:grid;place-items:center;font-size:18px;margin-bottom:12px">◎</div><h3 style="margin:0 0 8px;font-size:15px">Agent portal</h3><p style="margin:0;color:#777;font-size:12px;line-height:1.6">Agents manage their own team, submit task contributions with proofs, follow approvals live, chat with the administrator, track earnings and request withdrawals to their saved payment methods.</p></div>
    </div>
  </section>

  <footer class="land-foot"><div class="in">
    <div>© ${new Date().getFullYear()} <b>InfluenceOS</b> — Marketing, Branding &amp; Task Management</div>
    <div class="powered">powered by <b>DoxTox</b></div>
  </div></footer>`;

  $('#loginBtn').onclick=loginModal;
  $('#heroLogin').onclick=loginModal;
}
/* ═══════════ LOGIN ═══════════ */
async function loginModal(){
  const ov=modal(`
    <h2>Login to InfluenceOS</h2>
    <p>Choose how you want to sign in.</p>
    <div style="display:grid;gap:10px">
      <button class="btn dark" id="mAdmin" style="padding:16px">▦ &nbsp;Admin login</button>
      <button class="btn" id="mAgent" style="padding:16px">◎ &nbsp;Agent login</button>
    </div>
    <p class="form-note" style="margin-top:14px">Agents can sign in with their 4-digit Agent ID or registered email.<br>New here? <a href="#" id="mRegister" style="color:#111;font-weight:600">Create an agent account</a></p>`);
  ov.querySelector('#mAdmin').onclick=()=>{ov.remove();adminLoginModal()};
  ov.querySelector('#mAgent').onclick=()=>{ov.remove();agentLoginModal()};
  ov.querySelector('#mRegister').onclick=e=>{e.preventDefault();ov.remove();agentRegisterModal()};
}
async function adminLoginModal(){
  let hasAdmin=true;try{hasAdmin=(await api('auth/status',{forceFresh:true})).hasAdmin}catch{}
  const register=!hasAdmin;
  const ov=modal(`
    <h2>${register?'Create administrator':'Admin login'}</h2>
    <p>${register?'No administrator exists yet — create the first account.':'Sign in with your administrator email and password.'}</p>
    ${register?'<div class="field"><label>Name</label><input id="aName" placeholder="Your name"></div>':''}
    <div class="field"><label>Email</label><input id="aEmail" type="email" placeholder="admin@company.com"></div>
    <div class="field"><label>Password</label><input id="aPass" type="password" placeholder="Minimum 6 characters"></div>
    <p class="form-note">Want to join the admin board as a user? <a href="#" id="userReq" style="color:#111;font-weight:600">Create user account request</a></p>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="aGo">${register?'Create & sign in':'Sign in'}</button></div>`);
  ov.querySelector('#userReq').onclick=e=>{e.preventDefault();ov.remove();userRequestModal()};
  ov.querySelector('#aGo').onclick=async()=>{
    try{
      const payload=register?{name:ov.querySelector('#aName').value,email:ov.querySelector('#aEmail').value,password:ov.querySelector('#aPass').value}
        :{email:ov.querySelector('#aEmail').value,password:ov.querySelector('#aPass').value};
      const r=await api(register?'auth/admin/register':'auth/admin/login',{method:'POST',body:JSON.stringify(payload)});
      save({token:r.token,role:'admin',user:r.user});ov.remove();boot();
    }catch(e){toast(e.message)}
  };
}

function userRequestModal(){
  const ov=modal(`
    <h2>Create user account request</h2>
    <p>Your account will stay pending until an administrator confirms it from User Control.</p>
    <div class="field-row"><div class="field"><label>Name</label><input id="uName" placeholder="Your full name"></div><div class="field"><label>Email</label><input id="uEmail" type="email" placeholder="you@company.com"></div></div>
    <div class="field"><label>Phone</label><input id="uPhone" placeholder="+880…"></div>
    <div class="field"><label>Address</label><input id="uAddress" placeholder="Street, city"></div>
    <div class="field"><label>Password</label><input id="uPass" type="password" placeholder="Minimum 6 characters"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="uGo">Send request</button></div>`);
  ov.querySelector('#uGo').onclick=async()=>{
    const btn=ov.querySelector('#uGo');btn.disabled=true;btn.textContent='Sending…';
    try{
      await api('auth/user/register',{method:'POST',body:JSON.stringify({name:ov.querySelector('#uName').value,email:ov.querySelector('#uEmail').value,phone:ov.querySelector('#uPhone').value,address:ov.querySelector('#uAddress').value,password:ov.querySelector('#uPass').value})});
      ov.remove();modal('<h2>Request submitted</h2><p>Your user account request is waiting for administrator confirmation. After approval, use the Admin login card to sign in.</p><div class="modal-actions"><button class="btn dark" data-close>Done</button></div>');
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent='Send request'}
  };
}

function agentRegisterModal(){
  const ov=modal(`
    <h2>Create agent account</h2>
    <p>Register as a marketing agent — your account starts in “Waiting” status until the administrator approves it (status Agree) for allocations.</p>
    <div class="field-row">
      <div class="field"><label>Name</label><input id="rName" placeholder="Your full name"></div>
      <div class="field"><label>Email</label><input id="rEmail" type="email" placeholder="you@email.com"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Phone number</label><input id="rPhone" placeholder="+880…"></div>
      <div class="field"><label>Type</label><select id="rType">${Object.entries(TYPE_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Address</label><input id="rAddress" placeholder="Street, city"></div>
    <div class="field"><label>Password</label><input id="rPass" type="password" placeholder="Minimum 6 characters"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="rGo">Create account</button></div>`);
  ov.querySelector('#rGo').onclick=async()=>{
    const btn=ov.querySelector('#rGo');
    try{
      btn.disabled=true;btn.textContent='Creating…';
      const r=await api('auth/partner/register',{method:'POST',body:JSON.stringify({name:ov.querySelector('#rName').value,email:ov.querySelector('#rEmail').value,phone:ov.querySelector('#rPhone').value,type:ov.querySelector('#rType').value,address:ov.querySelector('#rAddress').value,password:ov.querySelector('#rPass').value})});
      save({token:r.token,role:'partner',user:r.user});
      ov.remove();
      modal(`<h2>Welcome, ${esc(r.user.name)}!</h2><p>Your agent account was created. Save your Agent ID — you can sign in with it or your email.</p><div class="kv"><span>Agent ID</span><b style="font-size:20px">${esc(r.user.partner_code)}</b><span>Status</span><b>Waiting for administrator approval</b></div><div class="modal-actions"><button class="btn dark" data-close>Enter my portal</button></div>`);
      boot();
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent='Create account'}
  };
}
function agentLoginModal(){
  const ov=modal(`
    <h2>Agent login</h2>
    <p>Use your 4-digit Agent ID or registered email address.</p>
    <div class="field"><label>Agent ID or email</label><input id="pId" placeholder="4827 or you@email.com"></div>
    <div class="field"><label>Password</label><input id="pPass" type="password" placeholder="Your password"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="pGo">Sign in</button></div>`);
  ov.querySelector('#pGo').onclick=async()=>{
    try{
      const r=await api('auth/partner/login',{method:'POST',body:JSON.stringify({identifier:ov.querySelector('#pId').value,password:ov.querySelector('#pPass').value})});
      save({token:r.token,role:'partner',user:r.user});ov.remove();boot();
    }catch(e){toast(e.message)}
  };
}

/* ═══════════ ADMIN APP ═══════════ */
let aView='dashboard';
function adminApp(){
  document.body.classList.remove('landing-mode');
  document.body.classList.add('dashboard-mode');
  document.title='InfluenceOS — Admin';
  const nav=[['dashboard','▦','Dashboard'],['partners','◉','Agents'],['projects','◆','Projects'],['contribute','⇧','Contribute'],['allocations','◌','Allocations'],['payments','$','Payments'],['performance','◫','Performance'],['vaultium','▣','Vaultium'],['connectx','✉','ConnectX'],['helpdesk','✉','HelpDesk <span class="navbadge" id="hdBadge" style="display:none"></span>'],['profile','◉','User Profile'],['users','☷','User Control']];
  app.innerHTML=`<div class="app">
    <aside class="sidebar">
      <div class="logo">Influence<span>OS</span><small>powered by DoxTox</small></div>
      <div class="nav-label">Workspace</div>
      <div class="nav">${nav.map(([k,i,l])=>`<button data-v="${k}" class="${k===aView?'active':''}"><span class="icon">${i}</span> ${l}</button>`).join('')}</div>
      <div class="nav-label">System</div>
      <div class="nav"><button data-v="settings"><span class="icon">⚙</span> Settings</button></div>
      <div class="sidebottom"><button id="outBtn">⏻ Logout</button></div>
    </aside>
    <main class="main" id="main">${loaderHtml("Loading…")}</main>
  </div>`;
  document.querySelectorAll('.nav button[data-v]').forEach(b=>b.onclick=()=>{aView=b.dataset.v;document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x===b));renderAdmin()});
  $('#outBtn').onclick=logout;
  armMain($('#main'));
  onKey('helpdesk',d=>updateHdBadge((d&&d.totalUnread)||0));
  api('helpdesk').then(d=>updateHdBadge(d.totalUnread||0)).catch(()=>{});
  renderAdmin();
}
const ADMIN_KEYS={
  dashboard:['overview'],
  partners:['partners'],
  projects:['projects'],
  contribute:['contributions'],
  allocations:['allocations','projects','partners','team-allocations'],
  payments:['payments','partners','allocations','withdrawals'],
  performance:['performance'],
  vaultium:['vaultium'],
  connectx:[],
  helpdesk:null,            // dynamic: ['helpdesk', conversation key]
  profile:['admin/profile'],
  users:['admin/users'],
  settings:[]
};
async function renderAdmin(){
  const main=$('#main');if(!main)return;
  const view=aView;
  main.dataset.view=view;
  const keys=ADMIN_KEYS[view]||(view==='helpdesk'?['helpdesk'].concat(hdSelected?['helpdesk/'+hdSelected.kind+'/'+hdSelected.id]:[]):[]);
  viewPaint={keys:keys,fn:()=>renderAdmin()};
  try{
    if(view==='dashboard')return await aDashboard(main);
    if(view==='partners')return await aPartners(main);
    if(view==='projects')return await aProjects(main);
    if(view==='contribute')return await aContribute(main);
    if(view==='vaultium')return await aVaultium(main);
    if(view==='connectx')return await aConnectX(main);
    if(view==='helpdesk')return await aHelpdesk(main);
    if(view==='allocations')return await aAllocations(main);
    if(view==='payments')return await aPayments(main);
    if(view==='performance')return await aPerformance(main);
    if(view==='profile')return await aAdminProfile(main);
    if(view==='users')return await aUserControl(main);
    if(view==='settings')return aSettings(main);
  }catch(e){keepOrShowError(main,view,e)}
}

/* ---------- ADMIN: DASHBOARD ---------- */
async function aDashboard(main){
  const d=await need(main,'dashboard','overview');
  if(d)renderDashboard(main,d);
}
function renderDashboard(main,d){
  const k=d.kpis||{};
  const contributions=d.contributions||[],upcoming=d.upcoming||[];
  const kpi=(l,v,c='')=>`<div class="card stat"><div><div class="label">${l}</div><div class="value">${v}</div>${c?`<div class="change">${c}</div>`:''}</div></div>`;
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Good ${new Date().getHours()<12?'morning':new Date().getHours()<18?'afternoon':'evening'}, ${esc(state.user.name)}</h1><p>Marketing agent operations, project contribution and payouts.</p></div></div>
  <div class="kpi-grid">
    ${kpi('Total Agents',k.totalPartners)}
    ${kpi('Active Projects',k.activeProjects)}
    ${kpi('Total Allocated Targets',k.assignedTarget.toLocaleString())}
    ${kpi('Total Acquired Users',k.acquiredUsers.toLocaleString())}
  </div>
  <div class="kpi-grid" style="margin-top:15px">
    ${kpi('Total Income',money(k.totalIncome))}
    ${kpi('Total Paid Amount',money(k.totalPaid))}
    ${kpi('Remaining Balance',money(k.remainingBalance))}
    ${kpi('Overall Performance',k.overallPerformance+'%')}
  </div>
  <div class="section two">
    <div class="card table-card">
      <div class="table-top"><div><b>Project contribution</b><div style="font-size:11px;color:#999;margin-top:3px">Agent targets and acquired users</div></div></div>
      <div style="overflow:auto"><table class="table"><thead><tr><th>Agent</th><th>Project</th><th>Start</th><th>Deadline</th><th>Target</th><th>Acquired</th><th>Progress</th><th>Commission</th><th>Status</th></tr></thead>
      <tbody>${contributions.length?contributions.map(c=>`<tr>
        <td><div class="partner"><div class="avatar">${esc(initials(c.partner_name))}</div><div><b>${esc(c.partner_name)}</b><small>#${esc(c.partner_code)}</small></div></div></td>
        <td>${esc(c.project_name)}</td><td>${c.start_date?fmtDate(c.start_date):'—'}</td><td>${c.deadline?fmtDate(c.deadline):'—'}</td><td>${num(c.assigned_target).toLocaleString()}</td><td><b>${num(c.acquired_users).toLocaleString()}</b></td>
        <td style="min-width:130px"><div style="display:flex;justify-content:space-between;font-size:10px"><span>${pct(num(c.acquired_users),num(c.assigned_target))}%</span><span>${num(c.assigned_target).toLocaleString()} target</span></div><div class="progress"><i style="width:${pct(num(c.acquired_users),num(c.assigned_target))}%"></i></div></td>
        <td>${money(c.commission)}</td><td>${pill(ALLOC_STATUS,c.status)}</td></tr>`).join(''):'<tr><td colspan="9" class="empty">No allocations yet.</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="section-head"><h2>Upcoming payouts</h2><span>Not yet paid</span></div>
      <div class="row" style="display:block">
        ${upcoming.length?upcoming.map(p=>`<div class="row" style="border-top:1px solid var(--border)"><div class="left"><div class="mini">${esc(initials(p.partner_name))}</div><div><b>${esc(p.partner_name)}</b><small>${esc(p.project_name)} · ${fmtDate(p.payment_date)}</small></div></div><div class="money"><b>${money(p.amount)}</b><small>${PAY_STATUS[p.status]?.[0]||p.status}</small></div></div>`).join(''):'<div class="empty">Nothing pending. 🎉</div>'}
      </div>
    </div>
  </div>`;
}

/* ---------- ADMIN: PARTNERS ---------- */
let pFilter={q:'',type:'',status:''};
async function aPartners(main){
  const partners=await need(main,'partners','partners');
  if(partners)renderPartnersView(main,partners);
}
function renderPartnersView(main,partners){
  const list=partners.filter(p=>(!pFilter.type||p.type===pFilter.type)&&(!pFilter.status||p.status===pFilter.status)&&(!pFilter.q||(p.name+' '+p.email+' '+p.partner_code).toLowerCase().includes(pFilter.q.toLowerCase())));
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Agents</h1><p>Manage marketing agents, YouTubers, TikTokers and agencies.</p></div>
  <div class="actions"><button class="btn dark" id="addPartner">+ Add agent</button></div></div>
  <div class="section-box"><div class="toolbar"><h2>Agent directory</h2>
    <div class="filters">
      <input id="pq" placeholder="Search name, email or ID…" value="${esc(pFilter.q)}">
      <select id="ptype"><option value="">All types</option>${Object.entries(TYPE_LABELS).map(([k,v])=>`<option value="${k}" ${pFilter.type===k?'selected':''}>${v}</option>`).join('')}</select>
      <select id="pstatus"><option value="">All status</option>${Object.entries(PARTNER_STATUS).map(([k,v])=>`<option value="${k}" ${pFilter.status===k?'selected':''}>${v[0]}</option>`).join('')}</select>
    </div></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>ID</th><th>Agent</th><th>Type</th><th>Projects</th><th>Total Users</th><th>Total Income</th><th>Paid</th><th>Balance</th><th>Note</th><th>Status</th><th></th></tr></thead>
  <tbody>${list.length?list.map(p=>`<tr>
    <td><b>${esc(p.partner_code)}</b></td>
    <td><div class="partner"><div class="avatar">${esc(initials(p.name))}</div><div><b>${esc(p.name)}</b><small>${esc(p.email)}</small></div></div></td>
    <td>${TYPE_LABELS[p.type]||p.type}</td><td>${p.projects}</td><td>${num(p.acquired_users).toLocaleString()}</td>
    <td>${money(p.income)}</td><td>${money(p.paid)}</td><td><b>${money(p.balance)}</b></td>
    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.note||'')}">${esc(p.note||'—')}</td>
    <td>${pill(PARTNER_STATUS,p.status)}</td>
    <td class="actions-cell"><button class="btn small" data-view="${p.id}">View</button><button class="btn small" data-edit="${p.id}">Edit</button><button class="btn small danger" data-del="${p.id}">×</button></td>
  </tr>`).join(''):'<tr><td colspan="11" class="empty">No partners found.</td></tr>'}</tbody></table></div></div>`;
  $('#addPartner').onclick=()=>partnerModal(null,partners);
  $('#pq').oninput=e=>{pFilter.q=e.target.value;renderPartnersView(main,partners)};
  $('#ptype').onchange=e=>{pFilter.type=e.target.value;renderPartnersView(main,partners)};
  $('#pstatus').onchange=e=>{pFilter.status=e.target.value;renderPartnersView(main,partners)};
  main.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>partnerViewModal(partners.find(x=>x.id===b.dataset.view)));
  main.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const p=partners.find(x=>x.id===b.dataset.edit);partnerModal(p,partners)});
  main.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this agent and all their allocations/payments?'))return;try{await mutate('partners/'+b.dataset.del,{method:'DELETE'});toast('Agent deleted.');renderAdmin()}catch(e){toast(e.message)}});
}
function partnerModal(p,all){
  const accounts=(p?.accounts&&p.accounts.length?p.accounts:[{label:'',url:''}]);
  const ov=modal(`
    <h2>${p?'Edit agent':'Add agent'}</h2>
    <p>${p?'Partner #'+esc(p.partner_code):'A unique 4-digit Agent ID will be generated automatically.'}</p>
    <div class="field-row">
      <div class="field"><label>Name</label><input id="fName" value="${esc(p?.name||'')}" placeholder="Full name / agency"></div>
      <div class="field"><label>Email</label><input id="fEmail" type="email" value="${esc(p?.email||'')}" placeholder="partner@email.com"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Phone number</label><input id="fPhone" value="${esc(p?.phone||'')}" placeholder="+880…"></div>
      <div class="field"><label>Type</label><select id="fType">${Object.entries(TYPE_LABELS).map(([k,v])=>`<option value="${k}" ${p?.type===k?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Address</label><input id="fAddress" value="${esc(p?.address||'')}" placeholder="Street, city"></div>
    <div class="field"><label>Social / account information <small>(up to 5)</small></label><div id="acctBox"></div>
      <button class="btn small" id="addAcct" type="button">+ Add URL</button></div>
    <div class="field"><label>Password ${p?'<small>(leave blank to keep current)</small>':''}</label><input id="fPass" type="password" placeholder="Minimum 6 characters"></div>
    <div class="field-row">
      <div class="field"><label>Login access</label><select id="fAccess"><option value="yes" ${p?.login_access!==false?'selected':''}>Yes</option><option value="no" ${p?.login_access===false?'selected':''}>No</option></select></div>
      <div class="field"><label>Status</label><select id="fStatus">${Object.entries(PARTNER_STATUS).map(([k,v])=>`<option value="${k}" ${p?.status===k?'selected':''}>${v[0]}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Note</label><textarea id="fNote" rows="2" placeholder="Optional note…">${esc(p?.note||'')}</textarea></div>
    <div class="field"><label>Financial summary <small>(auto-calculated — read only)</small></label>
      <div class="kv"><span>Projects</span><b>${p?.projects??0}</b><span>Total acquired users</span><b>${num(p?.acquired_users).toLocaleString()}</b><span>Total income</span><b>${money(p?.income)}</b><span>Paid</span><b>${money(p?.paid)}</b><span>Remaining balance</span><b>${money(p?.balance)}</b></div></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="fSave">${p?'Save changes':'Add agent'}</button></div>`);
  const box=ov.querySelector('#acctBox');
  const addRow=(a={label:'',url:''})=>{
    if(box.children.length>=5){toast('Maximum 5 account URLs.');return}
    const r=document.createElement('div');r.className='acct-row';
    r.innerHTML=`<input placeholder="Label (YouTube…)" value="${esc(a.label)}"><input placeholder="https://…" value="${esc(a.url)}"><button class="btn small danger" type="button">×</button>`;
    r.querySelector('button').onclick=()=>r.remove();box.append(r);
  };
  accounts.forEach(addRow);
  ov.querySelector('#addAcct').onclick=()=>addRow();
  ov.querySelector('#fSave').onclick=async()=>{
    const accountsList=[...box.querySelectorAll('.acct-row')].map(r=>({label:r.children[0].value,url:r.children[1].value})).filter(a=>a.label.trim()||a.url.trim());
    const payload={name:ov.querySelector('#fName').value,email:ov.querySelector('#fEmail').value,phone:ov.querySelector('#fPhone').value,
      type:ov.querySelector('#fType').value,address:ov.querySelector('#fAddress').value,accounts:accountsList,password:ov.querySelector('#fPass').value||undefined,
      login_access:ov.querySelector('#fAccess').value==='yes',status:ov.querySelector('#fStatus').value,note:ov.querySelector('#fNote').value};
    try{
      if(p){await mutate('partners/'+p.id,{method:'PATCH',body:JSON.stringify(payload)});toast('Agent updated.')}
      else{const r=await mutate('partners',{method:'POST',body:JSON.stringify(payload)});ov.remove();modal(`<h2>Agent created</h2><p>Share these credentials with the agent.</p><div class="kv"><span>Agent ID</span><b style="font-size:20px">${esc(r.partner_code)}</b><span>Email</span><b>${esc(r.email)}</b><span>Login</span><b>Agent ID or email + password</b></div><div class="modal-actions"><button class="btn dark" data-close>Done</button></div>`);toast('Agent added — ID '+r.partner_code);renderAdmin();return}
      ov.remove();renderAdmin();
    }catch(e){toast(e.message)}
  };
}

/* ---------- ADMIN: PROJECTS ---------- */
async function aProjects(main){
  const projects=await need(main,'projects','projects');
  if(projects)renderProjectsView(main,projects);
}
function renderProjectsView(main,projects){
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Projects</h1><p>Track project targets, assigned partners, user acquisition and budget.</p></div>
  <div class="actions"><button class="btn dark" id="addProject">+ Add project</button></div></div>
  <div class="project-grid">${projects.length?projects.map(p=>`
    <div class="project-card"><div class="detail-head"><div><h3>${esc(p.name)}</h3><p>${esc(p.details||'')}</p></div>${projPill(p.status)}</div>
      <div class="meta"><span>Budget</span><b>${money(p.budget)}</b></div>
      <div class="meta"><span>Start date</span><b>${p.start_date?fmtDate(p.start_date):'—'}</b></div>
      <div class="meta"><span>Deadline</span><b>${p.deadline?fmtDate(p.deadline):'—'}</b></div>
      <div class="meta"><span>Used budget <small>(auto)</small></span><b>${money(p.used_budget)}</b></div>
      <div class="meta"><span>Remaining budget</span><b>${money(p.remaining_budget)}</b></div>
      ${(p.categories||[]).length?(p.categories||[]).map(c=>`<div class="meta"><span>Target ${catLabel(c.category).toLowerCase()}</span><b>${num(c.target).toLocaleString()}</b></div>
      <div class="meta"><span>Acquired ${catLabel(c.category).toLowerCase()}</span><b>${num(c.acquired).toLocaleString()}</b></div>`).join(''):'<div class="meta"><span>Allocations</span><b>None yet</b></div>'}
      <div class="progress-lg"><i style="width:${pct(num(p.acquired_users),num(p.target_users))}%"></i></div>
      <div class="meta"><span>${pct(num(p.acquired_users),num(p.target_users))}% achieved</span><span>${p.partner_count} agents</span></div>
      <div style="margin-top:12px;display:flex;gap:6px"><button class="btn small" data-edit="${p.id}">Edit</button><button class="btn small danger" data-del="${p.id}">×</button></div>
    </div>`).join(''):'<div class="empty" style="grid-column:1/-1">No projects yet.</div>'}</div>`;
  $('#addProject').onclick=()=>projectModal(null);
  main.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>projectModal(projects.find(x=>x.id===b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this project and its allocations/payments?'))return;try{await mutate('projects/'+b.dataset.del,{method:'DELETE'});toast('Project deleted.');renderAdmin()}catch(e){toast(e.message)}});
}
function projectModal(p){
  const ov=modal(`
    <h2>${p?'Edit project':'Add project'}</h2>
    <p>Target users, acquired users and used budget are calculated automatically from allocations.</p>
    <div class="field"><label>Project name</label><input id="jName" value="${esc(p?.name||'')}" placeholder="e.g. Crypto Exchange Launch"></div>
    <div class="field"><label>Details</label><textarea id="jDetails" rows="3" placeholder="What is this project about?">${esc(p?.details||'')}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Budget</label><input id="jBudget" type="number" min="0" step="50" value="${num(p?.budget)}"></div>
      <div class="field"><label>Status</label><select id="jStatus"><option value="active" ${p?.status!=='inactive'?'selected':''}>Active</option><option value="inactive" ${p?.status==='inactive'?'selected':''}>Inactive</option></select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Start date</label><input id="jStart" type="date" value="${esc(p?.start_date||'')}"></div>
      <div class="field"><label>Deadline</label><input id="jDeadline" type="date" value="${esc(p?.deadline||'')}"></div>
    </div>
    <div class="field"><label>Note</label><input id="jNote" value="${esc(p?.note||'')}"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="jSave">${p?'Save changes':'Add project'}</button></div>`);
  ov.querySelector('#jSave').onclick=async()=>{
    const payload={name:ov.querySelector('#jName').value,details:ov.querySelector('#jDetails').value,budget:num(ov.querySelector('#jBudget').value),start_date:ov.querySelector('#jStart').value||null,deadline:ov.querySelector('#jDeadline').value||null,status:ov.querySelector('#jStatus').value,note:ov.querySelector('#jNote').value};
    try{
      if(p)await mutate('projects/'+p.id,{method:'PATCH',body:JSON.stringify(payload)});
      else await mutate('projects',{method:'POST',body:JSON.stringify(payload)});
      ov.remove();toast(p?'Project updated.':'Project added.');renderAdmin();
    }catch(e){toast(e.message)}
  };
}

/* ---------- ADMIN: PAYMENTS ---------- */
let payFilterQ='';
async function aPayments(main){
  const r=await needData(main,'payments',['payments','partners','allocations','withdrawals']);
  if(r)renderPaymentsView(main,r[0],r[1],r[2],r[3]);
}
function renderPaymentsView(main,payments,partners,allocations,withdrawals){
  withdrawals=withdrawals||[];
  const list=payments.filter(p=>!payFilterQ||(p.partner_name+' '+p.project_name).toLowerCase().includes(payFilterQ.toLowerCase()));
  const wdMethod=w=>w.method==='bkash'?'bKash':w.method==='nagad'?'Nagad':'Crypto — USDT (TRC20)';
  const wdDest=w=>w.method==='crypto_usdt'?w.wallet_address:w.account_number;
  const wdType=w=>w.method==='crypto_usdt'?'Wallet':w.account_type==='agent'?'Agent number':'Personal number';
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Payments</h1><p>Pick an agent, review their projects &amp; history, then pay — paid amounts add to commission automatically.</p></div>
  <div class="actions"><button class="btn dark" id="addPay">+ Add payment</button></div></div>
  <div class="two">
    <div class="section-box" style="margin-top:0"><div class="toolbar"><h2>Payouts</h2><div class="filters"><input id="payq" placeholder="Search agent or project…" value="${esc(payFilterQ)}"></div></div>
    <div style="overflow:auto"><table class="view-table"><thead><tr><th>Payment ID</th><th>Date</th><th>Agent</th><th>Project</th><th>Start</th><th>Deadline</th><th>Amount</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.length?list.map(p=>`<tr>
      <td><b>${esc(String(p.id).slice(0,8).toUpperCase())}</b></td><td>${fmtDate(p.payment_date)}</td>
      <td><div class="partner"><div class="avatar">${esc(initials(p.partner_name))}</div><div><b>${esc(p.partner_name)}</b><small>#${esc(p.partner_code)}</small></div></div></td>
      <td>${esc(p.project_name)}</td><td>${p.start_date?fmtDate(p.start_date):'—'}</td><td>${p.deadline?fmtDate(p.deadline):'—'}</td><td><b>${money(p.amount)}</b></td>
      <td>${pill(PAY_STATUS,p.status)}</td>
      <td class="actions-cell">${p.status!=='paid'?`<button class="btn small" data-paid="${p.id}">Mark paid</button>`:''}<button class="btn small danger" data-del="${p.id}">×</button></td>
    </tr>`).join(''):'<tr><td colspan="9" class="empty">No payments yet.</td></tr>'}</tbody></table></div></div>

    <div class="section-box" style="margin-top:0"><div class="toolbar"><h2>Withdraw requests</h2><span class="muted">${withdrawals.filter(w=>w.status==='pending').length} pending</span></div>
    <div style="overflow:auto"><table class="view-table"><thead><tr><th>ID</th><th>Date</th><th>Agent</th><th>Method</th><th>Type</th><th>Number / Address</th><th>Amount</th><th>Provider</th><th>Trx</th><th>Status</th><th></th></tr></thead>
    <tbody>${withdrawals.length?withdrawals.map(w=>`<tr>
      <td><b>${esc(String(w.id).slice(0,8).toUpperCase())}</b></td><td>${fmtDate(w.created_at)}</td>
      <td><div class="partner"><div class="avatar">${esc(initials(w.partner_name))}</div><div><b>${esc(w.partner_name)}</b><small>#${esc(w.partner_code)}</small></div></div></td>
      <td>${wdMethod(w)}</td><td>${wdType(w)}</td><td>${esc(wdDest(w)||'—')}</td><td><b>${money(w.amount)}</b></td>
      <td>${esc(w.provider_number||'—')}</td><td>${esc(w.trx||'—')}</td>
      <td>${pill(WD_STATUS,w.status)}${w.status==='rejected'&&w.reject_reason?`<small class="muted" style="display:block;margin-top:3px">${esc(w.reject_reason)}</small>`:''}</td>
      <td class="actions-cell">${w.status==='pending'?`<button class="btn small" data-wacc="${w.id}">Accept</button><button class="btn small danger" data-wrej="${w.id}">Reject</button>`:''}</td>
    </tr>`).join(''):'<tr><td colspan="11" class="empty">No withdrawal requests.</td></tr>'}</tbody></table></div></div>
  </div>`;
  $('#addPay').onclick=()=>paymentModal(partners,allocations,payments);
  $('#payq').oninput=e=>{payFilterQ=e.target.value;renderPaymentsView(main,payments,partners,allocations,withdrawals)};
  main.querySelectorAll('[data-paid]').forEach(b=>b.onclick=async()=>{try{await mutate('payments/'+b.dataset.paid,{method:'PATCH',body:JSON.stringify({status:'paid'})});toast('Payment marked as paid — commission updated.');renderAdmin()}catch(e){toast(e.message)}});
  main.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this payment? Its commission (if paid) will be removed too.'))return;try{await mutate('payments/'+b.dataset.del,{method:'DELETE'});toast('Payment deleted.');renderAdmin()}catch(e){toast(e.message)}});
  main.querySelectorAll('[data-wacc]').forEach(b=>b.onclick=()=>withdrawAcceptModal(withdrawals.find(w=>w.id===b.dataset.wacc)));
  main.querySelectorAll('[data-wrej]').forEach(b=>b.onclick=async()=>{
    const reason=prompt('Reason for rejection (optional):');if(reason===null)return;
    try{await mutate('withdrawals/'+b.dataset.wrej,{method:'PATCH',body:JSON.stringify({action:'reject',reason})});toast('Withdrawal rejected.');renderAdmin()}catch(e){toast(e.message)}
  });
}
function withdrawAcceptModal(w){
  if(!w)return;
  const ov=modal(`<h2>Accept withdrawal</h2>
    <p><b>${esc(w.partner_name)}</b> · ${money(w.amount)} via ${w.method==='bkash'?'bKash':w.method==='nagad'?'Nagad':'USDT TRC20'} (${esc(w.method==='crypto_usdt'?w.wallet_address:w.account_number)})</p>
    <div class="field"><label>Provider number</label><input id="wProv" placeholder="e.g. agent/shop number used to send"></div>
    <div class="field"><label>Transaction ID (trx)</label><input id="wTrx" placeholder="e.g. TRX-8801"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="wGo">Accept &amp; save</button></div>`);
  ov.querySelector('#wGo').onclick=async()=>{
    const provider=ov.querySelector('#wProv').value.trim(),trx=ov.querySelector('#wTrx').value.trim();
    if(!provider)return toast('Provider number is required.');
    if(!trx)return toast('Transaction ID (trx) is required.');
    const btn=ov.querySelector('#wGo');btn.disabled=true;btn.textContent='Saving…';
    try{await mutate('withdrawals/'+w.id,{method:'PATCH',body:JSON.stringify({action:'accept',provider_number:provider,trx})});ov.remove();toast('Withdrawal accepted.');renderAdmin()}
    catch(e){toast(e.message);btn.disabled=false;btn.textContent='Accept & save'}
  };
}
/* ---------- ADMIN: ADD PAYMENT (agent picker) ---------- */
function paymentModal(partners,allocations,payments){
  const ov=modal(`
    <h2>Add payment</h2>
    <p>Pick an agent on the left — their profile, project commissions and payment history show on the right.</p>
    <div class="pickwrap">
      <aside class="pickside">
        <input id="pkSearch" class="search" style="width:100%" placeholder="Search agent or ID…">
        <div class="picklist" id="pkList"></div>
      </aside>
      <section class="pickmain" id="pkMain"><div class="empty">Select an agent to continue.</div></section>
    </div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`,'wide');
  let selected=null,q='';
  const paintList=()=>{
    const list=partners.filter(p=>!q||(p.name+' '+p.partner_code+' '+p.email).toLowerCase().includes(q.toLowerCase()));
    ov.querySelector('#pkList').innerHTML=list.length?list.map(p=>`<div class="pickitem${selected===p.id?' active':''}" data-pk="${p.id}">
      <div class="avatar">${esc(initials(p.name))}</div>
      <div><b>${esc(p.name)}</b><small>#${esc(p.partner_code)} · ${TYPE_LABELS[p.type]||p.type}</small></div>
    </div>`).join(''):'<div class="empty" style="padding:18px">No agent found.</div>';
    ov.querySelectorAll('[data-pk]').forEach(el=>el.onclick=()=>{selected=el.dataset.pk;q=ov.querySelector('#pkSearch').value;paintList();paintMain()});
  };
  const paintMain=()=>{
    const p=partners.find(x=>x.id===selected);
    if(!p){ov.querySelector('#pkMain').innerHTML='<div class="empty">Select an agent to continue.</div>';return}
    const myAllocs=allocations.filter(a=>a.partner_id===p.id);
    const myPays=payments.filter(x=>x.partner_id===p.id);
    ov.querySelector('#pkMain').innerHTML=`
    <div class="kv" style="margin-bottom:4px">
      <span>Agent ID</span><b>#${esc(p.partner_code)}</b>
      <span>Name</span><b>${esc(p.name)}</b>
      <span>Email</span><b>${esc(p.email)}</b>
      <span>Phone</span><b>${esc(p.phone||'—')}</b>
      <span>Address</span><b>${esc(p.address||'—')}</b>
      <span>Type</span><b>${TYPE_LABELS[p.type]||p.type}</b>
      <span>Status</span><b>${pill(PARTNER_STATUS,p.status)}</b>
      <span>Balance</span><b>${money(p.balance)}</b>
    </div>
    <div class="section-head" style="margin-top:10px"><h2>Projects</h2><span class="muted">Target · acquired · commission (auto)</span></div>
    ${myAllocs.length?myAllocs.map(a=>`<div class="target-row">
      <b>${esc(a.project_name)} <span class="pill blue">${catLabel(a.category)}</span></b>
      <span>Target ${num(a.assigned_target).toLocaleString()}</span>
      <span>Acquired ${num(a.acquired_users).toLocaleString()}</span>
      <span class="right"><b>${money(a.commission)}</b></span>
    </div>`).join(''):'<p class="muted" style="font-size:12px">No allocations for this agent.</p>'}
    <div class="section-head" style="margin-top:12px"><h2>Previous payments</h2><span class="muted">${myPays.length} total</span></div>
    <div style="overflow:auto;max-height:180px"><table class="view-table"><thead><tr><th>Payment ID</th><th>Date</th><th>Project</th><th>Start</th><th>Deadline</th><th>Amount</th><th>Status</th></tr></thead>
    <tbody>${myPays.length?myPays.map(x=>`<tr><td><b>${esc(String(x.id).slice(0,8).toUpperCase())}</b></td><td>${fmtDate(x.payment_date)}</td><td>${esc(x.project_name)}</td><td>${x.start_date?fmtDate(x.start_date):'—'}</td><td>${x.deadline?fmtDate(x.deadline):'—'}</td><td>${money(x.amount)}</td><td>${pill(PAY_STATUS,x.status)}</td></tr>`).join(''):'<tr><td colspan="7" class="empty">No previous payments.</td></tr>'}</tbody></table></div>
    <div class="payform">
      <div class="section-head" style="margin:0 0 10px"><h2>New payment</h2><span class="muted">Amount is added to the selected project's commission</span></div>
      <div class="field-row">
        <div class="field"><label>Project</label><select id="pkProject"><option value="">Select project…</option>${myAllocs.map(a=>`<option value="${a.id}">${esc(a.project_name)} · ${catLabel(a.category)} · ${money(a.commission)} commission</option>`).join('')}</select></div>
        <div class="field"><label>Status</label><select id="pkStatus"><option value="pending">Pending</option><option value="scheduled">Scheduled</option><option value="paid">Paid</option></select></div>
      </div>
      <div class="field"><label>Payment amount ($)</label><input id="pkAmount" type="number" min="0" step="10" placeholder="0"></div>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:8px"><button class="btn dark" id="pkGo">Payment</button></div>
    </div>`;
    const go=ov.querySelector('#pkGo');
    if(!myAllocs.length)go.disabled=true;
    go.onclick=async()=>{
      const projectId=ov.querySelector('#pkProject').value,amount=num(ov.querySelector('#pkAmount').value),status=ov.querySelector('#pkStatus').value;
      if(!projectId)return toast('Select a project.');
      if(amount<=0)return toast('Enter a payment amount.');
      go.disabled=true;go.textContent='Saving…';
      try{
        await mutate('payments',{method:'POST',body:JSON.stringify({allocation_id:projectId,partner_id:selected,amount,status})});
        ov.remove();toast('Payment saved — commission updated.');renderAdmin();
      }catch(e){toast(e.message);go.disabled=false;go.textContent='Payment'}
    };
  };
  ov.querySelector('#pkSearch').oninput=e=>{q=e.target.value;paintList()};
  paintList();
}

/* ---------- ADMIN: ALLOCATIONS ---------- */
let aFilterQ='';
async function aAllocations(main){
  const bundle=await needData(main,'allocations',['allocations','projects','partners','team-allocations']);
  if(bundle)renderAllocationsView(main,bundle[0],bundle[1],bundle[2],bundle[3]);
}
function renderAllocationsView(main,allocs,projects,partners,teamAllocs=[]){
  const list=allocs.filter(a=>!aFilterQ||(a.partner_name+' '+a.project_name).toLowerCase().includes(aFilterQ.toLowerCase()));
  const agree=partners.filter(p=>p.status==='agree');
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Allocations</h1><p>Assign project targets to agents. Acquired &amp; commission fill automatically from contributions and payments.</p></div>
  <div class="actions"><button class="btn dark" id="addAlloc">+ Add allocation</button></div></div>
  <div class="section-box"><div class="toolbar"><h2>Allocation table</h2><div class="filters"><input id="aq" placeholder="Search project or agent…" value="${esc(aFilterQ)}"></div></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>Project</th><th>Category</th><th>Agent</th><th>Start</th><th>Deadline</th><th>Assigned target</th><th>Users acquired <small>(auto)</small></th><th>Commission <small>(auto)</small></th><th>Progress</th><th>Status</th><th></th></tr></thead>
  <tbody>${list.length?list.map(a=>`<tr>
    <td>${esc(a.project_name)}</td>
    <td><span class="pill blue">${catLabel(a.category)}</span></td>
    <td><div class="partner"><div class="avatar">${esc(initials(a.partner_name))}</div><div><b>${esc(a.partner_name)}</b><small>#${esc(a.partner_code)}</small></div></div></td>
    <td>${a.start_date?fmtDate(a.start_date):'—'}</td><td>${a.deadline?fmtDate(a.deadline):'—'}</td>
    <td>${num(a.assigned_target).toLocaleString()}</td><td><b>${num(a.acquired_users).toLocaleString()}</b></td><td>${money(a.commission)}</td>
    <td style="min-width:120px"><div style="font-size:10px;margin-bottom:4px">${pct(num(a.acquired_users),num(a.assigned_target))}%</div><div class="progress"><i style="width:${pct(num(a.acquired_users),num(a.assigned_target))}%"></i></div></td>
    <td>${pill(ALLOC_STATUS,a.status)}</td>
    <td class="actions-cell"><button class="btn small" data-edit="${a.id}">Edit</button><button class="btn small danger" data-del="${a.id}">×</button></td>
  </tr>`).join(''):'<tr><td colspan="11" class="empty">No allocations yet.</td></tr>'}</tbody></table></div></div>
  <div class="section-box"><div class="toolbar"><h2>Agent team allocations</h2><span class="muted">How agents split their targets among their team members</span></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>Project</th><th>Category</th><th>Agent</th><th>Team member</th><th>Assigned target</th><th>Acquired</th><th>Status</th></tr></thead>
  <tbody>${teamAllocs.length?teamAllocs.map(t=>`<tr>
    <td>${esc(t.project_name)}</td>
    <td><span class="pill blue">${catLabel(t.category)}</span></td>
    <td><div class="partner"><div class="avatar">${esc(initials(t.partner_name))}</div><div><b>${esc(t.partner_name)}</b><small>#${esc(t.partner_code)}</small></div></div></td>
    <td><div class="partner"><div class="avatar">${esc(initials(t.member_name))}</div><div><b>${esc(t.member_name)}</b><small>#${esc(t.member_code)}</small></div></div></td>
    <td>${num(t.assigned_target).toLocaleString()}</td>
    <td><b>${num(t.acquired_users).toLocaleString()}</b></td>
    <td>${pill(ALLOC_STATUS,t.status)}</td>
  </tr>`).join(''):'<tr><td colspan="7" class="empty">No team allocations yet.</td></tr>'}</tbody></table></div></div>`;
  $('#addAlloc').onclick=()=>allocationModal(null,projects,agree);
  $('#aq').oninput=e=>{aFilterQ=e.target.value;renderAllocationsView(main,allocs,projects,partners)};
  main.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>allocationModal(allocs.find(x=>x.id===b.dataset.edit),projects,agree));
  main.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this allocation?'))return;try{await mutate('allocations/'+b.dataset.del,{method:'DELETE'});toast('Allocation deleted.');renderAdmin()}catch(e){toast(e.message)}});
}
function allocationModal(a,projects,agreePartners){
  const editable=!!a;
  const ov=modal(`
    <h2>${editable?'Edit allocation':'Add allocation'}</h2>
    <p>${editable?'Only the assigned target, status and note can be changed.':'Link an agreeing agent to a project with a target.'} Acquired counts and commission fill <b>automatically</b> from contributions and payments.</p>
    <div class="field"><label>Project</label><select id="lProject" ${editable?'disabled':''}><option value="">Select project…</option>${projects.map(p=>`<option value="${p.id}" ${a?.project_id===p.id?'selected':''}>${esc(p.name)}${p.status!=='active'?' (inactive)':''}</option>`).join('')}</select></div>
    <div class="field"><label>Agent <small>${editable?'':'(only agents with status “Agree” are listed)'}</small></label><select id="lPartner" ${editable?'disabled':''}><option value="">Select agent…</option>${agreePartners.map(p=>`<option value="${p.id}" ${a?.partner_id===p.id?'selected':''}>${esc(p.name)} · #${esc(p.partner_code)}</option>`).join('')}</select></div>
    <div class="field"><label>Category <small>(what the target counts)</small></label><select id="lCategory" ${editable?'disabled':''}>${CATEGORIES.map(c=>`<option value="${c}" ${a?.category===c?'selected':''}>${catLabel(c)}</option>`).join('')}</select></div>
    ${editable?`<div class="kv" style="margin-bottom:12px"><span>Users acquired (auto)</span><b>${num(a.acquired_users).toLocaleString()}</b><span>Commission (auto)</span><b>${money(a.commission)}</b></div>`:''}
    <div class="field-row"><div class="field"><label>Start date</label><input id="lStart" type="date" value="${esc(a?.start_date||'')}"></div><div class="field"><label>Deadline</label><input id="lDeadline" type="date" value="${esc(a?.deadline||'')}"></div></div>
    <div class="field"><label>Assigned target</label><input id="lTarget" type="number" min="0" value="${num(a?.assigned_target)}"></div>
    <div class="field"><label>Status</label><select id="lStatus">${Object.entries(ALLOC_STATUS).map(([k,v])=>`<option value="${k}" ${a?.status===k?'selected':''}>${v[0]}</option>`).join('')}</select></div>
    <div class="field"><label>Note</label><input id="lNote" value="${esc(a?.note||'')}"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="lSave">${editable?'Save changes':'Add allocation'}</button></div>`);
  ov.querySelector('#lSave').onclick=async()=>{
    const projectId=ov.querySelector('#lProject').value,partnerId=ov.querySelector('#lPartner').value,category=ov.querySelector('#lCategory').value;
    const payload={assigned_target:Math.round(num(ov.querySelector('#lTarget').value)),start_date:ov.querySelector('#lStart').value||null,deadline:ov.querySelector('#lDeadline').value||null,status:ov.querySelector('#lStatus').value,note:ov.querySelector('#lNote').value};
    try{
      if(editable)await mutate('allocations/'+a.id,{method:'PATCH',body:JSON.stringify(payload)});
      else await mutate('allocations',{method:'POST',body:JSON.stringify({project_id:projectId,partner_id:partnerId,category,...payload})});
      ov.remove();toast(editable?'Allocation updated.':'Allocation added.');renderAdmin();
    }catch(e){toast(e.message)}
  };
}

/* ---------- ADMIN: CONTRIBUTE ---------- */

async function aContribute(main){
  const rows=await need(main,'contribute','contributions');
  if(rows)renderAContribute(main,rows);
}
function renderAContribute(main,rows){
  const count=k=>rows.filter(r=>r.status===k).length;
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Contribute</h1><p>Agent contribution requests — accept to add acquired users automatically.</p></div></div>
  <div class="kpi-grid">
    <div class="card stat"><div><div class="label">Pending</div><div class="value">${count('pending')}</div></div></div>
    <div class="card stat"><div><div class="label">Accepted</div><div class="value">${count('accepted')}</div></div></div>
    <div class="card stat"><div><div class="label">Rejected</div><div class="value">${count('rejected')}</div></div></div>
  </div>
  <div class="section-box"><div class="toolbar"><h2>All contribution requests</h2><span class="muted">Every agent · newest first</span></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>ID</th><th>Date &amp; time</th><th>Agent</th><th>Project</th><th>Category</th><th>Start</th><th>Deadline</th><th>Acquired</th><th>Proof</th><th>Note</th><th>Status</th><th>Review</th><th></th></tr></thead>
  <tbody>${rows.length?rows.map(c=>`<tr>
    <td><b>${esc(c.code||String(c.id).slice(0,6))}</b></td>
    <td>${fmtDT(c.created_at)}</td>
    <td><div class="partner"><div class="avatar">${esc(initials(c.partner_name))}</div><div><b>${esc(c.partner_name)}</b><small>#${esc(c.partner_code)}</small></div></div></td>
    <td>${esc(c.project_name)}</td><td><span class="pill blue">${catLabel(c.category)}</span></td><td>${c.start_date?fmtDate(c.start_date):'—'}</td><td>${c.deadline?fmtDate(c.deadline):'—'}</td><td><b>+${num(c.acquired).toLocaleString()}</b></td>
    <td>${filesCell(c.files)}</td>
    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.note||'')}">${esc(c.note||'—')}</td>
    <td>${pill(CONTRIB_STATUS,c.status)}</td>
    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.review_note||'')}">${c.reviewed_at?esc(c.review_note||'—'):'—'}</td>
    <td class="actions-cell">${c.status==='pending'?`<button class="btn small" data-accept="${c.id}" data-n="${num(c.acquired)}">Accept</button><button class="btn small danger" data-reject="${c.id}">Reject</button>`:''}</td>
  </tr>`).join(''):'<tr><td colspan="13" class="empty">No contribution requests yet.</td></tr>'}</tbody></table></div></div>`;
  main.querySelectorAll('[data-files]').forEach(b=>b.onclick=()=>filesModal(JSON.parse(b.dataset.files)));
  main.querySelectorAll('[data-accept]').forEach(b=>b.onclick=async()=>{
    if(!confirm(`Accept this contribution? ${b.dataset.n} users will be added to the allocation's Users acquired automatically.`))return;
    try{await mutate('contributions/'+b.dataset.accept,{method:'PATCH',body:JSON.stringify({action:'accept'})});toast('Contribution accepted — acquired users updated.');renderAdmin()}catch(e){toast(e.message)}
  });
  main.querySelectorAll('[data-reject]').forEach(b=>b.onclick=async()=>{
    const note=prompt('Optional reason for rejection:');if(note===null)return;
    try{await mutate('contributions/'+b.dataset.reject,{method:'PATCH',body:JSON.stringify({action:'reject',note})});toast('Contribution rejected.');renderAdmin()}catch(e){toast(e.message)}
  });
}

/* ---------- ADMIN: PARTNER VIEW MODAL (details + edit history) ---------- */
function partnerViewModal(p){
  const ov=modal(`<h2>${esc(p.name)}</h2><p>Agent #${esc(p.partner_code)} — profile details &amp; edit history</p>
    <div id="pvBody">${loaderHtml("Loading…")}</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  api(`partners/${p.id}/logs`).then(d=>{
    const me=d.partner,accts=me.accounts||[];
    ov.querySelector('#pvBody').innerHTML=`
    <div class="kv">
      <span>Agent ID</span><b>#${esc(me.partner_code)}</b>
      <span>Name</span><b>${esc(me.name)}</b>
      <span>Email</span><b>${esc(me.email)}</b>
      <span>Phone</span><b>${esc(me.phone||'—')}</b>
      <span>Address</span><b>${esc(me.address||'—')}</b>
      <span>Type</span><b>${TYPE_LABELS[me.type]||me.type}</b>
      <span>Status</span><b>${pill(PARTNER_STATUS,me.status)}</b>
      <span>Login access</span><b>${me.login_access?'Enabled':'Disabled'}</b>
      <span>Note</span><b>${esc(me.note||'—')}</b>
      <span>Joined</span><b>${fmtDate(me.created_at)}</b>
    </div>
    <div class="section-head" style="margin-top:16px"><h2>Social accounts</h2></div>
    ${accts.length?accts.map(a=>`<div class="target-row"><b>${esc(a.label||'Account')}</b><span style="grid-column:2/5"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a></span></div>`).join(''):'<p class="muted" style="font-size:12px">No social accounts.</p>'}
    <div class="section-head" style="margin-top:16px"><h2>Financial (auto)</h2></div>
    <div class="kv">
      <span>Projects</span><b>${p.projects??0}</b>
      <span>Total acquired users</span><b>${num(p.acquired_users).toLocaleString()}</b>
      <span>Total income</span><b>${money(p.income)}</b>
      <span>Paid</span><b>${money(p.paid)}</b>
      <span>Remaining balance</span><b>${money(p.balance)}</b>
    </div>
    <div class="section-head" style="margin-top:16px"><h2>Payment methods</h2><span class="muted">Withdrawal details</span></div>
    <div style="overflow:auto"><table class="view-table"><thead><tr><th>Method</th><th>Details</th><th>Type</th></tr></thead>
    <tbody>${(d.paymentMethods||[]).length?(d.paymentMethods||[]).map(pm=>`<tr>
      <td><b>${pm.method==='bkash'?'bKash':pm.method==='nagad'?'Nagad':'Crypto — USDT (TRC20)'}</b></td>
      <td>${esc(pm.method==='crypto_usdt'?pm.wallet_address:pm.account_number)}</td>
      <td>${pm.method==='crypto_usdt'?'Wallet':pm.account_type==='agent'?'Agent number':'Personal number'}</td>
    </tr>`).join(''):'<tr><td colspan="3" class="empty">No payment method saved.</td></tr>'}</tbody></table></div>
    <div class="section-head" style="margin-top:16px"><h2>Edit history</h2><span class="muted">Changes made by the agent</span></div>
    <div style="overflow:auto"><table class="view-table"><thead><tr><th>When</th><th>Field</th><th>Old</th><th>New</th></tr></thead>
    <tbody>${d.logs.length?d.logs.map(L=>`<tr><td>${fmtDT(L.created_at)}</td><td><b>${esc(L.field)}</b></td><td class="muted" style="max-width:230px;white-space:pre-line;word-break:break-word">${esc(L.old_value||'—')}</td><td style="max-width:230px;white-space:pre-line;word-break:break-word">${esc(L.new_value||'—')}</td></tr>`).join(''):'<tr><td colspan="4" class="empty">No profile edits recorded yet.</td></tr>'}</tbody></table></div>`;
  }).catch(e=>{ov.querySelector('#pvBody').innerHTML=`<div class="empty">${esc(e.message)}</div>`});
}

/* ---------- ADMIN: VAULTIUM (contribution files) ---------- */
async function aVaultium(main){
  const rows=await need(main,'vaultium','vaultium');
  if(rows)renderVaultium(main,rows);
}
function renderVaultium(main,rows){
  const totalBytes=rows.reduce((a,f)=>a+num(f.file_size),0);
  const month=new Date().toISOString().slice(0,7);
  const thisMonth=rows.filter(f=>String(f.created_at||'').startsWith(month)).length;
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Vaultium</h1><p>Every proof file from contribution requests — stored in the Vaultium R2 bucket.</p></div></div>
  <div class="kpi-grid">
    <div class="card stat"><div><div class="label">Total files</div><div class="value">${rows.length}</div></div></div>
    <div class="card stat"><div><div class="label">Storage used</div><div class="value">${fmtSize(totalBytes)}</div></div></div>
    <div class="card stat"><div><div class="label">Files this month</div><div class="value">${thisMonth}</div></div></div>
  </div>
  <div class="section-box"><div class="toolbar"><h2>All files</h2><span class="muted">Newest first</span></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>File name</th><th>Date &amp; time</th><th>Size</th><th>Type</th><th>Contribution</th><th>Agent</th><th>Project</th><th></th></tr></thead>
  <tbody>${rows.length?rows.map(f=>`<tr>
    <td><b>${esc(f.file_name)}</b></td>
    <td>${fmtDT(f.created_at)}</td>
    <td>${fmtSize(f.file_size)}</td>
    <td>${esc(f.file_type||'—')}</td>
    <td><b>${esc(f.contribution_code||'—')}</b></td>
    <td><div class="partner"><div class="avatar">${esc(initials(f.partner_name))}</div><div><b>${esc(f.partner_name)}</b><small>#${esc(f.partner_code)}</small></div></div></td>
    <td>${esc(f.project_name)}</td>
    <td class="actions-cell"><button class="btn small" data-vopen="${f.id}" data-vname="${esc(f.file_name)}">View</button><button class="btn small" data-vdl="${f.id}" data-vdlname="${esc(f.file_name)}">Download</button><button class="btn small danger" data-vdel="${f.id}">×</button></td>
  </tr>`).join(''):'<tr><td colspan="8" class="empty">No files stored yet.</td></tr>'}</tbody></table></div></div>`;
  main.querySelectorAll('[data-vopen]').forEach(b=>b.onclick=()=>openFile(b.dataset.vopen,b.dataset.vname,false));
  main.querySelectorAll('[data-vdl]').forEach(b=>b.onclick=()=>openFile(b.dataset.dl,b.dataset.dlname,true));
  main.querySelectorAll('[data-vdel]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Delete this file from Vaultium storage?'))return;
    try{await mutate('files/'+b.dataset.vdel,{method:'DELETE'});toast('File deleted.');renderAdmin()}catch(e){toast(e.message)}
  });
}

/* ---------- ADMIN: HELPDESK (live, silent — never wipes the screen) ---------- */
let hdSelected=null, hdConvCache={}, hdUnsub=null;
const hdConvKey=()=>hdSelected?('helpdesk/'+hdSelected.kind+'/'+hdSelected.id):null;
async function aHelpdesk(main){
  const d=await need(main,'helpdesk','helpdesk');
  if(!d||aView!=='helpdesk')return;
  updateHdBadge(d.totalUnread||0);
  if(!hdSelected&&d.threads?.length)hdSelected={kind:d.threads[0].kind,id:d.threads[0].id};
  if(d.mode==='user'&&d.threads?.length)hdSelected={kind:'user',id:d.threads[0].id};
  renderHelpdeskPanel(main,d);
}
function hdThreadsHtml(threads){
  return threads.length?threads.map(t=>`<div class="hditem ${hdSelected&&hdSelected.kind===t.kind&&hdSelected.id===t.id?'on':''}" data-hdkind="${t.kind}" data-hdid="${t.id}">
        <div class="mini">${esc(initials(t.name))}</div><div><b>${esc(t.name)} <small>${t.kind==='agent'?'#'+esc(t.code):esc(t.code||'user')}</small></b><small>${esc((t.last||'').slice(0,70))} · ${fmtDT(t.last_at)}</small></div>${t.unread?`<span class="pill red">${t.unread}</span>`:''}
      </div>`).join(''):'<div class="empty">No conversations yet.</div>';
}
function renderHelpdeskPanel(main,d){
  const threads=d.threads||[], selected=threads.find(t=>hdSelected&&t.kind===hdSelected.kind&&t.id===hdSelected.id);
  const selKey=hdSelected?hdSelected.kind+':'+hdSelected.id:'';
  const shell=$('#hdThreads');
  if(!shell||main.dataset.hdSel!==selKey){                 // first paint or conversation switch
    main.dataset.hdSel=selKey;
    if(hdUnsub){hdUnsub();hdUnsub=null}
    const k=hdConvKey();if(k)hdUnsub=onKey(k,d=>{hdConvCache[selKey]=hdConvHtml(d);paintHdLog()});
    const convHtml=hdConvCache[selKey]||loaderHtml('Loading conversation…');
    main.innerHTML=`
  <div class="top"><div class="title"><h1>HelpDesk</h1><p>${d.mode==='user'?'Chat with the primary administrator.':'Chat with agents and admin-board users.'}</p></div></div>
  <div class="helpdesk2">
    <aside class="hdlist"><div id="hdThreads">${hdThreadsHtml(threads)}</div></aside>
    <section class="hdconversation">
      ${selected?`<div class="hdconvhead"><div><h2>${esc(selected.name)}</h2><p>${selected.kind==='agent'?'Agent #'+esc(selected.code):d.mode==='user'?'Primary administrator':'Board user · '+esc(selected.code||'')}</p></div></div><div class="chat big" id="hdLog">${convHtml}</div><div class="chatbar"><input id="hdInput" placeholder="Write a message…"><button class="btn dark" id="hdSend">Send</button></div>`:'<div class="empty">Select a conversation from the left.</div>'}
    </section>
  </div>`;
    main.querySelectorAll('[data-hdid]').forEach(el=>el.onclick=()=>{hdSelected={kind:el.dataset.hdkind,id:el.dataset.hdid};renderAdmin();loadHelpdeskConversation()});
    if(selected)loadHelpdeskConversation();
    const send=async()=>{const input=$('#hdInput'),text=input.value.trim();if(!text||!hdSelected)return;
      try{input.value='';await mutate('helpdesk/'+hdSelected.kind+'/'+hdSelected.id,{method:'POST',body:JSON.stringify({body:text})});loadHelpdeskConversation()}
      catch(e){toast(e.message);if(input&&!input.value)input.value=text}};
    const sendBtn=$('#hdSend'),inp=$('#hdInput');
    if(sendBtn)sendBtn.onclick=send;
    if(inp)inp.onkeydown=e=>{if(e.key==='Enter')send()};
  }else{                                                   // silent refresh — update only the thread list
    const listHtml=hdThreadsHtml(threads);
    if(shell.innerHTML!==listHtml){
      shell.innerHTML=listHtml;
      main.querySelectorAll('[data-hdid]').forEach(el=>el.onclick=()=>{hdSelected={kind:el.dataset.hdkind,id:el.dataset.hdid};renderAdmin();loadHelpdeskConversation()});
    }
    paintHdLog();
  }
}
function paintHdLog(){
  if(aView!=='helpdesk'||!hdSelected)return;
  const key=hdSelected.kind+':'+hdSelected.id, html=hdConvCache[key], log=$('#hdLog');
  if(!log||html==null)return;
  const stick=log.scrollHeight-log.scrollTop-log.clientHeight<60;
  if(log.innerHTML!==html)log.innerHTML=html;
  if(stick)log.scrollTop=log.scrollHeight;
}
function hdConvHtml(d){
  const name=d.thread?.name||'User';
  return d.messages.length?d.messages.map(m=>{
    const mine=(hdSelected.kind==='agent'&&m.sender_type==='admin')||(hdSelected.kind==='user'&&((state.user.kind==='user'&&m.sender_type==='user')||(state.user.kind!=='user'&&m.sender_type==='owner')));
    const who=mine?'You':name;
    return `<div class="msg ${mine?'me':''}"><p>${esc(m.body)}</p><time>${fmtDT(m.created_at)} · ${esc(who)}</time></div>`;
  }).join(''):'<div class="empty">No messages yet — say hello.</div>';
}
async function loadHelpdeskConversation(){
  if(!hdSelected)return;
  const log=$('#hdLog');if(!log)return;
  const selKey=hdSelected.kind+':'+hdSelected.id;
  try{
    const d=await revalidate('helpdesk/'+hdSelected.kind+'/'+hdSelected.id,{fresh:true}).then(e=>e.data);
    hdConvCache[selKey]=hdConvHtml(d);
    paintHdLog();
  }catch(e){if(!hdConvCache[selKey])log.innerHTML=`<div class="empty">${esc(e.message)}</div>`}
}
function updateHdBadge(n){
  const b=$('#hdBadge');
  if(!b)return;
  b.textContent=n>9?'9+':n;
  b.style.display=n?'inline-block':'none';
}

/* ---------- ADMIN: PERFORMANCE ---------- */

async function aPerformance(main){
  const rows=await need(main,'performance','performance');
  if(rows)renderPerformanceView(main,rows);
}
function renderPerformanceView(main,rows){
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Performance</h1><p>Category-wise achievement per agent and project — ranked automatically.</p></div></div>
  <div class="section-box"><div style="overflow:auto"><table class="view-table"><thead><tr><th>Rank</th><th>Agent</th><th>Project</th><th>Category</th><th>Start</th><th>Deadline</th><th>Assigned</th><th>Acquired</th><th>Achievement</th></tr></thead>
  <tbody>${rows.length?rows.map(r=>`<tr>
    <td><b>#${r.rank}</b></td>
    <td><div class="partner"><div class="avatar">${esc(initials(r.name))}</div><div><b>${esc(r.name)}</b><small>#${esc(r.partner_code)} · ${TYPE_LABELS[r.type]||r.type}</small></div></div></td>
    <td>${esc(r.project_name)}</td><td><span class="pill blue">${catLabel(r.category)}</span></td><td>${r.start_date?fmtDate(r.start_date):'—'}</td><td>${r.deadline?fmtDate(r.deadline):'—'}</td>
    <td>${num(r.assigned).toLocaleString()}</td><td><b>${num(r.acquired).toLocaleString()}</b></td>
    <td style="min-width:140px"><div style="display:flex;justify-content:space-between;font-size:11px"><b>${r.pct}%</b></div><div class="progress"><i style="width:${Math.min(100,r.pct)}%"></i></div></td>
  </tr>`).join(''):'<tr><td colspan="9" class="empty">No performance data yet.</td></tr>'}</tbody></table></div></div>`;
}

/* ---------- ADMIN: SETTINGS ---------- */
function aSettings(main){
  main.innerHTML=`<div class="top"><div class="title"><h1>Settings</h1><p>Workspace settings.</p></div></div>
  <div class="section-box"><div class="empty" style="padding:60px">⚙<br><br><b>Future Development</b><br>Settings will arrive in an upcoming release.</div></div>`;
}



/* ---------- ADMIN: CONNECTX ---------- */
let cxView='compose', cxRecipientType='agent', cxSelected=null, cxContacts=[], cxAttachment=null;
async function aConnectX(main){
  const keys=['connectx/contacts?type='+cxRecipientType,'connectx/messages','connectx/settings'];
  const r=await needData(main,'connectx',keys,{forceFresh:true});
  if(!r)return;
  cxContacts=r[0];
  renderConnectX(main,r[0],r[1],r[2]);
}
function cxStatus(s){return `<span class="cxstatus ${esc(s||'queued')}">${esc(s||'queued')}</span>`}
function renderConnectX(main,contacts,history,settings){
  main.innerHTML=`
  <div class="top"><div class="title"><h1>ConnectX</h1><p>Central mail communication system powered by DoxTox.</p></div></div>
  <div class="connectx">
    <aside class="connectxnav">
      <div class="connectxbrand">✉ ConnectX<small>powered by DoxTox</small></div>
      <button class="${cxView==='compose'?'on':''}" data-cx="compose">Compose</button>
      <button class="${cxView==='history'?'on':''}" data-cx="history">History <small>${history.length}</small></button>
      <button class="${cxView==='settings'?'on':''}" data-cx="settings">Settings</button>
    </aside>
    <section class="connectxmain">${cxView==='compose'?connectXCompose(contacts):cxView==='history'?connectXHistory(history):connectXSettings(settings)}</section>
  </div>`;
  main.querySelectorAll('[data-cx]').forEach(b=>b.onclick=()=>{cxView=b.dataset.cx;renderConnectX(main,contacts,history,settings)});
  if(cxView==='compose')wireConnectXCompose(main);
  else if(cxView==='history')wireConnectXHistory(main,history);
  else wireConnectXSettings(main,settings);
}
function connectXCompose(contacts){
  const selected=contacts.find(x=>x.id===cxSelected);
  return `<div class="cxhead"><div><h2>Compose message</h2><span>Choose recipient type Agent or User, then send email through ConnectX.</span></div></div>
  <div class="cxcompose">
    <div class="cxrecipient">
      <label><span>Recipient type</span><select id="cxType"><option value="agent" ${cxRecipientType==='agent'?'selected':''}>Agent</option><option value="user" ${cxRecipientType==='user'?'selected':''}>User</option></select></label>
      <div class="cxsearch"><input id="cxSearch" class="search" style="width:100%;max-width:none" placeholder="Search ${cxRecipientType}s…"></div>
      <div class="cxlist" id="cxList">${contacts.length?contacts.map(c=>`<div class="cxcontact ${c.id===cxSelected?'on':''}" data-cxpick="${c.id}"><b>${esc(c.name)}</b><span>${esc(c.email)}</span><small>${esc(c.subtitle||c.phone||'')}</small></div>`).join(''):'<div class="empty">No active recipients found.</div>'}</div>
    </div>
    <div class="cxfields">
      <label>To<input id="cxTo" value="${esc(selected?.email||'')}" placeholder="recipient@email.com"></label>
      <div class="cx-mini-actions"><button class="btn small" id="showCc" type="button">+ Add CC</button><button class="btn small" id="showBcc" type="button">+ Add BCC</button></div>
      <label id="cxCcWrap" class="cx-optional" style="display:none">CC <small class="muted">optional, comma separated</small><input id="cxCc" placeholder="cc@email.com"></label>
      <label id="cxBccWrap" class="cx-optional" style="display:none">BCC <small class="muted">optional, comma separated</small><input id="cxBcc" placeholder="bcc@email.com"></label>
      <label>Attachment type<select id="cxAttachType"><option value="">No attachment</option><option value="allocation">Allocation</option><option value="payments">Payments</option><option value="withdraw">Withdraw</option><option value="contribute">Contribute</option><option value="performance">Performance</option></select></label>
      <div id="cxAttachBox" class="cxattachbox" style="display:${cxAttachment?'flex':'none'}">${cxAttachment?`<span><b>${esc(cxAttachment.type)}</b> — ${esc(cxAttachment.title)}</span><button class="btn small danger" id="cxClearAttach" type="button">Remove</button>`:''}</div>
      <label>Subject<input id="cxSubject" placeholder="Subject"></label>
      <label>Message<textarea id="cxBody" rows="9" placeholder="Write your message…"></textarea></label>
      <button class="btn dark" id="cxSend">Send email</button>
    </div>
  </div>`;
}
function connectXHistory(history){
  return `<div class="cxhead"><div><h2>Mail history</h2><span>Latest ConnectX messages sent to agents and users.</span></div><button class="btn" id="cxRefresh">Refresh</button></div>
  <div class="cxsearch"><input id="cxHistSearch" class="search" placeholder="Search subject, email, recipient…"></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>Date</th><th>Recipient type</th><th>Recipient</th><th>To</th><th>Subject</th><th>Status</th><th></th></tr></thead>
  <tbody id="cxHistBody">${history.length?history.map(m=>cxHistoryRow(m)).join(''):'<tr><td colspan="7" class="empty">No ConnectX messages yet.</td></tr>'}</tbody></table></div>`;
}
function connectXSettings(settings){
  return `<div class="cxhead"><div><h2>Settings</h2><span>Configure ConnectX sender identity and provider limits.</span></div></div>
  <div class="cxfields" style="max-width:640px">
    <label>Enable ConnectX<select id="cxSetEnabled"><option value="yes" ${settings.enabled?'selected':''}>Enabled</option><option value="no" ${!settings.enabled?'selected':''}>Disabled</option></select></label>
    <label>From name<input id="cxSetName" value="${esc(settings.from_name||'InfluenceOS')}"></label>
    <label>From email<input id="cxSetEmail" type="email" value="${esc(settings.from_email||'')}"></label>
    <label>Reply-to email <small class="muted">optional</small><input id="cxSetReply" type="email" value="${esc(settings.reply_to||'')}"></label>
    <label>Global daily limit<input id="cxSetLimit" type="number" min="0" step="1" value="${num(settings.global_daily_limit||500)}"></label>
    <div class="section-head" style="margin-top:18px"><h2>Attachment HTML templates</h2><span>Full HTML is supported; scripts/external links are removed for email safety. Use inline CSS for best result.</span></div>
    <label>Allocation template<textarea class="cx-template" id="cxTplAllocation" rows="8">${esc(settings.allocation_template_html||'')}</textarea></label>
    <label>Payments template<textarea class="cx-template" id="cxTplPayments" rows="8">${esc(settings.payments_template_html||'')}</textarea></label>
    <label>Withdraw template<textarea class="cx-template" id="cxTplWithdraw" rows="8">${esc(settings.withdraw_template_html||'')}</textarea></label>
    <label>Contribute template<textarea class="cx-template" id="cxTplContribute" rows="8">${esc(settings.contribute_template_html||'')}</textarea></label>
    <label>Performance template<textarea class="cx-template" id="cxTplPerformance" rows="8">${esc(settings.performance_template_html||'')}</textarea></label>
    <button class="btn dark" id="cxSetSave">Save settings</button>
  </div>`;
}
function cxHistoryRow(m){return `<tr><td>${fmtDT(m.created_at)}</td><td>${esc(m.recipient_type)}</td><td>${esc(m.recipient_name||'—')}</td><td>${esc((m.to_emails||[]).join(', '))}</td><td><b>${esc(m.subject)}</b>${m.error_message?`<small class="muted" style="display:block;color:#c62828">${esc(m.error_message)}</small>`:''}</td><td>${cxStatus(m.status)}</td><td><button class="btn small" data-cxview="${m.id}">View</button></td></tr>`}
function wireConnectXCompose(main){
  $('#showCc').onclick=()=>{$('#cxCcWrap').style.display='block';$('#showCc').style.display='none';$('#cxCc').focus()};
  $('#showBcc').onclick=()=>{$('#cxBccWrap').style.display='block';$('#showBcc').style.display='none';$('#cxBcc').focus()};
  $('#cxType').onchange=async e=>{cxRecipientType=e.target.value;cxSelected=null;cxAttachment=null;cxContacts=await api('connectx/contacts?type='+cxRecipientType,{forceFresh:true});const [hist,set]=await Promise.all([api('connectx/messages',{forceFresh:true}),api('connectx/settings',{forceFresh:true})]);renderConnectX(main,cxContacts,hist,set)};
  $('#cxSearch').oninput=e=>{const q=e.target.value.toLowerCase();$('#cxList').innerHTML=cxContacts.filter(c=>!q||(c.name+' '+c.email+' '+(c.code||'')).toLowerCase().includes(q)).map(c=>`<div class="cxcontact ${c.id===cxSelected?'on':''}" data-cxpick="${c.id}"><b>${esc(c.name)}</b><span>${esc(c.email)}</span><small>${esc(c.subtitle||c.phone||'')}</small></div>`).join('')||'<div class="empty">No recipient found.</div>';wireCxPick()};
  const wireCxPick=()=>document.querySelectorAll('[data-cxpick]').forEach(el=>el.onclick=()=>{cxSelected=el.dataset.cxpick;cxAttachment=null;const c=cxContacts.find(x=>x.id===cxSelected);$('#cxTo').value=c?.email||'';document.querySelectorAll('[data-cxpick]').forEach(x=>x.classList.toggle('on',x===el))});
  wireCxPick();
  if($('#cxClearAttach'))$('#cxClearAttach').onclick=()=>{cxAttachment=null;const box=$('#cxAttachBox');box.style.display='none';box.innerHTML=''};
  $('#cxAttachType').onchange=e=>{if(e.target.value){connectXAttachmentModal(e.target.value);e.target.value=''}};
  $('#cxSend').onclick=async()=>{
    const btn=$('#cxSend');btn.disabled=true;btn.textContent='Sending…';
    try{await mutate('connectx/send',{method:'POST',body:JSON.stringify({recipientType:cxRecipientType,recipientId:cxSelected,to:$('#cxTo').value,cc:$('#cxCc')?.value||'',bcc:$('#cxBcc')?.value||'',subject:$('#cxSubject').value,body:$('#cxBody').value,attachment:cxAttachment,recipientName:cxContacts.find(x=>x.id===cxSelected)?.name||''})});toast('Email sent through ConnectX.');cxView='history';await aConnectX(main)}
    catch(e){toast(e.message);btn.disabled=false;btn.textContent='Send email'}
  };
}
async function connectXAttachmentModal(type){
  if(cxRecipientType!=='agent'||!cxSelected)return toast('Select an agent first to attach allocation, payment, withdraw, contribute or performance details.');
  const agent=cxContacts.find(x=>x.id===cxSelected);
  const ov=modal(`<h2>Attach ${esc(type)} details</h2><p>Select one row for ${esc(agent?.name||'selected agent')} — it will be inserted into the email body.</p>${loaderHtml('Loading '+type+' list…')}`,'wide');
  try{
    let rows=[];
    if(type==='allocation')rows=(await api('allocations')).filter(x=>x.partner_id===cxSelected).map(x=>({title:x.project_name+' · '+catLabel(x.category),data:{'Agent ID':agent?.code||'',Project:x.project_name,Category:catLabel(x.category),Start:x.start_date?fmtDate(x.start_date):'—',Deadline:x.deadline?fmtDate(x.deadline):'—',Target:num(x.assigned_target).toLocaleString(),Acquired:num(x.acquired_users).toLocaleString(),Commission:money(x.commission),Status:ALLOC_STATUS[x.status]?.[0]||x.status}}));
    if(type==='payments')rows=(await api('payments')).filter(x=>x.partner_id===cxSelected).map(x=>({title:x.project_name+' · '+money(x.amount),data:{'Agent ID':agent?.code||'',Date:fmtDate(x.payment_date),Project:x.project_name,Start:x.start_date?fmtDate(x.start_date):'—',Deadline:x.deadline?fmtDate(x.deadline):'—',Amount:money(x.amount),Status:PAY_STATUS[x.status]?.[0]||x.status}}));
    if(type==='withdraw')rows=(await api('withdrawals')).filter(x=>x.partner_id===cxSelected).map(x=>({title:(x.method||'withdraw')+' · '+money(x.amount),data:{'Agent ID':agent?.code||'',Date:fmtDate(x.created_at),Method:x.method,Destination:x.method==='crypto_usdt'?x.wallet_address:x.account_number,Amount:money(x.amount),Status:WD_STATUS[x.status]?.[0]||x.status,trx:x.trx||'—'}}));
    if(type==='contribute')rows=(await api('contributions')).filter(x=>x.partner_id===cxSelected).map(x=>({title:(x.code||'Contribution')+' · '+x.project_name,data:{'Agent ID':agent?.code||'',Date:fmtDT(x.created_at),Project:x.project_name,Category:catLabel(x.category),Start:x.start_date?fmtDate(x.start_date):'—',Deadline:x.deadline?fmtDate(x.deadline):'—',Acquired:num(x.acquired).toLocaleString(),Status:CONTRIB_STATUS[x.status]?.[0]||x.status}}));
    if(type==='performance')rows=(await api('performance')).filter(x=>x.partner_id===cxSelected).map(x=>({title:x.project_name+' · '+x.pct+'%',data:{'Agent ID':agent?.code||'',Rank:'#'+x.rank,Project:x.project_name,Category:catLabel(x.category),Start:x.start_date?fmtDate(x.start_date):'—',Deadline:x.deadline?fmtDate(x.deadline):'—',Assigned:num(x.assigned).toLocaleString(),Acquired:num(x.acquired).toLocaleString(),Achievement:x.pct+'%'}}));
    ov.querySelector('.modal').innerHTML=`<h2>Attach ${esc(type)} details</h2><p>Select one row for ${esc(agent?.name||'selected agent')}.</p><div style="overflow:auto;max-height:520px"><table class="view-table"><thead><tr><th>Item</th><th>Summary</th><th></th></tr></thead><tbody>${rows.length?rows.map((r,i)=>`<tr><td><b>${esc(r.title)}</b></td><td>${Object.entries(r.data).map(([k,v])=>`<span class="project-chip"><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</td><td><button class="btn small" data-attach="${i}">Attach</button></td></tr>`).join(''):'<tr><td colspan="3" class="empty">No '+esc(type)+' data found for this agent.</td></tr>'}</tbody></table></div><div class="modal-actions"><button class="btn" data-close>Cancel</button></div>`;
    ov.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>ov.remove());
    ov.querySelectorAll('[data-attach]').forEach(b=>b.onclick=()=>{const r=rows[+b.dataset.attach];cxAttachment={type,title:r.title,data:r.data};const box=$('#cxAttachBox');box.style.display='flex';box.innerHTML=`<span><b>${esc(type)}</b> — ${esc(r.title)}</span><button class="btn small danger" id="cxClearAttach" type="button">Remove</button>`;$('#cxClearAttach').onclick=()=>{cxAttachment=null;box.style.display='none';box.innerHTML=''};ov.remove();toast('Attachment selected. It will be embedded by backend when the email is sent.')});
  }catch(e){ov.querySelector('.modal').innerHTML=`<h2>Attach ${esc(type)} details</h2><div class="empty">${esc(e.message)}</div><div class="modal-actions"><button class="btn" data-close>Close</button></div>`;ov.querySelector('[data-close]').onclick=()=>ov.remove()}
}
function wireConnectXSettings(main,settings){
  $('#cxSetSave').onclick=async()=>{
    const btn=$('#cxSetSave');btn.disabled=true;btn.textContent='Saving…';
    try{await mutate('connectx/settings',{method:'PATCH',body:JSON.stringify({enabled:$('#cxSetEnabled').value==='yes',from_name:$('#cxSetName').value,from_email:$('#cxSetEmail').value,reply_to:$('#cxSetReply').value,global_daily_limit:num($('#cxSetLimit').value),allocation_template_html:$('#cxTplAllocation').value,payments_template_html:$('#cxTplPayments').value,withdraw_template_html:$('#cxTplWithdraw').value,contribute_template_html:$('#cxTplContribute').value,performance_template_html:$('#cxTplPerformance').value})});toast('ConnectX settings saved.');await aConnectX(main)}
    catch(e){toast(e.message);btn.disabled=false;btn.textContent='Save settings'}
  };
}
function wireConnectXHistory(main,history){
  $('#cxRefresh').onclick=()=>aConnectX(main);
  $('#cxHistSearch').oninput=e=>{const q=e.target.value.toLowerCase(),rows=history.filter(m=>!q||((m.subject||'')+' '+(m.recipient_name||'')+' '+(m.to_emails||[]).join(' ')).toLowerCase().includes(q));$('#cxHistBody').innerHTML=rows.length?rows.map(cxHistoryRow).join(''):'<tr><td colspan="7" class="empty">No message found.</td></tr>';wireConnectXHistory(main,rows)};
  main.querySelectorAll('[data-cxview]').forEach(b=>b.onclick=()=>{const m=history.find(x=>x.id===b.dataset.cxview);if(!m)return;modal(`<h2>${esc(m.subject)}</h2><p>${esc(m.recipient_type)} · ${esc(m.recipient_name||'—')} · ${fmtDT(m.created_at)}</p><div class="kv"><span>To</span><b>${esc((m.to_emails||[]).join(', '))}</b><span>CC</span><b>${esc((m.cc_emails||[]).join(', ')||'—')}</b><span>BCC</span><b>${esc((m.bcc_emails||[]).join(', ')||'—')}</b><span>Status</span><b>${esc(m.status)}</b></div><div class="section-head" style="margin-top:16px"><h2>Rendered email preview</h2><span>Includes embedded template attachment</span></div><iframe class="cxmailpreview" sandbox srcdoc="${esc(m.body_html||('<pre>'+esc(m.custom_body||'')+'</pre>'))}"></iframe><div class="modal-actions"><button class="btn dark" data-close>Close</button></div>`, 'wide')});
}


/* ---------- ADMIN: USER PROFILE ---------- */
async function aAdminProfile(main){
  loading(main);
  const me=await need(main,'profile','admin/profile');
  if(!me)return;
  renderAdminProfile(main,me);
}
function renderAdminProfile(main,me){
  main.innerHTML=`
  <div class="top"><div class="title"><h1>User Profile</h1><p>Manage your admin board profile and password.</p></div>
  <div class="actions"><button class="btn dark" id="editAdminProfile">Edit profile</button></div></div>
  <div class="section-box">
    <div class="detail-head"><div style="display:flex;gap:14px;align-items:center"><div class="avatar" style="width:52px;height:52px;font-size:16px">${esc(initials(me.name))}</div><div><h2>${esc(me.name)}</h2><p>${me.kind==='owner'?'Primary administrator':'Board user'}</p></div></div>${me.status?pill(USER_STATUS,me.status):'<span class="pill green">Owner</span>'}</div>
    <div class="kv" style="margin-top:14px">
      <span>Name</span><b>${esc(me.name)}</b>
      <span>Email</span><b>${esc(me.email)}</b>
      <span>Phone</span><b>${esc(me.phone||'—')}</b>
      <span>Address</span><b>${esc(me.address||'—')}</b>
      <span>Password</span><b>••••••••</b>
    </div>
  </div>`;
  $('#editAdminProfile').onclick=()=>adminProfileModal(me);
}
function adminProfileModal(me){
  const ov=modal(`
    <h2>Edit user profile</h2>
    <p>Leave password blank to keep the current password.</p>
    <div class="field-row"><div class="field"><label>Name</label><input id="apName" value="${esc(me.name||'')}"></div><div class="field"><label>Email</label><input id="apEmail" type="email" value="${esc(me.email||'')}"></div></div>
    <div class="field"><label>Phone</label><input id="apPhone" value="${esc(me.phone||'')}"></div>
    <div class="field"><label>Address</label><input id="apAddress" value="${esc(me.address||'')}"></div>
    <div class="field"><label>Change password</label><input id="apPass" type="password" placeholder="Minimum 6 characters"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="apSave">Save changes</button></div>`);
  ov.querySelector('#apSave').onclick=async()=>{
    const btn=ov.querySelector('#apSave');btn.disabled=true;btn.textContent='Saving…';
    try{
      const out=await mutate('admin/profile',{method:'PATCH',body:JSON.stringify({name:ov.querySelector('#apName').value,email:ov.querySelector('#apEmail').value,phone:ov.querySelector('#apPhone').value,address:ov.querySelector('#apAddress').value,password:ov.querySelector('#apPass').value||undefined})});
      save({token:state.token,role:'admin',user:out});ov.remove();toast('Profile updated.');renderAdmin();
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent='Save changes'}
  };
}

/* ---------- ADMIN: USER CONTROL ---------- */
const USER_STATUS={active:['Active','green'],inactive:['Deactive','gray'],pending:['Pending request','yellow']};
async function aUserControl(main){
  loading(main);
  const users=await need(main,'users','admin/users');
  if(!users)return;
  renderUserControl(main,users);
}
function renderUserControl(main,users){
  main.innerHTML=`
  <div class="top"><div class="title"><h1>User Control</h1><p>Confirm user account requests and manage admin board users.</p></div>
  <div class="actions"><button class="btn dark" id="addUser">+ Add user</button></div></div>
  <div class="section-box"><div class="toolbar"><h2>Board users</h2><span class="muted">${users.filter(u=>u.status==='pending').length} pending request(s)</span></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Address</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
  <tbody>${users.length?users.map(u=>`<tr>
    <td><div class="partner"><div class="avatar">${esc(initials(u.name))}</div><div><b>${esc(u.name)}</b><small>${u.status==='pending'?'Requested to join board':'Board user'}</small></div></div></td>
    <td>${esc(u.email)}</td><td>${esc(u.phone||'—')}</td><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.address||'')}">${esc(u.address||'—')}</td>
    <td>${pill(USER_STATUS,u.status)}</td><td>${fmtDate(u.created_at)}</td>
    <td class="actions-cell">${u.status==='pending'?`<button class="btn small" data-approve="${u.id}">Confirm</button>`:''}<button class="btn small" data-edit-user="${u.id}">Edit</button><button class="btn small danger" data-del-user="${u.id}">×</button></td>
  </tr>`).join(''):'<tr><td colspan="7" class="empty">No users yet.</td></tr>'}</tbody></table></div></div>`;
  $('#addUser').onclick=()=>userControlModal(null);
  main.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{try{await mutate('admin/users/'+b.dataset.approve,{method:'PATCH',body:JSON.stringify({status:'active'})});toast('User confirmed.');renderAdmin()}catch(e){toast(e.message)}});
  main.querySelectorAll('[data-edit-user]').forEach(b=>b.onclick=()=>userControlModal(users.find(u=>u.id===b.dataset.editUser)));
  main.querySelectorAll('[data-del-user]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this user account?'))return;try{await mutate('admin/users/'+b.dataset.delUser,{method:'DELETE'});toast('User deleted.');renderAdmin()}catch(e){toast(e.message)}});
}
function userControlModal(u){
  const ov=modal(`
    <h2>${u?'Edit user':'Add user'}</h2>
    <p>${u?'Update this board user. Leave password blank to keep current.':'Create a board user who can login from the Admin login card.'}</p>
    <div class="field-row"><div class="field"><label>Name</label><input id="ucName" value="${esc(u?.name||'')}"></div><div class="field"><label>Email</label><input id="ucEmail" type="email" value="${esc(u?.email||'')}"></div></div>
    <div class="field"><label>Phone</label><input id="ucPhone" value="${esc(u?.phone||'')}"></div>
    <div class="field"><label>Address</label><input id="ucAddress" value="${esc(u?.address||'')}"></div>
    <div class="field"><label>${u?'Change password':'Password'}</label><input id="ucPass" type="password" placeholder="Minimum 6 characters"></div>
    <div class="field"><label>Active / Deactive</label><select id="ucStatus"><option value="active" ${u?.status==='active'?'selected':''}>Active</option><option value="inactive" ${u?.status==='inactive'?'selected':''}>Deactive</option><option value="pending" ${u?.status==='pending'?'selected':''}>Pending request</option></select></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="ucSave">${u?'Save changes':'Add user'}</button></div>`);
  ov.querySelector('#ucSave').onclick=async()=>{
    const btn=ov.querySelector('#ucSave');btn.disabled=true;btn.textContent='Saving…';
    const payload={name:ov.querySelector('#ucName').value,email:ov.querySelector('#ucEmail').value,phone:ov.querySelector('#ucPhone').value,address:ov.querySelector('#ucAddress').value,password:ov.querySelector('#ucPass').value||undefined,status:ov.querySelector('#ucStatus').value};
    try{
      if(u)await mutate('admin/users/'+u.id,{method:'PATCH',body:JSON.stringify(payload)});
      else await mutate('admin/users',{method:'POST',body:JSON.stringify(payload)});
      ov.remove();toast(u?'User updated.':'User added.');renderAdmin();
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent=u?'Save changes':'Add user'}
  };
}


/* ═══════════ PARTNER (AGENT) APP ═══════════ */
let pView='profile';
function partnerApp(){
  document.body.classList.remove('landing-mode');
  document.body.classList.add('dashboard-mode');
  document.title='InfluenceOS — Agent';
  const nav=[['profile','◉','Profile'],['team','☰','My Team'],['allocations','◌','Allocations'],['contribute','⇧','Contribute'],['projects','◆','Projects'],['payments','$','Payments'],['performance','◫','Performance'],['helpdesk','✉','HelpDesk <span class="navbadge" id="hdBadge" style="display:none"></span>']];
  app.innerHTML=`<div class="app">
    <aside class="sidebar">
      <div class="logo">Influence<span>OS</span><small>agent portal · DoxTox</small></div>
      <div class="nav-label">My workspace</div>
      <div class="nav">${nav.map(([k,i,l])=>`<button data-v="${k}" class="${k===pView?'active':''}"><span class="icon">${i}</span> ${l}</button>`).join('')}</div>
      <div class="sidebottom"><button id="outBtn">⏻ Logout</button></div>
    </aside>
    <main class="main" id="main">${loaderHtml("Loading…")}</main>
  </div>`;
  document.querySelectorAll('.nav button[data-v]').forEach(b=>b.onclick=()=>{pView=b.dataset.v;document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x===b));renderPartner()});
  $('#outBtn').onclick=logout;
  armMain($('#main'));
  onKey('helpdesk',d=>{if(!d)return;updateHdBadge(d.unread||0);if(pView==='helpdesk')paintPhLog(d)});
  api('helpdesk').then(d=>updateHdBadge(d.unread||0)).catch(()=>{});
  renderPartner();
}
const PARTNER_KEYS={
  profile:['me/profile','me/payment-methods'],
  team:['me/team'],
  allocations:['me/allocations'],
  contribute:['contributions/mine','me/overview'],
  helpdesk:['helpdesk'],
  projects:['me/overview'],
  payments:['me/overview'],
  performance:['me/overview']
};
async function renderPartner(){
  const main=$('#main');if(!main)return;
  const view=pView;
  main.dataset.view=view;
  viewPaint={keys:PARTNER_KEYS[view]||[],fn:()=>renderPartner()};
  try{
    if(view==='profile')return await pProfile(main);
    if(view==='team')return await pTeam(main);
    if(view==='allocations')return await pAllocations(main);
    if(view==='contribute')return await pContribute(main);
    if(view==='helpdesk')return await pHelpdesk(main);
    if(view==='projects')return await pOverview(main,'projects');
    if(view==='payments')return await pOverview(main,'payments');
    if(view==='performance')return await pOverview(main,'performance');
  }catch(e){keepOrShowError(main,view,e)}
}
async function pProfile(main){
  const r=await needData(main,'profile',['me/profile','me/payment-methods']);
  if(r)renderPProfile(main,r[0],r[1]);
}
function renderPProfile(main,me,payMethods=[]){
  main.innerHTML=`
  <div class="top"><div class="title"><h1>My profile</h1><p>Your partner account information.</p></div>
  <div class="actions"><button class="btn" id="payMethodsBtn">Payment method</button><button class="btn dark" id="editProfile">Edit profile</button></div></div>
  <div class="section-box">
    <div class="detail-head"><div style="display:flex;gap:14px;align-items:center"><div class="avatar" style="width:52px;height:52px;font-size:16px">${esc(initials(me.name))}</div><div><h2>${esc(me.name)}</h2><p>Agent ID <b>#${esc(me.partner_code)}</b></p></div></div><span class="pill ${me.login_access?'green':'red'}">${me.login_access?'Login enabled':'Login disabled'}</span></div>
    <div class="kv" style="margin-top:14px">
      <span>Email</span><b>${esc(me.email)}</b>
      <span>Phone number</span><b>${esc(me.phone||'—')}</b>
      <span>Address</span><b>${esc(me.address||'—')}</b>
      <span>Type</span><b>${TYPE_LABELS[me.type]||me.type}</b>
      <span>Password</span><b>••••••••</b>
    </div>
    <div class="section-head" style="margin-top:18px"><h2>Social accounts</h2></div>
    ${(me.accounts||[]).length?me.accounts.map(a=>`<div class="target-row"><b>${esc(a.label||'Account')}</b><span style="grid-column:2/5"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a></span></div>`).join(''):'<p class="muted" style="font-size:12px">No social accounts saved.</p>'}
    <div id="payMethodsBox"></div>
  </div>`;
  const paintPayMethods=rows=>{
    const box=$('#payMethodsBox');if(!box)return;
    box.innerHTML=`<div class="section-head" style="margin-top:18px"><h2>Payment methods</h2><span class="muted">Withdrawal details (max 5)</span></div>
    <div style="overflow:auto"><table class="view-table"><thead><tr><th>Method</th><th>Details</th><th>Type</th><th></th></tr></thead>
    <tbody>${rows.length?rows.map(pm=>`<tr>
      <td><b>${pm.method==='bkash'?'bKash':pm.method==='nagad'?'Nagad':'Crypto — USDT (TRC20)'}</b></td>
      <td>${esc(pm.method==='crypto_usdt'?pm.wallet_address:pm.account_number)}</td>
      <td>${pm.method==='crypto_usdt'?'Wallet':pm.account_type==='agent'?'Agent number':'Personal number'}</td>
      <td class="actions-cell"><button class="btn small" data-pm-edit="${pm.id}">Edit</button><button class="btn small danger" data-pm-del="${pm.id}">×</button></td>
    </tr>`).join(''):'<tr><td colspan="4" class="empty">No payment method saved yet.</td></tr>'}</tbody></table></div>`;
    box.querySelectorAll('[data-pm-edit]').forEach(b=>b.onclick=()=>paymentMethodModal(rows.find(x=>x.id===b.dataset.pmEdit),paintPayMethods));
    box.querySelectorAll('[data-pm-del]').forEach(b=>b.onclick=async()=>{
      if(!confirm('Delete this payment method?'))return;
      try{await mutate('me/payment-methods/'+b.dataset.pmDel,{method:'DELETE'});toast('Payment method deleted.');paintPayMethods(await api('me/payment-methods',{forceFresh:true}))}catch(e){toast(e.message)}
    });
  };
  paintPayMethods(payMethods);
  $('#payMethodsBtn').onclick=()=>paymentMethodModal(null,paintPayMethods);
  $('#editProfile').onclick=()=>{
    const accounts=(me.accounts&&me.accounts.length?me.accounts:[{label:'',url:''}]);
    const ov=modal(`
    <h2>Edit profile</h2>
    <p>You can update your own details. Every change is logged for the administrator.</p>
    <div class="field-row">
      <div class="field"><label>Name</label><input id="sName" value="${esc(me.name)}"></div>
      <div class="field"><label>Email</label><input id="sEmail" type="email" value="${esc(me.email)}"></div>
    </div>
    <div class="field"><label>Phone number</label><input id="sPhone" value="${esc(me.phone||'')}"></div>
    <div class="field"><label>Address</label><input id="sAddress" value="${esc(me.address||'')}" placeholder="Street, city"></div>
    <div class="field"><label>Social / account information <small>(up to 5)</small></label><div id="sAcctBox"></div>
      <button class="btn small" id="sAddAcct" type="button">+ Add URL</button></div>
    <div class="field"><label>Password <small>(leave blank to keep current)</small></label><input id="sPass" type="password" placeholder="Minimum 6 characters"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="sGo">Save changes</button></div>`);
    const box=ov.querySelector('#sAcctBox');
    const addRow=(a={label:'',url:''})=>{
      if(box.children.length>=5){toast('Maximum 5 account URLs.');return}
      const r=document.createElement('div');r.className='acct-row';
      r.innerHTML=`<input placeholder="Label (YouTube…)" value="${esc(a.label)}"><input placeholder="https://…" value="${esc(a.url)}"><button class="btn small danger" type="button">×</button>`;
      r.querySelector('button').onclick=()=>r.remove();box.append(r);
    };
    accounts.forEach(addRow);
    ov.querySelector('#sAddAcct').onclick=()=>addRow();
    ov.querySelector('#sGo').onclick=async()=>{
      const accountsList=[...box.querySelectorAll('.acct-row')].map(r=>({label:r.children[0].value,url:r.children[1].value})).filter(a=>a.label.trim()||a.url.trim());
      try{
        await mutate('me/profile',{method:'POST',body:JSON.stringify({name:ov.querySelector('#sName').value,email:ov.querySelector('#sEmail').value,phone:ov.querySelector('#sPhone').value,address:ov.querySelector('#sAddress').value,accounts:accountsList,password:ov.querySelector('#sPass').value||undefined})});
        ov.remove();toast('Profile updated.');renderPartner();
      }catch(e){toast(e.message)}
    };
  };
}
async function pOverview(main,view){
  const d=await need(main,view,'me/overview');
  if(!d)return;
  if(view==='projects')renderPProjects(main,d);else if(view==='payments')renderPPayments(main,d);else renderPPerformance(main,d);
}
function renderPProjects(main,d){
    d=d||{};d.projects=d.projects||[];
    main.innerHTML=`<div class="top"><div class="title"><h1>My projects</h1><p>Projects allocated to your account.</p></div></div>
    <div class="project-grid">${d.projects.length?d.projects.map(x=>`
      <div class="project-card"><div class="detail-head"><div><h3>${esc(x.project?.name||'—')}</h3><p>${esc(x.project?.details||'')}</p></div><span class="pill blue">${catLabel(x.category)}</span></div>
        <div class="meta"><span>Start date</span><b>${x.start_date?fmtDate(x.start_date):'—'}</b></div>
        <div class="meta"><span>Deadline</span><b>${x.deadline?fmtDate(x.deadline):'—'}</b></div>
        <div class="meta"><span>My target (${catLabel(x.category).toLowerCase()})</span><b>${num(x.assigned_target).toLocaleString()}</b></div>
        <div class="meta"><span>My acquired</span><b>${num(x.acquired_users).toLocaleString()}</b></div>
        <div class="progress-lg"><i style="width:${Math.min(100,x.pct)}%"></i></div>
        <div class="meta"><span>${x.pct}% achieved</span><span>${money(x.commission)} commission</span></div>
      </div>`).join(''):'<div class="empty" style="grid-column:1/-1">No projects allocated to you yet.</div>'}</div>`;
}
function renderPPayments(main,d){
    d=d||{};d.stats=d.stats||{};d.payments=d.payments||[];d.withdrawals=d.withdrawals||[];
    main.innerHTML=`<div class="top"><div class="title"><h1>My payments</h1><p>Earnings, payout history and withdrawals.</p></div>
    <div class="actions"><button class="btn dark" id="withdrawBtn">Withdraw</button></div></div>
    <div class="kpi-grid">
      <div class="card stat"><div><div class="label">Total Earnings</div><div class="value">${money(d.stats.income)}</div></div></div>
      <div class="card stat"><div><div class="label">Paid</div><div class="value">${money(d.stats.paid)}</div><div class="change">Withdrawn successfully</div></div></div>
      <div class="card stat"><div><div class="label">Available Balance</div><div class="value">${money(d.stats.balance)}</div></div></div>
    </div>
    <div class="two">
    <div class="section-box" style="margin-top:0"><div class="toolbar"><h2>Payout history</h2></div><div style="overflow:auto"><table class="view-table"><thead><tr><th>Payment ID</th><th>Date</th><th>Project</th><th>Start</th><th>Deadline</th><th>Amount</th><th>Status</th></tr></thead>
    <tbody>${d.payments.length?d.payments.map(p=>`<tr><td><b>${esc(String(p.id).slice(0,8).toUpperCase())}</b></td><td>${fmtDate(p.payment_date)}</td><td>${esc(p.project_name)}</td><td>${p.start_date?fmtDate(p.start_date):'—'}</td><td>${p.deadline?fmtDate(p.deadline):'—'}</td><td><b>${money(p.amount)}</b></td><td>${pill(PAY_STATUS,p.status)}</td></tr>`).join(''):'<tr><td colspan="7" class="empty">No payments yet.</td></tr>'}</tbody></table></div></div>
    <div class="section-box" style="margin-top:0"><div class="toolbar"><h2>Withdrawals</h2><span class="muted">Your requests</span></div><div style="overflow:auto"><table class="view-table"><thead><tr><th>ID</th><th>Date</th><th>Method</th><th>Type</th><th>Number / Address</th><th>Amount</th><th>Trx</th><th>Status</th></tr></thead>
    <tbody>${(d.withdrawals||[]).length?(d.withdrawals||[]).map(w=>`<tr>
      <td><b>${esc(String(w.id).slice(0,8).toUpperCase())}</b></td><td>${fmtDate(w.created_at)}</td>
      <td>${w.method==='bkash'?'bKash':w.method==='nagad'?'Nagad':'Crypto — USDT (TRC20)'}</td>
      <td>${w.method==='crypto_usdt'?'Wallet':w.account_type==='agent'?'Agent number':'Personal number'}</td>
      <td>${esc(w.method==='crypto_usdt'?w.wallet_address:w.account_number)}</td>
      <td><b>${money(w.amount)}</b></td><td>${esc(w.trx||'—')}</td>
      <td>${pill(WD_STATUS,w.status)}${w.status==='rejected'&&w.reject_reason?`<small class="muted" style="display:block;margin-top:3px">${esc(w.reject_reason)}</small>`:''}</td>
    </tr>`).join(''):'<tr><td colspan="8" class="empty">No withdrawals yet.</td></tr>'}</tbody></table></div></div>
    </div>`;
    $('#withdrawBtn').onclick=()=>withdrawModal(d.stats.balance);
}
async function withdrawModal(balance){
  let methods=[];
  try{methods=await api('me/payment-methods')}catch(e){return toast(e.message)}
  if(!methods.length)return toast('Add a payment method in your Profile first.');
  const bal=Number(balance)||0;
  const ov=modal(`
    <h2>Withdraw</h2>
    <p>Requests are reviewed by the administrator. Pending requests lock part of your balance.</p>
    <div class="field"><label>Available balance</label><input readonly value="${money(bal)}"></div>
    <div class="field"><label>Payment method</label><select id="wdMethod"><option value="">Select method…</option>${methods.map(m=>`<option value="${m.id}">${m.method==='bkash'?'bKash':m.method==='nagad'?'Nagad':'USDT TRC20'} · ${esc(m.method==='crypto_usdt'?m.wallet_address:m.account_number)} (${m.method==='crypto_usdt'?'Wallet':m.account_type==='agent'?'Agent':'Personal'})</option>`).join('')}</select></div>
    <div class="field"><label>Withdraw amount ($)</label><input id="wdAmount" type="number" min="0" step="10" placeholder="0"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="wdGo">Withdraw</button></div>`);
  ov.querySelector('#wdGo').onclick=async()=>{
    const methodId=ov.querySelector('#wdMethod').value,amount=num(ov.querySelector('#wdAmount').value);
    if(!methodId)return toast('Select a payment method.');
    if(amount<=0)return toast('Enter a withdraw amount.');
    if(amount>bal)return toast(`Amount cannot exceed your available balance (${money(bal)}).`);
    const btn=ov.querySelector('#wdGo');btn.disabled=true;btn.textContent='Sending…';
    try{await mutate('withdrawals',{method:'POST',body:JSON.stringify({payment_method_id:methodId,amount})});ov.remove();toast('Withdrawal request sent for admin approval.');renderPartner()}
    catch(e){toast(e.message);btn.disabled=false;btn.textContent='Withdraw'}
  };
}
function renderPPerformance(main,d){
    d=d||{};d.performance=d.performance||{};d.projects=d.projects||[];
    main.innerHTML=`<div class="top"><div class="title"><h1>My performance</h1><p>Your achievement across all allocated projects.</p></div></div>
    <div class="kpi-grid">
      <div class="card stat"><div><div class="label">Total Allocations</div><div class="value">${d.performance.projects}</div></div></div>
      <div class="card stat"><div><div class="label">Assigned</div><div class="value">${num(d.performance.assigned).toLocaleString()}</div></div></div>
      <div class="card stat"><div><div class="label">Acquired</div><div class="value">${num(d.performance.acquired).toLocaleString()}</div></div></div>
      <div class="card stat"><div><div class="label">Achievement</div><div class="value">${d.performance.pct}%</div><div class="change">Rank #${d.performance.rank||'—'} of ${d.performance.total}</div></div></div>
    </div>
    <div class="section-box"><div class="toolbar"><h2>Category-wise performance</h2></div><div style="overflow:auto"><table class="view-table"><thead><tr><th>Project</th><th>Category</th><th>Start</th><th>Deadline</th><th>My target</th><th>My acquired</th><th>Achievement</th><th>Commission</th><th>Status</th></tr></thead>
    <tbody>${d.projects.length?d.projects.map(x=>`<tr><td><b>${esc(x.project?.name||'—')}</b></td><td><span class="pill blue">${catLabel(x.category)}</span></td><td>${x.start_date?fmtDate(x.start_date):'—'}</td><td>${x.deadline?fmtDate(x.deadline):'—'}</td><td>${num(x.assigned_target).toLocaleString()}</td><td>${num(x.acquired_users).toLocaleString()}</td><td>${x.pct}%</td><td>${money(x.commission)}</td><td>${pill(ALLOC_STATUS,x.status)}</td></tr>`).join(''):'<tr><td colspan="9" class="empty">No allocations yet.</td></tr>'}</tbody></table></div></div>`;
}

/* ---------- AGENT: MY TEAM ---------- */
let teamQ='';
async function pTeam(main){
  const rows=await need(main,'team','me/team');
  if(rows)renderTeamView(main,rows);
}
function renderTeamView(main,rows){
  const list=rows.filter(m=>!teamQ||(m.name+' '+m.email+' '+m.code).toLowerCase().includes(teamQ.toLowerCase()));
  main.innerHTML=`
  <div class="top"><div class="title"><h1>My Team</h1><p>Manage your team members — codes are generated automatically. Team login arrives in a future update.</p></div>
  <div class="actions"><button class="btn dark" id="addMember">+ Add team member</button></div></div>
  <div class="section-box"><div class="toolbar"><h2>Team directory</h2><div class="filters"><input id="teamQ" placeholder="Search name, email or code…" value="${esc(teamQ)}"></div></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>Code</th><th>Member</th><th>Type</th><th>Phone</th><th>Accounts</th><th>Login access</th><th>Note</th><th>Status</th><th></th></tr></thead>
  <tbody>${list.length?list.map(m=>`<tr>
    <td><b>${esc(m.code)}</b></td>
    <td><div class="partner"><div class="avatar">${esc(initials(m.name))}</div><div><b>${esc(m.name)}</b><small>${esc(m.email)}</small></div></div></td>
    <td>${TEAM_TYPE_LABELS[m.type]||m.type}</td>
    <td>${esc(m.phone||'—')}</td>
    <td>${(m.accounts||[]).length||'—'}</td>
    <td>${m.login_access?'<span class="pill green">Yes</span>':'<span class="pill gray">No</span>'}</td>
    <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.note||'')}">${esc(m.note||'—')}</td>
    <td>${pill(TEAM_STATUS,m.status)}</td>
    <td class="actions-cell"><button class="btn small" data-tm-edit="${m.id}">Edit</button><button class="btn small danger" data-tm-del="${m.id}">×</button></td>
  </tr>`).join(''):'<tr><td colspan="9" class="empty">No team members yet.</td></tr>'}</tbody></table></div></div>`;
  $('#addMember').onclick=()=>teamModal(null);
  $('#teamQ').oninput=e=>{teamQ=e.target.value;renderTeamView(main,rows)};
  main.querySelectorAll('[data-tm-edit]').forEach(b=>b.onclick=()=>teamModal(rows.find(x=>x.id===b.dataset.tmEdit)));
  main.querySelectorAll('[data-tm-del]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Delete this team member?'))return;
    try{await mutate('me/team/'+b.dataset.tmDel,{method:'DELETE'});toast('Team member deleted.');renderPartner()}catch(e){toast(e.message)}
  });
}
function teamModal(m){
  const accounts=(m?.accounts&&m.accounts.length?m.accounts:[{label:'',url:''}]);
  const ov=modal(`
    <h2>${m?'Edit team member':'Add team member'}</h2>
    <p>${m?'Member code #'+esc(m.code):'A unique 4-digit code will be generated automatically. Team login is not enabled yet.'}</p>
    <div class="field-row">
      <div class="field"><label>Name</label><input id="tName" value="${esc(m?.name||'')}" placeholder="Full name"></div>
      <div class="field"><label>Email</label><input id="tEmail" type="email" value="${esc(m?.email||'')}" placeholder="member@email.com"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Phone number</label><input id="tPhone" value="${esc(m?.phone||'')}" placeholder="+880…"></div>
      <div class="field"><label>Team type</label><select id="tType">${Object.entries(TEAM_TYPE_LABELS).map(([k,v])=>`<option value="${k}" ${m?.type===k?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Social / account information <small>(up to 5)</small></label><div id="tAcctBox"></div>
      <button class="btn small" id="tAddAcct" type="button">+ Add URL</button></div>
    <div class="field"><label>Password ${m?'<small>(leave blank to keep current)</small>':'<small>(stored for future team login)</small>'}</label><input id="tPass" type="password" placeholder="Minimum 6 characters"></div>
    <div class="field-row">
      <div class="field"><label>Login access</label><select id="tAccess"><option value="yes" ${m?.login_access!==false?'selected':''}>Yes</option><option value="no" ${m?.login_access===false?'selected':''}>No</option></select></div>
      <div class="field"><label>Status</label><select id="tStatus"><option value="active" ${m?.status!=='inactive'?'selected':''}>Active</option><option value="inactive" ${m?.status==='inactive'?'selected':''}>Inactive</option></select></div>
    </div>
    <div class="field"><label>Note</label><textarea id="tNote" rows="2" placeholder="Optional note…">${esc(m?.note||'')}</textarea></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="tSave">${m?'Save changes':'Add team member'}</button></div>`);
  const box=ov.querySelector('#tAcctBox');
  const addRow=(a={label:'',url:''})=>{
    if(box.children.length>=5){toast('Maximum 5 account URLs.');return}
    const r=document.createElement('div');r.className='acct-row';
    r.innerHTML=`<input placeholder="Label (YouTube…)" value="${esc(a.label)}"><input placeholder="https://…" value="${esc(a.url)}"><button class="btn small danger" type="button">×</button>`;
    r.querySelector('button').onclick=()=>r.remove();box.append(r);
  };
  accounts.forEach(addRow);
  ov.querySelector('#tAddAcct').onclick=()=>addRow();
  ov.querySelector('#tSave').onclick=async()=>{
    const payload={name:ov.querySelector('#tName').value,email:ov.querySelector('#tEmail').value,phone:ov.querySelector('#tPhone').value,
      type:ov.querySelector('#tType').value,accounts:[...box.querySelectorAll('.acct-row')].map(r=>({label:r.children[0].value,url:r.children[1].value})).filter(a=>a.label.trim()||a.url.trim()),
      password:ov.querySelector('#tPass').value||undefined,login_access:ov.querySelector('#tAccess').value==='yes',status:ov.querySelector('#tStatus').value,note:ov.querySelector('#tNote').value};
    const btn=ov.querySelector('#tSave');btn.disabled=true;btn.textContent='Saving…';
    try{
      if(m){await mutate('me/team/'+m.id,{method:'PATCH',body:JSON.stringify(payload)});ov.remove();toast('Team member updated.');renderPartner()}
      else{const r=await mutate('me/team',{method:'POST',body:JSON.stringify(payload)});ov.remove();modal(`<h2>Team member added</h2><p>Share this code with the member — login arrives in a future update.</p><div class="kv"><span>Member code</span><b style="font-size:20px">${esc(r.code)}</b><span>Email</span><b>${esc(r.email)}</b></div><div class="modal-actions"><button class="btn dark" data-close>Done</button></div>`);toast('Team member added — code '+r.code);renderPartner()}
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent=m?'Save changes':'Add team member'}
  };
}

/* ---------- AGENT: PAYMENT METHOD MODAL ---------- */
function paymentMethodModal(existing,paint){
  const pm=existing||{method:'',account_number:'',account_type:'',wallet_address:''};
  const ov=modal(`
    <h2>${existing?'Edit payment method':'Add payment method'}</h2>
    <p>Withdrawal details — you can save up to 5 methods.</p>
    <div class="field"><label>Payment method</label><select id="pmMethod">
      <option value="">Select method…</option>
      <option value="bkash" ${pm.method==='bkash'?'selected':''}>bKash</option>
      <option value="nagad" ${pm.method==='nagad'?'selected':''}>Nagad</option>
      <option value="crypto_usdt" ${pm.method==='crypto_usdt'?'selected':''}>Crypto — USDT (TRC20)</option>
    </select></div>
    <div id="pmWallet" class="field" style="display:none"><label>USDT TRC20 wallet address</label><input id="pmWalletInput" placeholder="T… (TRC20 address)" value="${esc(pm.wallet_address||'')}"></div>
    <div id="pmNumberBox" style="display:none">
      <div class="field"><label id="pmNumberLabel">Number</label><input id="pmNumber" placeholder="01XXXXXXXXX" value="${esc(pm.account_number||'')}"></div>
      <div class="field"><label>Choose account type</label><select id="pmType">
        <option value="">Select…</option>
        <option value="agent" ${pm.account_type==='agent'?'selected':''}>Agent Number</option>
        <option value="personal" ${pm.account_type==='personal'?'selected':''}>Personal Number</option>
      </select></div>
    </div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="pmSave">${existing?'Save changes':'Save method'}</button></div>`);
  const methodSel=ov.querySelector('#pmMethod');
  const sync=()=>{
    const v=methodSel.value;
    ov.querySelector('#pmWallet').style.display=v==='crypto_usdt'?'flex':'none';
    ov.querySelector('#pmNumberBox').style.display=(v==='bkash'||v==='nagad')?'block':'none';
    ov.querySelector('#pmNumberLabel').textContent=(v==='bkash'?'bKash':v==='nagad'?'Nagad':'')+' Number';
  };
  methodSel.onchange=sync;sync();
  ov.querySelector('#pmSave').onclick=async()=>{
    const v=methodSel.value;
    if(!v)return toast('Select a payment method.');
    const payload={method:v};
    if(v==='crypto_usdt')payload.wallet_address=ov.querySelector('#pmWalletInput').value;
    else{payload.account_number=ov.querySelector('#pmNumber').value;payload.account_type=ov.querySelector('#pmType').value}
    const btn=ov.querySelector('#pmSave');btn.disabled=true;btn.textContent='Saving…';
    try{
      await mutate(existing?'me/payment-methods/'+existing.id:'me/payment-methods',{method:existing?'PATCH':'POST',body:JSON.stringify(payload)});
      ov.remove();toast(existing?'Payment method updated.':'Payment method saved.');
      if(paint)paint(await api('me/payment-methods',{forceFresh:true}));
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent=existing?'Save changes':'Save method'}
  };
}

/* ---------- AGENT: ALLOCATIONS ---------- */
async function pAllocations(main){
  const d=await need(main,'allocations','me/allocations');
  if(d)renderAgentAllocations(main,d);
}
function renderAgentAllocations(main,d){
  d={mine:d&&d.mine||[],team:d&&d.team||[]};
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Allocations</h1><p>Targets the admin assigned to you — and how you assign them to your own team.</p></div>
  <div class="actions"><button class="btn dark" id="addTeamAlloc">+ Assign to team member</button></div></div>

  <div class="section-box" style="margin-top:0"><div class="toolbar"><h2>My allocations</h2><span class="muted">From the administrator — read only</span></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>Project</th><th>Category</th><th>Start</th><th>Deadline</th><th>Assigned target</th><th>Acquired <small>(auto)</small></th><th>Commission <small>(auto)</small></th><th>Status</th></tr></thead>
  <tbody>${d.mine.length?d.mine.map(a=>`<tr>
    <td>${esc(a.project_name)}</td>
    <td><span class="pill blue">${catLabel(a.category)}</span></td>
    <td>${a.start_date?fmtDate(a.start_date):'—'}</td><td>${a.deadline?fmtDate(a.deadline):'—'}</td>
    <td>${num(a.assigned_target).toLocaleString()}</td>
    <td><b>${num(a.acquired_users).toLocaleString()}</b></td>
    <td>${money(a.commission)}</td>
    <td>${pill(ALLOC_STATUS,a.status)}</td>
  </tr>`).join(''):'<tr><td colspan="8" class="empty">The admin has not allocated any project to you yet.</td></tr>'}</tbody></table></div></div>

  <div class="section-box"><div class="toolbar"><h2>Team allocations</h2><span class="muted">${d.team.length} assigned to your team</span></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>Project</th><th>Category</th><th>Team member</th><th>Assigned target</th><th>Acquired</th><th>Note</th><th>Status</th><th></th></tr></thead>
  <tbody>${d.team.length?d.team.map(t=>`<tr>
    <td>${esc(t.project_name)}</td>
    <td><span class="pill blue">${catLabel(t.category)}</span></td>
    <td><div class="partner"><div class="avatar">${esc(initials(t.member_name))}</div><div><b>${esc(t.member_name)}</b><small>#${esc(t.member_code)}</small></div></div></td>
    <td>${num(t.assigned_target).toLocaleString()}</td>
    <td><b>${num(t.acquired_users).toLocaleString()}</b></td>
    <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.note||'')}">${esc(t.note||'—')}</td>
    <td>${pill(ALLOC_STATUS,t.status)}</td>
    <td class="actions-cell"><button class="btn small" data-ta-edit="${t.id}">Edit</button><button class="btn small danger" data-ta-del="${t.id}">×</button></td>
  </tr>`).join(''):'<tr><td colspan="8" class="empty">No team allocations yet. Click “+ Assign to team member”.</td></tr>'}</tbody></table></div></div>`;
  $('#addTeamAlloc').onclick=()=>teamAllocModal(null,d);
  main.querySelectorAll('[data-ta-edit]').forEach(b=>b.onclick=()=>teamAllocModal(d.team.find(x=>x.id===b.dataset.taEdit),d));
  main.querySelectorAll('[data-ta-del]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Delete this team allocation?'))return;
    try{await mutate('me/team-allocations/'+b.dataset.taDel,{method:'DELETE'});toast('Team allocation deleted.');renderPartner()}catch(e){toast(e.message)}
  });
}
async function teamAllocModal(t,d){
  const editing=!!t;
  const allocs=d.mine||[];
  let members=[];
  try{members=await api('me/team')}catch{members=[]}
  if(!editing&&!members.length)return toast('Add a team member in My Team first.');
  if(!editing&&!allocs.length)return toast('You have no project allocations to assign yet.');
  const ov=modal(`
    <h2>${editing?'Edit team allocation':'Assign project to team member'}</h2>
    <p>${editing?'Update the target, progress, status or note.':'Pick one of your project allocations — its category is carried to the team member automatically.'}</p>
    <div class="field"><label>Your project allocation</label><select id="taAlloc" ${editing?'disabled':''}><option value="">Select project allocation…</option>${allocs.map(a=>`<option value="${a.id}" ${t&&t.project_id===a.project_id&&t.category===a.category?'selected':''}>${esc(a.project_name)} · ${catLabel(a.category)}</option>`).join('')}</select></div>
    <div class="field"><label>Category <small>(locked — comes from the selected allocation)</small></label><input id="taCatLock" readonly value="${t?catLabel(t.category):'—'}"></div>
    <div class="field"><label>Team member</label><select id="taMember" ${editing?'disabled':''}><option value="">Select member…</option>${members.map(m=>`<option value="${m.id}" ${t?.team_member_id===m.id?'selected':''}>${esc(m.name)} · #${esc(m.code)} · ${TEAM_TYPE_LABELS[m.type]||m.type}</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Assigned target</label><input id="taTarget" type="number" min="0" value="${num(t?.assigned_target)}"></div>
      ${editing?'<div class="field"><label>Acquired (progress)</label><input id="taAcquired" type="number" min="0" value="'+num(t?.acquired_users)+'"></div>':''}
    </div>
    <div class="field"><label>Status</label><select id="taStatus">${Object.entries(ALLOC_STATUS).map(([k,v])=>`<option value="${k}" ${t?.status===k?'selected':''}>${v[0]}</option>`).join('')}</select></div>
    <div class="field"><label>Note</label><input id="taNote" value="${esc(t?.note||'')}"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="taSave">${editing?'Save changes':'Assign allocation'}</button></div>`);
  const allocSel=ov.querySelector('#taAlloc');
  const syncCat=()=>{const sel=allocs.find(a=>a.id===allocSel.value);ov.querySelector('#taCatLock').value=sel?catLabel(sel.category):'—'};
  if(allocSel){allocSel.onchange=syncCat;if(!editing)syncCat()}
  ov.querySelector('#taSave').onclick=async()=>{
    if(!editing&&!allocSel.value)return toast('Select your project allocation.');
    const payload={assigned_target:Math.round(num(ov.querySelector('#taTarget').value)),status:ov.querySelector('#taStatus').value,note:ov.querySelector('#taNote').value};
    if(editing)payload.acquired_users=Math.round(num(ov.querySelector('#taAcquired').value));
    const btn=ov.querySelector('#taSave');btn.disabled=true;btn.textContent='Saving…';
    try{
      if(editing)await mutate('me/team-allocations/'+t.id,{method:'PATCH',body:JSON.stringify(payload)});
      else await mutate('me/team-allocations',{method:'POST',body:JSON.stringify({allocation_id:allocSel.value,team_member_id:ov.querySelector('#taMember').value,...payload})});
      ov.remove();toast(editing?'Team allocation updated.':'Project assigned to team member.');renderPartner();
    }catch(e){toast(e.message);btn.disabled=false;btn.textContent=editing?'Save changes':'Assign allocation'}
  };
}

/* ---------- AGENT: CONTRIBUTE ---------- */

async function pContribute(main){
  const r=await needData(main,'contribute',['contributions/mine','me/overview']);
  if(r)renderPContribute(main,r[0],r[1]);
}
function renderPContribute(main,rows,overview){
  main.innerHTML=`
  <div class="top"><div class="title"><h1>Contribute</h1><p>Submit the users you acquired today with proof — the admin reviews every request.</p></div>
  <div class="actions"><button class="btn dark" id="addContrib">+ Add contribution</button></div></div>
  <div class="section-box"><div class="toolbar"><h2>My contribution requests</h2><span class="muted">Newest first</span></div>
  <div style="overflow:auto"><table class="view-table"><thead><tr><th>ID</th><th>Date &amp; time</th><th>Project</th><th>Category</th><th>Start</th><th>Deadline</th><th>Acquired</th><th>Proof</th><th>Note</th><th>Status</th><th>Admin review</th></tr></thead>
  <tbody>${rows.length?rows.map(c=>`<tr>
    <td><b>${esc(c.code||String(c.id).slice(0,6))}</b></td>
    <td>${fmtDT(c.created_at)}</td>
    <td>${esc(c.project_name)}</td>
    <td><span class="pill blue">${catLabel(c.category)}</span></td>
    <td>${c.start_date?fmtDate(c.start_date):'—'}</td><td>${c.deadline?fmtDate(c.deadline):'—'}</td>
    <td><b>+${num(c.acquired).toLocaleString()}</b></td>
    <td>${filesCell(c.files)}</td>
    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.note||'')}">${esc(c.note||'—')}</td>
    <td>${pill(CONTRIB_STATUS,c.status)}</td>
    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.review_note||'')}">${c.reviewed_at?esc(c.review_note||'Reviewed'):'Waiting for review'}</td>
  </tr>`).join(''):'<tr><td colspan="10" class="empty">No contribution requests yet. Click “+ Add contribution”.</td></tr>'}</tbody></table></div></div>`;
  main.querySelectorAll('[data-files]').forEach(b=>b.onclick=()=>filesModal(JSON.parse(b.dataset.files)));
  $('#addContrib').onclick=()=>contributeModal(overview);
}
function contributeModal(overview){
  const projects=(overview?.projects||[]).filter(x=>x.project);
  const m=modal(`
    <h2>Add contribution</h2>
    <p>Request credit for today's results. The admin accepts or rejects each request after checking the proof.</p>
    <div class="field"><label>Project</label><select id="cProject"><option value="">Select project…</option>${projects.map(x=>`<option value="${x.id}">${esc(x.project.name)} · ${catLabel(x.category)} · target ${num(x.assigned_target).toLocaleString()}</option>`).join('')}</select></div>
    <div class="field"><label>Today <span id="cCatLabel">acquired</span></label><input id="cAcquired" type="number" min="1" step="1" placeholder="e.g. 120"></div>
    <div class="field"><label>Proof of acquired <small>(up to 10 files · each max 10 MB)</small></label><input id="cFile" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"></div>
    <div class="field"><label>Note <small>(optional)</small></label><input id="cNote" placeholder="Anything the admin should know"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn dark" id="cGo">Send request</button></div>`);
  const catSel=m.querySelector('#cProject');
  const syncCat=()=>{const sel=projects.find(x=>x.id===catSel.value);m.querySelector('#cCatLabel').textContent=sel?catLabel(sel.category).toLowerCase():'acquired'};
  catSel.onchange=syncCat;syncCat();
  m.querySelector('#cGo').onclick=async()=>{
    if(!m.querySelector('#cProject').value)return toast('Select a project.');
    const picked=[...m.querySelector('#cFile').files];
    if(!picked.length)return toast('Attach at least one proof file.');
    if(picked.length>10)return toast('Maximum 10 proof files per request.');
    if(picked.some(f=>f.size>10*1024*1024))return toast('Each proof file must be 10 MB or smaller.');
    const fd=new FormData();
    fd.append('allocation_id',m.querySelector('#cProject').value);
    fd.append('acquired',m.querySelector('#cAcquired').value);
    fd.append('note',m.querySelector('#cNote').value);
    picked.forEach(f=>fd.append('file',f));
    const btn=m.querySelector('#cGo');
    btn.disabled=true;btn.textContent='Sending…';
    try{await upload('contributions',fd);m.remove();toast('Contribution request sent for review.');renderPartner()}
    catch(e){toast(e.message);btn.disabled=false;btn.textContent='Send request'}
  };
}

/* ---------- AGENT: HELPDESK (live, silent — typing is never lost) ---------- */
function phMsgsHtml(d){
  return d.messages.length?d.messages.map(m=>`<div class="msg ${m.sender_type==='agent'?'me':''}"><p>${esc(m.body)}</p><time>${fmtDT(m.created_at)} · ${m.sender_type==='agent'?'You':'Admin'}</time></div>`).join(''):'<div class="empty">No messages yet — write to the administrator anytime.</div>';
}
function paintPhLog(d){
  const log=$('#phLog');if(!log||pView!=='helpdesk')return;
  const html=phMsgsHtml(d);
  const stick=log.scrollHeight-log.scrollTop-log.clientHeight<60;
  if(log.innerHTML!==html)log.innerHTML=html;
  if(stick)log.scrollTop=log.scrollHeight;
}
async function pHelpdesk(main){
  const d=await need(main,'helpdesk','helpdesk');
  if(!d||pView!=='helpdesk')return;
  updateHdBadge(d.unread||0);
  if(!$('#phLog')){                                        // paint the shell once — the input is never rebuilt
    main.innerHTML=`
    <div class="top"><div class="title"><h1>HelpDesk</h1><p>Your continuous conversation with the administrator.</p></div></div>
    <div class="section-box" style="padding:0;overflow:hidden">
      <div class="chat big" id="phLog"></div>
      <div class="chatbar"><input id="phInput" placeholder="Write a message…"><button class="btn dark" id="phSend">Send</button></div>
    </div>`;
    const send=async()=>{const input=$('#phInput'),text=input.value.trim();if(!text)return;
      try{input.value='';await mutate('helpdesk',{method:'POST',body:JSON.stringify({body:text})});paintPhLog(dbCache.get('helpdesk')?.data||d)}
      catch(e){toast(e.message);if(input&&!input.value)input.value=text}};
    $('#phSend').onclick=send;
    $('#phInput').onkeydown=e=>{if(e.key==='Enter')send()};
  }
  paintPhLog(d);
}
/* ═══════════ BOOT ═══════════ */

async function boot(){
  if(state?.token){
    document.body.classList.remove('landing-mode');
    document.body.classList.add('dashboard-mode');
    app.innerHTML=loaderHtml('Connecting to database…');
    try{
      const fresh=await api('auth/session',{forceFresh:true});
      save({token:state.token,role:fresh.role,user:fresh.user});
      if(state.role==='admin')return adminApp();
      if(state.role==='partner')return partnerApp();
    }catch(e){
      localStorage.removeItem('ios.session');state=null;
      landing();
      toast(e.message||'Session expired. Please sign in again.');
      return;
    }
  }
  landing();
}
boot();
