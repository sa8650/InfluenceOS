/* Cloudflare Pages Function: InfluenceOS API (partner & influencer management).
   Separate database from EMS — uses IOS_SUPABASE_URL / IOS_SUPABASE_SERVICE_ROLE_KEY,
   and IOS_SESSION_SECRET for sessions. Mounted at /api/ios/* . */
const enc = new TextEncoder(), dec = new TextDecoder();
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const fail=(message,status=400)=>json({error:message},status);
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
async function hmac(v,key){return crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']),enc.encode(v));}
async function token(payload,key){let h=b64u(enc.encode(JSON.stringify({alg:'HS256',typ:'JWT'}))),p=b64u(enc.encode(JSON.stringify(payload)));return h+'.'+p+'.'+b64u(await hmac(h+'.'+p,key));}
async function session(req,key){let x=req.headers.get('authorization')?.replace('Bearer ','');if(!x)return null;let [h,p,s]=x.split('.');if(!h||!p||!s||b64u(await hmac(h+'.'+p,key))!==s)return null;let d=JSON.parse(dec.decode(unb64(p)));return d.exp>Date.now()/1000?d:null;}
const PBKDF2_ITERATIONS=100000;
async function hash(password,salt=b64u(crypto.getRandomValues(new Uint8Array(16)))){let bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:PBKDF2_ITERATIONS,hash:'SHA-256'},await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']),256);return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${b64u(bits)}`;}
async function check(password,stored){let [,i,s,v]=stored.split('$'),iterations=+i;if(!iterations||iterations>PBKDF2_ITERATIONS)return false;let bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(s),iterations,hash:'SHA-256'},await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']),256);return b64u(bits)===v;}
function db(env,path,opt={}){return fetch(env.IOS_SUPABASE_URL+'/rest/v1/'+path,{...opt,headers:{apikey:env.IOS_SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.IOS_SUPABASE_SERVICE_ROLE_KEY,Prefer:'return=representation',...(opt.headers||{})}}).then(async r=>{let x=await r.json().catch(()=>null);if(!r.ok)throw Error(x?.message||'Database request failed');return x;});}
async function body(req){try{return await req.json()}catch{return {}}}
const num=x=>Number(x)||0;
const catLabel=c=>String(c||'users').charAt(0).toUpperCase()+String(c||'users').slice(1);
/* ---------- ADMIN PERMISSIONS (board users; the primary owner always has full access) ---------- */
const PERM_MODULES={
  agents:['show','add','edit','delete'],
  projects:['show','add','edit','delete'],
  contribute:['show','edit'],
  allocations:['show','add','edit','delete'],
  payments:['show','add','edit','delete'],
  performance:['show'],
  vaultium:['show','delete','download','view'],
  connectx:['show','compose','settings','history'],
  users:['show','add','edit','delete']
};
const FULL_PERMS=Object.fromEntries(Object.entries(PERM_MODULES).map(([m,acts])=>[m,Object.fromEntries(acts.map(a=>[a,true]))]));
/* ---------- NOTIFICATIONS (admin & agent inboxes) ---------- */
const notifyAdmins=(env,kind,title,body,link)=>db(env,'notifications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_type:'admin',kind:String(kind).slice(0,40),title:String(title).slice(0,120),body:String(body||'').slice(0,300),link:link||null})}).catch(()=>{});
const notifyPartner=(env,pid,kind,title,body,link)=>(!pid?Promise.resolve():db(env,'notifications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_type:'partner',partner_id:pid,kind:String(kind).slice(0,40),title:String(title).slice(0,120),body:String(body||'').slice(0,300),link:link||null})})).catch(()=>{});
const cleanPerms=p=>{const o={};for(const[m,acts]of Object.entries(PERM_MODULES)){o[m]={};for(const a of acts)o[m][a]=!!(p&&p[m]&&p[m][a]);}return o;};
const PARTNER_TYPES=['youtuber','facebook','tiktoker','instagram','telegram','marketing_agent','agency'];
const PARTNER_STATUSES=['disagree','agree','not_response','waiting'];
const ALLOCATION_STATUSES=['on_target','active','behind','inactive'];
const PAYMENT_STATUSES=['scheduled','paid','pending'];
const cleanAccounts=list=>(Array.isArray(list)?list:[]).filter(a=>a&&(String(a.label||'').trim()||String(a.url||'').trim())).slice(0,5).map(a=>({label:String(a.label||'').trim().slice(0,60),url:String(a.url||'').trim().slice(0,300)}));
const cleanDate=v=>{v=String(v||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(v)?v:null};
const publicPartner=p=>{delete p.password_hash;return p};
const publicAdminUser=u=>{if(!u)return u;delete u.password_hash;return u};
const emailList=v=>String(v||'').split(/[;,]/).map(x=>x.trim().toLowerCase()).filter(Boolean);
const validEmail=x=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const safeText=x=>String(x||'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const CX_DEFAULT_TEMPLATES={
  allocation:`<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Allocation Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Start Date:</b> {{Start}}</p><p><b>Deadline:</b> {{Deadline}}</p><p><b>Target:</b> {{Target}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Commission:</b> {{Commission}}</p><p><b>Status:</b> {{Status}}</p></div>`,
  payments:`<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Payment Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Project:</b> {{Project}}</p><p><b>Amount:</b> {{Amount}}</p><p><b>Status:</b> {{Status}}</p></div>`,
  withdraw:`<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Withdrawal Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Withdrawal Method:</b> {{Method}}</p><p><b>Destination Account:</b> {{Destination}}</p><p><b>Amount Withdrawn:</b> {{Amount}}</p><p><b>Current Status:</b> {{Status}}</p><p><b>Transaction:</b> {{trx}}</p></div>`,
  contribute:`<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Contribution Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Status:</b> {{Status}}</p></div>`,
  performance:`<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Performance Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Rank:</b> {{Rank}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Assigned:</b> {{Assigned}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Achievement:</b> {{Achievement}}</p></div>`
};
const normalizeCxTemplate=html=>{
  let x=String(html||'');
  x=x.replace(/<!doctype[^>]*>/ig,'').replace(/<!--([\s\S]*?)-->/g,'');
  x=x.replace(/<script\b[\s\S]*?<\/script>/ig,'');
  x=x.replace(/<link\b[^>]*>/ig,'').replace(/<meta\b[^>]*>/ig,'').replace(/<title\b[\s\S]*?<\/title>/ig,'');
  const styles=[...x.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/ig)].map(m=>m[0]).join('\n');
  x=x.replace(/<style\b[^>]*>[\s\S]*?<\/style>/ig,'');
  const body=x.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  x=body?body[1]:x.replace(/<\/?html\b[^>]*>/ig,'').replace(/<head\b[\s\S]*?<\/head>/ig,'');
  return styles+x;
};
const cxTemplate=(cfg,type)=>normalizeCxTemplate(cfg?.[`${type}_template_html`]||CX_DEFAULT_TEMPLATES[type]||'');
const renderCxTemplate=(tpl,data={})=>String(tpl||'').replace(/{{\s*([^}]+?)\s*}}/g,(m,k)=>safeText(data[k.trim()]??data[k.trim().toLowerCase()]??''));

async function partnerStats(env,ids){
  const want=ids&&ids.length?ids:null;
  let [allocs,pays]=await Promise.all([db(env,'allocations?select=partner_id,project_id,assigned_target,acquired_users,commission'),db(env,'payments?select=partner_id,amount,status')]);
  const map={};
  const slot=id=>map[id]??={projects:0,acquired:0,income:0,paid:0};
  for(const a of allocs){if(want&&!want.includes(a.partner_id))continue;const s=slot(a.partner_id);s.projects++;s.acquired+=num(a.acquired_users);s.income+=num(a.commission);}
  for(const p of pays){if(p.status!=='paid'||(want&&!want.includes(p.partner_id)))continue;slot(p.partner_id).paid+=num(p.amount);}
  for(const k in map){map[k].income=Math.round(map[k].income*100)/100;map[k].paid=Math.round(map[k].paid*100)/100;map[k].balance=Math.round((map[k].income-map[k].paid)*100)/100;}
  return {stats:map,allocs,pays};
}
function allocToRow(a,projectMap,partnerMap){
  const p=partnerMap[a.partner_id]||{},pr=projectMap[a.project_id]||{};
  return {...a,partner_name:p.name||'—',partner_code:p.partner_code||'',project_name:pr.name||'—',project_start_date:pr.start_date||null,project_deadline:pr.deadline||null};
}
function payToRow(p,projectMap,partnerMap){
  const pr=partnerMap[p.partner_id]||{},pg=projectMap[p.project_id]||{};
  return {...p,partner_name:pr.name||'—',partner_code:pr.partner_code||'',project_name:pg.name||'—'};
}

const CATEGORIES=['views','clicks','sales','users','shares','reach','leads','profit','installs'];
const PROOF_TYPES=['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const PROOF_EXT=['png','jpg','jpeg','webp','gif','pdf','txt','doc','docx','xls','xlsx'];
const acctStr=a=>(Array.isArray(a)&&a.length?a.map(x=>`${x.label||'Account'}: ${x.url||''}`).join(' | '):'(none)');

export async function onRequest(context){
  const {request,env,params}=context, path=(params.path||[]).join('/'), method=request.method;
  try{
    {let missing=['IOS_SUPABASE_URL','IOS_SUPABASE_SERVICE_ROLE_KEY','IOS_SESSION_SECRET'].filter(k=>!env[k]);if(missing.length)return fail('InfluenceOS server configuration is incomplete: missing '+missing.join(', ')+'.',500);}

    /* ---------- AUTH ---------- */
    if(path==='auth/status'&&method==='GET'){
      let admins=await db(env,'admins?select=id&limit=1');
      return json({hasAdmin:admins.length>0});
    }
    if(path==='auth/admin/register'&&method==='POST'){
      let b=await body(request),email=String(b.email||'').trim().toLowerCase();
      let admins=await db(env,'admins?select=id&limit=1');
      if(admins.length)return fail('An administrator already exists. Please sign in.',409);
      if(!b.name||!email||!b.password||String(b.password).length<6)return fail('Name, email and a 6-character password are required.');
      let hashP=await hash(String(b.password));
      let [admin]=await db(env,'admins',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:String(b.name).slice(0,120),email,password_hash:hashP})});
      return json({token:await token({id:admin.id,role:'admin',exp:Math.floor(Date.now()/1000)+28800},env.IOS_SESSION_SECRET),user:{id:admin.id,name:admin.name,email:admin.email}});
    }
    if(path==='auth/admin/login'&&method==='POST'){
      let b=await body(request),email=String(b.email||'').trim().toLowerCase(),pass=String(b.password||'');
      let [admin]=await db(env,`admins?email=eq.${encodeURIComponent(email)}&select=*`);
      if(admin&&await check(pass,admin.password_hash))return json({token:await token({id:admin.id,role:'admin',kind:'owner',exp:Math.floor(Date.now()/1000)+28800},env.IOS_SESSION_SECRET),user:{id:admin.id,name:admin.name,email:admin.email,phone:admin.phone||'',address:admin.address||'',kind:'owner'}});
      let [user]=await db(env,`admin_users?email=eq.${encodeURIComponent(email)}&select=*`);
      if(!user||!await check(pass,user.password_hash))return fail('Invalid email or password.',401);
      if(user.status==='pending')return fail('Your account request is waiting for admin confirmation.',403);
      if(user.status!=='active')return fail('Your account is deactivated. Contact the administrator.',403);
      return json({token:await token({id:user.id,role:'admin',kind:'user',exp:Math.floor(Date.now()/1000)+28800},env.IOS_SESSION_SECRET),user:{...publicAdminUser(user),kind:'user'}});
    }
    if(path==='auth/user/register'&&method==='POST'){
      let b=await body(request),email=String(b.email||'').trim().toLowerCase();
      if(!b.name||!email||!b.phone||!b.address||!b.password||String(b.password).length<6)return fail('Name, phone, address, email and a 6-character password are required.');
      let [adminDup,userDup]=await Promise.all([db(env,`admins?email=eq.${encodeURIComponent(email)}&select=id`),db(env,`admin_users?email=eq.${encodeURIComponent(email)}&select=id`)]);
      if(adminDup.length||userDup.length)return fail('An admin/user account with this email already exists.',409);
      const [out]=await db(env,'admin_users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:String(b.name).slice(0,120),email,phone:String(b.phone).slice(0,40),address:String(b.address).slice(0,300),password_hash:await hash(String(b.password)),status:'pending'})});
      return json({ok:true,user:publicAdminUser(out),message:'Account request submitted. Wait for administrator confirmation.'},201);
    }
    if(path==='auth/partner/login'&&method==='POST'){
      let b=await body(request),id=String(b.identifier||'').trim().toLowerCase();
      if(!id||!b.password)return fail('Agent ID / email and password are required.');
      const byCode=/^\d{4}$/.test(id)?`partners?partner_code=eq.${id}&select=*`:`partners?email=eq.${encodeURIComponent(id)}&select=*`;
      let [p]=(await db(env,byCode)).filter(x=>x.email===id||String(b.identifier).trim()===x.partner_code);
      if(!p||!await check(String(b.password),p.password_hash))return fail('Invalid Agent ID / email or password.',401);
      if(!p.login_access)return fail('Login access is disabled for this agent account.',403);
      return json({token:await token({id:p.id,role:'partner',exp:Math.floor(Date.now()/1000)+28800},env.IOS_SESSION_SECRET),user:publicPartner(p)});
    }

    if(path==='auth/partner/register'&&method==='POST'){
      let b=await body(request),email=String(b.email||'').trim().toLowerCase();
      if(!b.name||!email||!b.phone||!b.address)return fail('Name, address, email and phone are required.');
      if(!PARTNER_TYPES.includes(b.type))return fail('Invalid type.');
      if(!b.password||String(b.password).length<6)return fail('Password must be at least 6 characters.');
      let exists=await db(env,`partners?email=eq.${encodeURIComponent(email)}&select=id`);
      if(exists.length)return fail('An account with this email already exists. Try signing in.',409);
      let partnerCode=null;
      for(let i=0;i<15;i++){let c=String(crypto.getRandomValues(new Uint32Array(1))[0]%9000+1000);let used=await db(env,`partners?partner_code=eq.${c}&select=id`);if(!used.length){partnerCode=c;break}}
      if(!partnerCode)throw Error('Could not allocate a 4-digit Agent ID. Please retry.');
      const [out]=await db(env,'partners',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_code:partnerCode,name:String(b.name).slice(0,120),email,phone:String(b.phone).slice(0,40),address:String(b.address).slice(0,300),type:b.type,accounts:[],password_hash:await hash(String(b.password)),login_access:true,status:'waiting',note:'Self-registered account — set status to Agree after review.'})});
      await notifyAdmins(env,'agents','New agent registered',(out.name||'A new agent')+' (#'+out.partner_code+') registered and is waiting for review.','partners');
      return json({token:await token({id:out.id,role:'partner',exp:Math.floor(Date.now()/1000)+28800},env.IOS_SESSION_SECRET),user:publicPartner(out),role:'partner'});
    }

    /* ---------- everything below requires a live database-validated session ---------- */
    let s=await session(request,env.IOS_SESSION_SECRET);
    if(!s)return fail('Please sign in.',401);
    const adminOnly=()=>fail('Administrator access required.',403);
    if(s.role!=='admin'&&s.role!=='partner')return fail('Invalid session.',403);

    let currentUser=null;
    if(s.role==='admin'){
      if(s.kind==='user'){
        let [user]=await db(env,`admin_users?id=eq.${s.id}&select=*`);
        if(!user)return fail('This user account no longer exists.',403);
        if(user.status==='pending')return fail('Your account request is waiting for admin confirmation.',403);
        if(user.status!=='active')return fail('Your account is deactivated. Contact the administrator.',403);
        currentUser={...publicAdminUser(user),kind:'user'};
      }else{
        let [admin]=await db(env,`admins?id=eq.${s.id}&select=id,name,email,phone,address`);
        if(!admin)return fail('This administrator account no longer exists.',403);
        currentUser={...admin,kind:'owner'};
      }
    }
    // partner sessions stay valid only while the account exists & keeps access
    if(s.role==='partner'){
      let [me]=await db(env,`partners?id=eq.${s.id}&select=*`);
      if(!me)return fail('This agent account no longer exists.',403);
      if(!me.login_access)return fail('Login access is disabled for this agent account.',403);
      currentUser=publicPartner(me);
    }
    const P=currentUser&&currentUser.kind==='user'?cleanPerms(currentUser.permissions):FULL_PERMS;
    const can=(m,a)=>!!(P[m]&&P[m][a]);
    const denied=()=>fail('Permission denied — your account does not have access to this action.',403);
    if(path==='auth/session'&&method==='GET')return json({role:s.role,user:currentUser,permissions:currentUser&&currentUser.kind==='user'?{_restricted:true,...P}:null});

    if(path==='notifications'&&method==='GET'){
      const q=s.role==='partner'?'notifications?partner_id=eq.'+s.id+'&user_type=eq.partner&order=created_at.desc&limit=50':'notifications?user_type=eq.admin&order=created_at.desc&limit=50';
      const rows=await db(env,q);
      return json({items:rows,unread:rows.filter(r=>!r.read).length});
    }
    if(path==='notifications/read'&&method==='POST'){
      let b=await body(request);
      const scope=s.role==='partner'?'notifications?partner_id=eq.'+s.id+'&user_type=eq.partner':'notifications?user_type=eq.admin';
      await db(env,scope+(b.id?'&id=eq.'+b.id:''),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({read:true})});
      return json({ok:true});
    }

    if(/^files\/[^/]+$/.test(path)&&method==='GET'){
      const id=path.split('/')[1];
      let [f]=await db(env,`contribution_files?id=eq.${id}&select=*`);
      if(!f)return fail('File not found.',404);
      if(s.role!=='admin'&&s.id!==f.partner_id)return fail('Permission denied.',403);
      if(s.role==='admin'&&!can('vaultium','view')&&!can('vaultium','download'))return denied();
      if(!env.VAULTIUM&&!env.IOS_PROOF)return fail('File storage is not configured.',500);
      let obj=env.VAULTIUM?await env.VAULTIUM.get(f.r2_key):null;
      if(!obj&&env.IOS_PROOF)obj=await env.IOS_PROOF.get(f.r2_key);
      if(!obj)return fail('File missing from storage.',404);
      return new Response(obj.body,{headers:{'content-type':obj.httpMetadata?.contentType||f.file_type||'application/octet-stream','content-disposition':`inline; filename="${f.file_name||'file'}"`,'cache-control':'private, no-store'}});
    }

    /* ---------- PARTNER (agent) SELF-SERVICE ---------- */
    if(s.role==='partner'){
      if(path==='me/profile'&&method==='GET'){
        let [me]=await db(env,`partners?id=eq.${s.id}&select=*`);
        return json(publicPartner(me));
      }
      if(path==='me/password'&&method==='POST'){
        let b=await body(request);
        if(!b.password||String(b.password).length<6)return fail('New password must be at least 6 characters.');
        await db(env,`partners?id=eq.${s.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({password_hash:await hash(String(b.password)),updated_at:new Date().toISOString()})});
        return json({ok:true});
      }
      if(path==='me/profile'&&method==='POST'){
        let b=await body(request),email=String(b.email||'').trim().toLowerCase();
        if(!b.name||!email||!b.phone)return fail('Name, email and phone are required.');
        if(b.address!==undefined&&String(b.address).length>300)return fail('Address is too long.');
        if(b.password&&String(b.password).length<6)return fail('Password must be at least 6 characters.');
        let dup=await db(env,`partners?email=eq.${encodeURIComponent(email)}&select=id`);
        if(dup.length&&dup[0].id!==s.id)return fail('An agent with this email already exists.',409);
        const accounts=cleanAccounts(b.accounts);
        if(accounts.length>5)return fail('Maximum 5 account URLs.');
        const [old]=await db(env,`partners?id=eq.${s.id}&select=*`);
        if(!old)return fail('Agent not found.',404);
        let patch={name:String(b.name).slice(0,120),email,phone:String(b.phone).slice(0,40),address:b.address!==undefined?String(b.address).slice(0,300):(old.address||null),accounts,updated_at:new Date().toISOString()};
        if(b.password)patch.password_hash=await hash(String(b.password));
        const [out]=await db(env,`partners?id=eq.${s.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
        const logs=[];
        if(old.name!==patch.name)logs.push({field:'Name',old_value:String(old.name||''),new_value:patch.name});
        if((old.email||'')!==patch.email)logs.push({field:'Email',old_value:String(old.email||''),new_value:patch.email});
        if(String(old.phone||'')!==patch.phone)logs.push({field:'Phone number',old_value:String(old.phone||''),new_value:patch.phone});
        if(String(old.address||'')!==String(patch.address||''))logs.push({field:'Address',old_value:String(old.address||''),new_value:String(patch.address||'')});
        if(JSON.stringify(old.accounts||[])!==JSON.stringify(accounts)){
          const norm=a=>String(a.label||'Account').trim().toLowerCase();
          const oldList=Array.isArray(old.accounts)?old.accounts:[],newList=accounts;
          const oldMap=new Map(oldList.map(a=>[norm(a),String(a.url||'')])),newMap=new Map(newList.map(a=>[norm(a),String(a.url||'')]));
          const oldLabel=new Map(oldList.map(a=>[norm(a),a.label||'Account'])),newLabel=new Map(newList.map(a=>[norm(a),a.label||'Account']));
          const removed=[],added=[],changed=[];
          for(const [l,u] of oldMap)if(!newMap.has(l))removed.push(`${oldLabel.get(l)}: ${u||'—'}`);
          for(const [l,u] of newMap){if(!oldMap.has(l))added.push(`${newLabel.get(l)}: ${u||'—'}`);else if(oldMap.get(l)!==u)changed.push(`${newLabel.get(l)}: ${oldMap.get(l)||'—'} → ${u||'—'}`)}
          logs.push({field:'Social accounts',old_value:removed.length?'Removed:\n'+removed.join('\n'):null,new_value:[...added.map(x=>'+ '+x),...changed.map(x=>'± '+x)].join('\n')||'No visible change'});
        }
        if(b.password)logs.push({field:'Password',old_value:'••••••',new_value:'••••••'});
        await Promise.all(logs.map(L=>db(env,'partner_logs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:s.id,field:L.field,old_value:L.old_value,new_value:L.new_value})})));
        return json(publicPartner(out));
      }
      const validatePaymentMethod=b=>{
        const method=String(b.method||'');
        if(!['bkash','nagad','crypto_usdt'].includes(method))return {error:'Invalid payment method.'};
        if(method==='crypto_usdt'){
          const w=String(b.wallet_address||'').trim();
          if(w.length<20||w.length>120)return {error:'Enter a valid USDT TRC20 wallet address.'};
          return {rec:{method,wallet_address:w,account_number:null,account_type:null}};
        }
        const digits=String(b.account_number||'').replace(/\D/g,'');
        if(digits.length<10||digits.length>14)return {error:'Enter a valid '+(method==='bkash'?'bKash':'Nagad')+' number (10–14 digits).'};
        if(!['agent','personal'].includes(b.account_type))return {error:'Choose Agent Number or Personal Number.'};
        return {rec:{method,account_number:digits,account_type:b.account_type,wallet_address:null}};
      };
      if(path==='me/payment-methods'&&method==='GET'){
        return json(await db(env,`payment_methods?partner_id=eq.${s.id}&select=*&order=created_at.asc`));
      }
      if(path==='me/payment-methods'&&method==='POST'){
        let b=await body(request),v=validatePaymentMethod(b);
        if(v.error)return fail(v.error,400);
        let existing=await db(env,`payment_methods?partner_id=eq.${s.id}&select=id`);
        if(existing.length>=5)return fail('You can save up to 5 payment methods.',400);
        const [out]=await db(env,'payment_methods',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:s.id,...v.rec})});
        return json(out,201);
      }
      if(path.startsWith('me/payment-methods/')&&(method==='PATCH'||method==='DELETE')){
        const id=path.split('/')[2];
        let [row]=await db(env,`payment_methods?id=eq.${id}&partner_id=eq.${s.id}&select=*`);
        if(!row)return fail('Payment method not found.',404);
        if(method==='DELETE'){await db(env,`payment_methods?id=eq.${id}`,{method:'DELETE'});return json({ok:true})}
        let b=await body(request),v=validatePaymentMethod({...row,...b});
        if(v.error)return fail(v.error,400);
        const [out]=await db(env,`payment_methods?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({...v.rec,updated_at:new Date().toISOString()})});
        return json(out);
      }
      if(path==='me/overview'&&method==='GET'){
        let [allocs,pays,projects,allAllocs,myWithdrawals]=await Promise.all([
          db(env,`allocations?partner_id=eq.${s.id}&select=*&order=created_at.desc`),
          db(env,`payments?partner_id=eq.${s.id}&select=*&order=payment_date.desc,created_at.desc`),
          db(env,'projects?select=*'),
          db(env,'allocations?select=partner_id,assigned_target,acquired_users'),
          db(env,`withdrawals?partner_id=eq.${s.id}&select=*&order=created_at.desc`)]);
        const projectMap=Object.fromEntries(projects.map(x=>[x.id,x]));
        const incomeSum=allocs.reduce((a,x)=>a+num(x.commission),0);
        const wdAccepted=myWithdrawals.filter(w=>w.status==='accepted').reduce((a,w)=>a+num(w.amount),0);
        const wdPending=myWithdrawals.filter(w=>w.status==='pending').reduce((a,w)=>a+num(w.amount),0);
        const stats={projects:new Set(allocs.map(a=>a.project_id)).size,acquired:allocs.reduce((a,x)=>a+num(x.acquired_users),0),income:Math.round(incomeSum*100)/100,paid:Math.round(wdAccepted*100)/100,balance:Math.round((incomeSum-wdAccepted-wdPending)*100)/100};
        const assigned=allocs.reduce((a,x)=>a+num(x.assigned_target),0),acquired=allocs.reduce((a,x)=>a+num(x.acquired_users),0);
        const byPartner={};
        for(const a of allAllocs){byPartner[a.partner_id]??={assigned:0,acquired:0};byPartner[a.partner_id].assigned+=num(a.assigned_target);byPartner[a.partner_id].acquired+=num(a.acquired_users);}
        const ranked=Object.entries(byPartner).map(([pid,v])=>({id:pid,...v,pct:v.assigned>0?Math.round(v.acquired/v.assigned*100):0})).sort((a,b)=>b.pct-a.pct||b.acquired-a.acquired);
        const rank=ranked.findIndex(x=>x.id===s.id)+1;
        return json({
          profile:null,
          stats,
          withdrawals:myWithdrawals,
          projects:allocs.map(a=>({id:a.id,project:projectMap[a.project_id]||null,category:a.category||'users',assigned_target:a.assigned_target,acquired_users:a.acquired_users,commission:a.commission,status:a.status,note:a.note,start_date:a.start_date||null,deadline:a.deadline||null,pct:num(a.assigned_target)>0?Math.round(num(a.acquired_users)/num(a.assigned_target)*100):0})),
          payments:pays.map(p=>{const ar=allocs.find(a=>a.project_id===p.project_id);return {...payToRow(p,projectMap,{[s.id]:{name:'',partner_code:''}}),start_date:ar?.start_date||null,deadline:ar?.deadline||null}}),
          performance:{projects:allocs.length,assigned,acquired,pct:assigned>0?Math.round(acquired/assigned*100):0,rank:rank||null,total:ranked.length}
        });
      }
      if(path==='contributions/mine'&&method==='GET'){
        let [rows,projects,files,allocs]=await Promise.all([
          db(env,`contributions?partner_id=eq.${s.id}&select=*&order=created_at.desc&limit=500`),
          db(env,'projects?select=id,name'),
          db(env,`contribution_files?partner_id=eq.${s.id}&select=*&order=created_at.asc`),
          db(env,'allocations?select=id,category,start_date,deadline')]);
        const pm=Object.fromEntries(projects.map(x=>[x.id,x.name])),am=Object.fromEntries(allocs.map(x=>[x.id,x]));
        return json(rows.map(c=>({...c,project_name:pm[c.project_id]||'—',category:am[c.allocation_id]?.category||'',start_date:am[c.allocation_id]?.start_date||null,deadline:am[c.allocation_id]?.deadline||null,files:files.filter(f=>f.contribution_id===c.id)})));
      }
      if(path==='contributions'&&method==='POST'){
        if(!env.VAULTIUM&&!env.IOS_PROOF)return fail('File storage is not configured. Add the VAULTIUM R2 bucket binding.',500);
        const bucket=env.VAULTIUM||env.IOS_PROOF;
        let form;try{form=await request.formData()}catch{return fail('Invalid form submission.')}
        const allocationId=String(form.get('allocation_id')||form.get('project_id')||''),acquired=Math.round(num(form.get('acquired'))),note=String(form.get('note')||'').slice(0,500);
        const files=form.getAll('file').filter(f=>f&&typeof f!=='string'&&f.size);
        if(!allocationId)return fail('Select a project.');
        if(!(acquired>0))return fail('Today acquired must be a number greater than zero.');
        if(!files.length)return fail('At least one proof file (image / file / document) is required.');
        if(files.length>10)return fail('Maximum 10 proof files per request.');
        for(const file of files){
          if(file.size>10*1024*1024)return fail(`Each proof file must be 10 MB or smaller (${file.name} is ${(file.size/1048576).toFixed(1)} MB).`);
          const ext=String(file.name||'').split('.').pop().toLowerCase();
          if(!PROOF_TYPES.includes(file.type)&&!PROOF_EXT.includes(ext))return fail(`Unsupported proof file type: ${file.name}. Use images, PDF, documents or spreadsheets.`);
        }
        let [alloc]=await db(env,`allocations?id=eq.${allocationId}&partner_id=eq.${s.id}&select=id,project_id`);
        if(!alloc)return fail('You have no allocation for the selected project.');
        const id=crypto.randomUUID();
        let code=null;
        for(let i2=0;i2<15;i2++){let c='C'+String(crypto.getRandomValues(new Uint32Array(1))[0]%90000+10000);let used=await db(env,`contributions?code=eq.${c}&select=id`);if(!used.length){code=c;break}}
        if(!code)throw Error('Could not allocate a contribution code. Please retry.');
        // Parent row FIRST — contribution_files has a foreign key to contributions.
        const [out]=await db(env,'contributions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,code,partner_id:s.id,project_id:alloc.project_id,allocation_id:alloc.id,acquired,note:note||null})});
        const saved=[];
        try{
          for(let i2=0;i2<files.length;i2++){
            const file=files[i2];
            const key=`ios/proof/${s.id}/${id}/${i2+1}-${String(file.name||'proof').replace(/[^\w.\- ]+/g,'_').slice(0,120)}`;
            await bucket.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:file.type||'application/octet-stream'}});
            const [row]=await db(env,'contribution_files',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contribution_id:id,partner_id:s.id,file_name:String(file.name||'proof').slice(0,200),file_type:file.type||null,file_size:file.size,r2_key:key})});
            saved.push(row);
          }
        }catch(e){
          // Roll back so no orphan files/rows remain.
          for(const f of saved){try{await (env.VAULTIUM||env.IOS_PROOF).delete(f.r2_key)}catch{}}
          try{await db(env,`contributions?id=eq.${id}`,{method:'DELETE'})}catch{}
          return fail('Could not save the proof files ('+(e.message||'storage error')+'). Please retry.',500);
        }
        let [me2]=await db(env,`partners?id=eq.${s.id}&select=name`);
        await notifyAdmins(env,'contribute','New contribution request',(me2?.name||'An agent')+' submitted '+acquired+' acquired ('+(code||'contribution')+') for review.','contribute');
        return json({...out,files:saved},201);
      }
      if(path==='helpdesk'&&method==='GET'){
        let rows=await db(env,`helpdesk_messages?partner_id=eq.${s.id}&select=*&order=created_at.asc&limit=1000`);
        const unread=rows.filter(m=>m.sender_type==='admin'&&!m.read_by_agent).length;
        if(unread)await db(env,`helpdesk_messages?partner_id=eq.${s.id}&sender_type=eq.admin&read_by_agent=eq.false`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({read_by_agent:true})});
        return json({messages:rows.map(m=>({...m,read_by_agent:true})),unread:0});
      }
      if(path==='helpdesk'&&method==='POST'){
        let b=await body(request),text=String(b.body||'').trim();
        if(!text)return fail('Message cannot be empty.');
        const [out]=await db(env,'helpdesk_messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:s.id,sender_type:'agent',sender_id:s.id,body:text.slice(0,2000),read_by_agent:true})});
        return json(out,201);
      }
      const TEAM_TYPES=['youtuber','facebook','tiktoker','instagram','telegram','marketing_agent','agency'];
      const publicMember=m=>{delete m.password_hash;return m};
      if(path==='me/team'&&method==='GET'){
        return json(await db(env,`team_members?partner_id=eq.${s.id}&select=*&order=created_at.asc`));
      }
      if(path==='me/team'&&method==='POST'){
        let b=await body(request),email=String(b.email||'').trim().toLowerCase();
        if(!b.name||!email||!b.phone)return fail('Name, email and phone are required.');
        if(!b.password||String(b.password).length<6)return fail('Password must be at least 6 characters.');
        if(!TEAM_TYPES.includes(b.type))return fail('Invalid team type.');
        if(!['active','inactive'].includes(b.status))return fail('Invalid team status.');
        let dup=await db(env,`team_members?email=eq.${encodeURIComponent(email)}&select=id`);
        if(dup.length)return fail('A team member with this email already exists.',409);
        let code=null;
        for(let i2=0;i2<15;i2++){let c=String(crypto.getRandomValues(new Uint32Array(1))[0]%9000+1000);let used=await db(env,`team_members?code=eq.${c}&select=id`);if(!used.length){code=c;break}}
        if(!code)throw Error('Could not allocate a 4-digit team code. Please retry.');
        const [out]=await db(env,'team_members',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:s.id,code,name:String(b.name).slice(0,120),email,phone:String(b.phone).slice(0,40),type:b.type,accounts:cleanAccounts(b.accounts),password_hash:await hash(String(b.password)),login_access:b.login_access!==false,status:b.status,note:b.note?String(b.note).slice(0,500):null})});
        return json(publicMember(out),201);
      }
      if(path.startsWith('me/team/')&&(method==='PATCH'||method==='DELETE')){
        const id=path.split('/')[2];
        let [row]=await db(env,`team_members?id=eq.${id}&partner_id=eq.${s.id}&select=*`);
        if(!row)return fail('Team member not found.',404);
        if(method==='DELETE'){await db(env,`team_members?id=eq.${id}`,{method:'DELETE'});return json({ok:true})}
        let b=await body(request),patch={updated_at:new Date().toISOString()};
        for(const k of ['name','phone','note'])if(b[k]!==undefined)patch[k]=String(b[k]).slice(0,500);
        if(b.email!==undefined){let email=String(b.email).trim().toLowerCase();if(!email)return fail('Email cannot be empty.');let dup=await db(env,`team_members?email=eq.${encodeURIComponent(email)}&select=id`);if(dup.length&&dup[0].id!==id)return fail('A team member with this email already exists.',409);patch.email=email;}
        if(b.type!==undefined){if(!TEAM_TYPES.includes(b.type))return fail('Invalid team type.');patch.type=b.type}
        if(b.status!==undefined){if(!['active','inactive'].includes(b.status))return fail('Invalid team status.');patch.status=b.status}
        if(b.login_access!==undefined)patch.login_access=!!b.login_access;
        if(b.accounts!==undefined)patch.accounts=cleanAccounts(b.accounts);
        if(b.password)patch.password_hash=await hash(String(b.password));
        const [out]=await db(env,`team_members?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
        return json(publicMember(out));
      }
      if(path==='me/allocations'&&method==='GET'){
        let [allocs,projects,teamAllocs,members]=await Promise.all([
          db(env,`allocations?partner_id=eq.${s.id}&select=*&order=created_at.desc`),
          db(env,'projects?select=id,name'),
          db(env,`team_allocations?partner_id=eq.${s.id}&select=*&order=created_at.desc`),
          db(env,`team_members?partner_id=eq.${s.id}&select=id,name,code`)]);
        const pm=Object.fromEntries(projects.map(x=>[x.id,x.name])),mm=Object.fromEntries(members.map(x=>[x.id,x]));
        return json({mine:allocs.map(a=>({...a,project_name:pm[a.project_id]||'—'})),
          team:teamAllocs.map(t=>({...t,project_name:pm[t.project_id]||'—',member_name:mm[t.team_member_id]?.name||'—',member_code:mm[t.team_member_id]?.code||''}))});
      }
      if(path==='me/team-allocations'&&method==='POST'){
        let b=await body(request);
        if(!b.team_member_id||!b.allocation_id)return fail('Team member and your project allocation are required.');
        if(!ALLOCATION_STATUSES.includes(b.status))return fail('Invalid allocation status.');
        let [member]=await db(env,`team_members?id=eq.${b.team_member_id}&partner_id=eq.${s.id}&select=id`);
        if(!member)return fail('Team member not found in your team.',404);
        let [ownAlloc]=await db(env,`allocations?id=eq.${b.allocation_id}&partner_id=eq.${s.id}&select=id,project_id,category`);
        if(!ownAlloc)return fail('Project allocation not found among your allocations.',404);
        const category=ownAlloc.category||'users';
        let dup=await db(env,`team_allocations?partner_id=eq.${s.id}&team_member_id=eq.${b.team_member_id}&project_id=eq.${ownAlloc.project_id}&category=eq.${category}&select=id`);
        if(dup.length)return fail('This team member already has this project with the “'+category+'” category.',409);
        const [out]=await db(env,'team_allocations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:s.id,team_member_id:b.team_member_id,project_id:ownAlloc.project_id,category,assigned_target:Math.max(0,Math.round(num(b.assigned_target))),acquired_users:0,note:b.note?String(b.note).slice(0,500):null,status:b.status})});
        return json(out,201);
      }
      if(path.startsWith('me/team-allocations/')&&(method==='PATCH'||method==='DELETE')){
        const id=path.split('/')[2];
        let [row]=await db(env,`team_allocations?id=eq.${id}&partner_id=eq.${s.id}&select=*`);
        if(!row)return fail('Team allocation not found.',404);
        if(method==='DELETE'){await db(env,`team_allocations?id=eq.${id}`,{method:'DELETE'});return json({ok:true})}
        let b=await body(request),patch={updated_at:new Date().toISOString()};
        if(b.assigned_target!==undefined)patch.assigned_target=Math.max(0,Math.round(num(b.assigned_target)));
        if(b.acquired_users!==undefined)patch.acquired_users=Math.max(0,Math.round(num(b.acquired_users)));
        if(b.note!==undefined)patch.note=String(b.note).slice(0,500);
        if(b.status!==undefined){if(!ALLOCATION_STATUSES.includes(b.status))return fail('Invalid allocation status.');patch.status=b.status}
        const [out]=await db(env,`team_allocations?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
        return json(out);
      }
      if(path==='withdrawals'&&method==='GET'){
        return json(await db(env,`withdrawals?partner_id=eq.${s.id}&select=*&order=created_at.desc`));
      }
      if(path==='withdrawals'&&method==='POST'){
        let b=await body(request),amount=num(b.amount);
        if(amount<=0)return fail('Withdrawal amount must be greater than zero.');
        let [pm]=await db(env,`payment_methods?id=eq.${String(b.payment_method_id||'')}&partner_id=eq.${s.id}&select=*`);
        if(!pm)return fail('Select one of your saved payment methods.');
        let [allocs,wd]=await Promise.all([
          db(env,`allocations?partner_id=eq.${s.id}&select=commission`),
          db(env,`withdrawals?partner_id=eq.${s.id}&select=amount,status`)]);
        const income=allocs.reduce((a,x)=>a+num(x.commission),0);
        const accepted=wd.filter(w=>w.status==='accepted').reduce((a,w)=>a+num(w.amount),0);
        const pending=wd.filter(w=>w.status==='pending').reduce((a,w)=>a+num(w.amount),0);
        const available=Math.round((income-accepted-pending)*100)/100;
        if(amount>available)return fail(`Withdrawal amount cannot exceed your available balance (${available.toFixed(2)}).`,400);
        const [out]=await db(env,'withdrawals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:s.id,payment_method_id:pm.id,method:pm.method,account_type:pm.account_type||null,account_number:pm.account_number||null,wallet_address:pm.wallet_address||null,amount:Math.round(amount*100)/100,status:'pending'})});
        await notifyAdmins(env,'withdraw','Withdrawal request',(currentUser.name||'An agent')+' requested $'+(Math.round(amount*100)/100).toFixed(2)+' via '+(pm.method==='crypto_usdt'?'USDT TRC20':pm.method)+' — waiting for your approval.','payments');
        return json(out,201);
      }
      return fail('Not found.',404);
    }

    /* ---------- ADMIN API ---------- */


    if(path==='connectx/settings'&&method==='GET'){
      if(!can('connectx','settings'))return denied();
      let [cfg]=await db(env,'connectx_settings?id=eq.1&select=*');
      const out={...{id:1,enabled:true,from_name:'InfluenceOS',from_email:'no-reply@doxtox.com',reply_to:null,global_daily_limit:500},...(cfg||{})};
      for(const [k,v] of Object.entries(CX_DEFAULT_TEMPLATES)){if(!out[k+'_template_html'])out[k+'_template_html']=v}
      return json(out);
    }
    if(path==='connectx/settings'&&method==='PATCH'){
      if(!can('connectx','settings'))return denied();
      let b=await body(request),patch={updated_at:new Date().toISOString()};
      if(b.enabled!==undefined)patch.enabled=!!b.enabled;
      if(b.from_name!==undefined)patch.from_name=String(b.from_name||'InfluenceOS').slice(0,120);
      if(b.from_email!==undefined){let e=String(b.from_email||'').trim().toLowerCase();if(!validEmail(e))return fail('Valid From email is required.');patch.from_email=e;}
      if(b.reply_to!==undefined){let e=String(b.reply_to||'').trim().toLowerCase();if(e&&!validEmail(e))return fail('Reply-to email must be valid.');patch.reply_to=e||null;}
      if(b.global_daily_limit!==undefined)patch.global_daily_limit=Math.max(0,Math.round(num(b.global_daily_limit)));
      for(const k of ['allocation_template_html','payments_template_html','withdraw_template_html','contribute_template_html','performance_template_html'])if(b[k]!==undefined)patch[k]=String(b[k]).slice(0,20000);
      let [cfg]=await db(env,'connectx_settings?id=eq.1',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      return json(cfg);
    }

    if(path==='connectx/contacts'&&method==='GET'){
      if(!can('connectx','show'))return denied();
      const type=new URL(request.url).searchParams.get('type')||'agent';
      if(type==='agent')return json((await db(env,'partners?select=id,partner_code,name,email,phone,status,type&order=created_at.desc')).map(x=>({id:x.id,type:'agent',code:x.partner_code,name:x.name,email:x.email,phone:x.phone,status:x.status,subtitle:'#'+x.partner_code+' · '+(x.type||'agent')})));
      if(type==='user')return json((await db(env,'admin_users?status=eq.active&select=id,name,email,phone,status&order=created_at.desc')).map(x=>({id:x.id,type:'user',code:'USER',name:x.name,email:x.email,phone:x.phone,status:x.status,subtitle:'Board user'})));
      return fail('Invalid recipient type. Use agent or user.',400);
    }
    if(path==='connectx/messages'&&method==='GET'){
      if(!can('connectx','history'))return denied();
      return json(await db(env,'connectx_messages?select=*&order=created_at.desc&limit=300'));
    }
    if(path==='connectx/send'&&method==='POST'){
      if(!can('connectx','compose'))return denied();
      let b=await body(request),recipientType=['agent','user','manual'].includes(b.recipientType)?b.recipientType:'manual';
      let to=emailList(b.to),cc=emailList(b.cc),bcc=emailList(b.bcc),recipientName=String(b.recipientName||'').slice(0,160),recipientId=b.recipientId||null;
      if(recipientType==='agent'&&recipientId){let [r]=await db(env,`partners?id=eq.${recipientId}&select=id,name,email`);if(!r)return fail('Selected agent was not found.',404);recipientName=r.name;to=to.length?to:[r.email];}
      if(recipientType==='user'&&recipientId){let [r]=await db(env,`admin_users?id=eq.${recipientId}&select=id,name,email,status`);if(!r)return fail('Selected user was not found.',404);if(r.status!=='active')return fail('Selected user is not active.',400);recipientName=r.name;to=to.length?to:[r.email];}
      if(!to.length||![...to,...cc,...bcc].every(validEmail))return fail('Valid recipient email is required.');
      if(!String(b.subject||'').trim())return fail('Subject is required.');
      let [cfg]=await db(env,'connectx_settings?id=eq.1&select=*');
      cfg=cfg||{enabled:true,from_name:'InfluenceOS',from_email:'no-reply@doxtox.com',global_daily_limit:500};
      if(!cfg?.enabled)return fail('ConnectX sending is disabled.',403);
      let today=new Date().toISOString().slice(0,10),used=await db(env,`connectx_messages?created_at=gte.${today}T00:00:00Z&status=eq.sent&select=id`);
      if(used.length>=Number(cfg.global_daily_limit||0))return fail('ConnectX daily email limit has been reached.',429);
      const senderName=cfg.from_name||'InfluenceOS',fromEmail=cfg.from_email||'no-reply@doxtox.com';
      let attachmentHtml='',templateStyles='';
      const att=b.attachment&&typeof b.attachment==='object'?b.attachment:null;
      if(att&&['allocation','payments','withdraw','contribute','performance'].includes(att.type)){
        attachmentHtml=renderCxTemplate(cxTemplate(cfg,att.type),att.data||{});
        templateStyles=[...attachmentHtml.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/ig)].map(m=>m[0]).join('\n');
        attachmentHtml=attachmentHtml.replace(/<style\b[^>]*>[\s\S]*?<\/style>/ig,'');
      }
      let html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+templateStyles+'</head><body style="margin:0;padding:16px;background:#f4f6fa"><div style="font-family:Arial,sans-serif;color:#172033;line-height:1.55">'+(String(b.body||'').trim()?safeText(b.body||'').replace(/\n/g,'<br>'):'')+attachmentHtml+'</div></body></html>';
      let [msg]=await db(env,'connectx_messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sender_id:s.id,sender_kind:s.kind==='user'?'user':'owner',recipient_type:recipientType,recipient_id:recipientId,recipient_name:recipientName||null,from_email:fromEmail,to_emails:to,cc_emails:cc,bcc_emails:bcc,subject:String(b.subject).trim().slice(0,220),custom_body:String(b.body||'').slice(0,10000),body_html:html,provider:'brevo_api',status:'sending'})});
      if(!env.BREVO_API_KEY){await db(env,`connectx_messages?id=eq.${msg.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'failed',error_message:'BREVO_API_KEY is not configured.',updated_at:new Date().toISOString()})});return fail('ConnectX provider is not configured. Add BREVO_API_KEY to Cloudflare secrets.',503)}
      let res=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':env.BREVO_API_KEY,'content-type':'application/json'},body:JSON.stringify({sender:{name:senderName,email:fromEmail},replyTo:cfg.reply_to?{email:cfg.reply_to}:undefined,to:to.map(email=>({email})),...(cc.length?{cc:cc.map(email=>({email}))}:{}),...(bcc.length?{bcc:bcc.map(email=>({email}))}:{}),subject:msg.subject,htmlContent:html})}),out=await res.json().catch(()=>({}));
      if(!res.ok){await db(env,`connectx_messages?id=eq.${msg.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'failed',error_message:out.message||'Provider rejected message',updated_at:new Date().toISOString()})});return fail('Email could not be sent: '+(out.message||'provider rejected message'),502)}
      await db(env,`connectx_messages?id=eq.${msg.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'sent',provider_message_id:out.messageId||null,sent_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
      return json({ok:true,id:msg.id,messageId:out.messageId||null},201);
    }

    if(path==='admin/profile'&&method==='GET'){
      return json(currentUser);
    }
    if(path==='admin/profile'&&method==='PATCH'){
      let b=await body(request),patch={};
      for(const k of ['name','phone','address'])if(b[k]!==undefined)patch[k]=String(b[k]).slice(0,k==='address'?300:120);
      if(b.email!==undefined){
        let email=String(b.email).trim().toLowerCase();if(!email)return fail('Email cannot be empty.');
        let [adminDup,userDup]=await Promise.all([db(env,`admins?email=eq.${encodeURIComponent(email)}&select=id`),db(env,`admin_users?email=eq.${encodeURIComponent(email)}&select=id`)]);
        const selfOwner=s.kind!=='user', selfUser=s.kind==='user';
        if((adminDup.length&&!(selfOwner&&adminDup[0].id===s.id))||(userDup.length&&!(selfUser&&userDup[0].id===s.id)))return fail('Another admin/user already uses this email.',409);
        patch.email=email;
      }
      if(b.password){if(String(b.password).length<6)return fail('Password must be at least 6 characters.');patch.password_hash=await hash(String(b.password));}
      const table=s.kind==='user'?'admin_users':'admins';
      if(table==='admin_users')patch.updated_at=new Date().toISOString();
      const [out]=await db(env,`${table}?id=eq.${s.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      return json({...publicAdminUser(out),kind:s.kind==='user'?'user':'owner'});
    }
    if(path==='admin/users'&&method==='GET'){
      if(!can('users','show'))return denied();
      let rows=await db(env,'admin_users?select=*&order=created_at.desc');
      return json(rows.map(publicAdminUser));
    }
    if(path==='admin/users'&&method==='POST'){
      if(!can('users','add'))return denied();
      let b=await body(request),email=String(b.email||'').trim().toLowerCase();
      if(!b.name||!email||!b.phone||!b.address||!b.password||String(b.password).length<6)return fail('Name, phone, address, email and a 6-character password are required.');
      const status=['active','inactive','pending'].includes(b.status)?b.status:'active';
      let [adminDup,userDup]=await Promise.all([db(env,`admins?email=eq.${encodeURIComponent(email)}&select=id`),db(env,`admin_users?email=eq.${encodeURIComponent(email)}&select=id`)]);
      if(adminDup.length||userDup.length)return fail('An admin/user with this email already exists.',409);
      const permissions=currentUser.kind==='user'?FULL_PERMS:cleanPerms(b.permissions||FULL_PERMS);
      const [out]=await db(env,'admin_users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:String(b.name).slice(0,120),email,phone:String(b.phone).slice(0,40),address:String(b.address).slice(0,300),password_hash:await hash(String(b.password)),status,permissions})});
      return json(publicAdminUser(out),201);
    }
    if(path.startsWith('admin/users/')&&(method==='PATCH'||method==='DELETE')){
      if(!can('users',method==='PATCH'?'edit':'delete'))return denied();
      let id=path.split('/')[2];
      if(method==='DELETE'){await db(env,`admin_users?id=eq.${id}`,{method:'DELETE'});return json({ok:true})}
      let b=await body(request),patch={updated_at:new Date().toISOString()};
      for(const k of ['name','phone','address'])if(b[k]!==undefined)patch[k]=String(b[k]).slice(0,k==='address'?300:120);
      if(b.email!==undefined){let email=String(b.email).trim().toLowerCase();if(!email)return fail('Email cannot be empty.');let [adminDup,userDup]=await Promise.all([db(env,`admins?email=eq.${encodeURIComponent(email)}&select=id`),db(env,`admin_users?email=eq.${encodeURIComponent(email)}&select=id`)]);if(adminDup.length||(userDup.length&&userDup[0].id!==id))return fail('Another admin/user already uses this email.',409);patch.email=email;}
      if(b.status!==undefined){if(!['active','inactive','pending'].includes(b.status))return fail('Invalid user status.');patch.status=b.status;}
      if(b.password){if(String(b.password).length<6)return fail('Password must be at least 6 characters.');patch.password_hash=await hash(String(b.password));}
      if(b.permissions!==undefined){if(currentUser.kind==='user')return fail('Only the primary administrator can change permissions.',403);patch.permissions=cleanPerms(b.permissions);}
      const [out]=await db(env,`admin_users?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      return json(publicAdminUser(out));
    }

    if(path==='overview'&&method==='GET'){
      let [partners,projects,allocs,pays]=await Promise.all([
        db(env,'partners?select=id,name,partner_code,status,type&order=created_at.desc'),
        db(env,'projects?select=*&order=created_at.desc'),
        db(env,'allocations?select=*&order=created_at.desc'),
        db(env,'payments?select=*&order=payment_date.desc,created_at.desc&limit=500')
      ]);
      const projectMap=Object.fromEntries(projects.map(x=>[x.id,x])),partnerMap=Object.fromEntries(partners.map(x=>[x.id,x]));
      let income=0,assigned=0,acquired=0;
      for(const a of allocs){income+=num(a.commission);assigned+=num(a.assigned_target);acquired+=num(a.acquired_users);}
      let withdrawals=await db(env,'withdrawals?select=amount,status');
      const wdPaid=withdrawals.filter(w=>w.status==='accepted').reduce((a,w)=>a+num(w.amount),0);
      const wdLocked=withdrawals.filter(w=>w.status==='pending').reduce((a,w)=>a+num(w.amount),0);
      return json({
        kpis:{
          totalPartners:partners.length,
          activeProjects:projects.filter(p=>p.status==='active').length,
          assignedTarget:assigned,
          acquiredUsers:acquired,
          totalIncome:Math.round(income*100)/100,
          totalPaid:Math.round(wdPaid*100)/100,
          remainingBalance:Math.round((income-wdPaid-wdLocked)*100)/100,
          overallPerformance:assigned>0?Math.round(acquired/assigned*100):0
        },
        contributions:allocs.map(a=>allocToRow(a,projectMap,partnerMap)),
        projects:projects.map(p=>({id:p.id,name:p.name,status:p.status,target:allocs.filter(a=>a.project_id===p.id).reduce((x,a)=>x+num(a.assigned_target),0),acquired:allocs.filter(a=>a.project_id===p.id).reduce((x,a)=>x+num(a.acquired_users),0),partners:new Set(allocs.filter(a=>a.project_id===p.id).map(a=>a.partner_id)).size})),
        upcoming:pays.filter(p=>p.status!=='paid').slice(0,6).map(p=>payToRow(p,projectMap,partnerMap))
      });
    }

    if(path==='partners'&&method==='GET'){
      if(!can('agents','show'))return denied();
      let [partners,projects,allocs,withdrawals]=await Promise.all([
        db(env,'partners?select=*&order=created_at.desc'),
        db(env,'projects?select=id,name'),
        db(env,'allocations?select=partner_id,project_id,assigned_target,acquired_users,commission'),
        db(env,'withdrawals?select=partner_id,amount,status')]);
      const projectMap=Object.fromEntries(projects.map(x=>[x.id,x.name]));
      return json(partners.map(p=>{
        const rows=allocs.filter(a=>a.partner_id===p.id);
        const income=rows.reduce((a,x)=>a+num(x.commission),0);
        const wd=withdrawals.filter(x=>x.partner_id===p.id);
        const paid=wd.filter(x=>x.status==='accepted').reduce((a,x)=>a+num(x.amount),0);
        const locked=wd.filter(x=>x.status==='pending').reduce((a,x)=>a+num(x.amount),0);
        return {...publicPartner(p),projects:rows.length,project_names:[...new Set(rows.map(r=>projectMap[r.project_id]))].filter(Boolean),
          acquired_users:rows.reduce((a,x)=>a+num(x.acquired_users),0),
          income:Math.round(income*100)/100,paid:Math.round(paid*100)/100,balance:Math.round((income-paid-locked)*100)/100};
      }));
    }
    if(path==='partners'&&method==='POST'){
      if(!can('agents','add'))return denied();
      let b=await body(request),email=String(b.email||'').trim().toLowerCase();
      if(!b.name||!email||!b.phone)return fail('Name, email and phone are required.');
      if(!String(b.password||'')||String(b.password).length<6)return fail('Password must be at least 6 characters.');
      if(!PARTNER_TYPES.includes(b.type))return fail('Invalid partner type.');
      if(!PARTNER_STATUSES.includes(b.status))return fail('Invalid partner status.');
      let exists=await db(env,`partners?email=eq.${encodeURIComponent(email)}&select=id`);
      if(exists.length)return fail('An agent with this email already exists.',409);
      let partnerCode=null;
      for(let i=0;i<15;i++){let code=String(crypto.getRandomValues(new Uint32Array(1))[0]%9000+1000);let used=await db(env,`partners?partner_code=eq.${code}&select=id`);if(!used.length){partnerCode=code;break}}
      if(!partnerCode)throw Error('Could not allocate a 4-digit Partner ID. Please retry.');
      let [out]=await db(env,'partners',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_code:partnerCode,name:String(b.name).slice(0,120),email,phone:String(b.phone).slice(0,40),address:b.address?String(b.address).slice(0,300):null,type:b.type,accounts:cleanAccounts(b.accounts),password_hash:await hash(String(b.password)),login_access:b.login_access!==false,status:b.status,note:b.note?String(b.note).slice(0,500):null})});
      return json(publicPartner(out),201);
    }
    if(path.startsWith('partners/')&&method==='PATCH'){
      if(!can('agents','edit'))return denied();
      let id=path.split('/')[1],[existing]=await db(env,`partners?id=eq.${id}&select=*`);
      if(!existing)return fail('Agent not found.',404);
      let b=await body(request),patch={updated_at:new Date().toISOString()};
      for(const k of ['name','phone','note','address'])if(b[k]!==undefined)patch[k]=String(b[k]).slice(0,500);
      if(b.email!==undefined){let email=String(b.email).trim().toLowerCase();if(!email)return fail('Email cannot be empty.');let dup=await db(env,`partners?email=eq.${encodeURIComponent(email)}&select=id`);if(dup.length&&dup[0].id!==id)return fail('An agent with this email already exists.',409);patch.email=email;}
      if(b.type!==undefined){if(!PARTNER_TYPES.includes(b.type))return fail('Invalid partner type.');patch.type=b.type}
      if(b.status!==undefined){if(!PARTNER_STATUSES.includes(b.status))return fail('Invalid partner status.');patch.status=b.status}
      if(b.login_access!==undefined)patch.login_access=!!b.login_access;
      if(b.accounts!==undefined)patch.accounts=cleanAccounts(b.accounts);
      if(b.password)patch.password_hash=await hash(String(b.password));
      let [out]=await db(env,`partners?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      return json(publicPartner(out));
    }
    if(path.startsWith('partners/')&&method==='DELETE'){
      if(!can('agents','delete'))return denied();
      let id=path.split('/')[1];
      await db(env,`partners?id=eq.${id}`,{method:'DELETE'});
      return json({ok:true});
    }

    if(path==='projects'&&method==='GET'){
      if(!can('projects','show'))return denied();
      let [projects,allocs]=await Promise.all([
        db(env,'projects?select=*&order=created_at.desc'),
        db(env,'allocations?select=project_id,partner_id,category,assigned_target,acquired_users,commission')]);
      return json(projects.map(p=>{
        const rows=allocs.filter(a=>a.project_id===p.id);
        const used=rows.reduce((a,x)=>a+num(x.commission),0);
        const byCat={};
        for(const a of rows){const c=a.category||'users';byCat[c]??={category:c,target:0,acquired:0};byCat[c].target+=num(a.assigned_target);byCat[c].acquired+=num(a.acquired_users);}
        return {...p,target_users:rows.reduce((a,x)=>a+num(x.assigned_target),0),acquired_users:rows.reduce((a,x)=>a+num(x.acquired_users),0),categories:Object.values(byCat).sort((a,b)=>a.category<b.category?-1:1),used_budget:Math.round(used*100)/100,remaining_budget:Math.round((num(p.budget)-used)*100)/100,partner_count:new Set(rows.map(r=>r.partner_id)).size};
      }));
    }
    if(path==='projects'&&method==='POST'){
      if(!can('projects','add'))return denied();
      let b=await body(request);
      if(!b.name)return fail('Project name is required.');
      if(num(b.budget)<0)return fail('Budget cannot be negative.');
      let [out]=await db(env,'projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:String(b.name).slice(0,120),details:b.details?String(b.details).slice(0,1000):null,budget:num(b.budget),start_date:cleanDate(b.start_date),deadline:cleanDate(b.deadline),note:b.note?String(b.note).slice(0,500):null,status:b.status==='inactive'?'inactive':'active'})});
      return json(out,201);
    }
    if(path.startsWith('projects/')&&(method==='PATCH'||method==='DELETE')){
      if(!can('projects',method==='PATCH'?'edit':'delete'))return denied();
      let id=path.split('/')[1];
      if(method==='DELETE'){await db(env,`projects?id=eq.${id}`,{method:'DELETE'});return json({ok:true})}
      let b=await body(request),patch={updated_at:new Date().toISOString()};
      for(const k of ['name','details','note'])if(b[k]!==undefined)patch[k]=String(b[k]).slice(0,1000);
      if(b.budget!==undefined)patch.budget=num(b.budget);
      if(b.start_date!==undefined)patch.start_date=cleanDate(b.start_date);
      if(b.deadline!==undefined)patch.deadline=cleanDate(b.deadline);
      if(b.status!==undefined)patch.status=b.status==='inactive'?'inactive':'active';
      let [out]=await db(env,`projects?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      return json(out);
    }

    if(path==='allocations'&&method==='GET'){
      if(!can('allocations','show'))return denied();
      let [allocs,projects,partners]=await Promise.all([db(env,'allocations?select=*&order=created_at.desc'),db(env,'projects?select=id,name,start_date,deadline'),db(env,'partners?select=id,name,partner_code')]);
      const pm=Object.fromEntries(projects.map(x=>[x.id,x])),sm=Object.fromEntries(partners.map(x=>[x.id,x]));
      return json(allocs.map(a=>allocToRow(a,pm,sm)));
    }
    if(path==='allocations'&&method==='POST'){
      if(!can('allocations','add'))return denied();
      let b=await body(request);
      if(!b.project_id||!b.partner_id)return fail('Project and agent are required.');
      if(!ALLOCATION_STATUSES.includes(b.status))return fail('Invalid allocation status.');
      const category=CATEGORIES.includes(b.category)?b.category:'users';
      let [project]=await db(env,`projects?id=eq.${b.project_id}&select=id,name`);
      let [partner]=await db(env,`partners?id=eq.${b.partner_id}&select=id,status`);
      if(!project)return fail('Project not found.',404);
      if(!partner)return fail('Agent not found.',404);
      if(partner.status!=='agree')return fail('Only agents with status “Agree” can be allocated to a project.',400);
      let dup=await db(env,`allocations?project_id=eq.${b.project_id}&partner_id=eq.${b.partner_id}&category=eq.${category}&select=id`);
      if(dup.length)return fail('This agent already has an allocation for this project with the “'+category+'” category.',409);
      let [out]=await db(env,'allocations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:b.project_id,partner_id:b.partner_id,category,assigned_target:Math.max(0,Math.round(num(b.assigned_target))),acquired_users:0,commission:0,start_date:cleanDate(b.start_date),deadline:cleanDate(b.deadline),note:b.note?String(b.note).slice(0,500):null,status:b.status})});
      await notifyPartner(env,b.partner_id,'allocation','New allocation assigned','You got a new target on project "'+(project.name||'a project')+'" — '+catLabel(category).toLowerCase()+' target '+Number(out.assigned_target||0).toLocaleString()+'.','allocations');
      return json(out,201);
    }
    if(path.startsWith('allocations/')&&(method==='PATCH'||method==='DELETE')){
      if(!can('allocations',method==='PATCH'?'edit':'delete'))return denied();
      let id=path.split('/')[1];
      if(method==='DELETE'){let [gone]=await db(env,`allocations?id=eq.${id}&select=partner_id,project_id`);await db(env,`allocations?id=eq.${id}`,{method:'DELETE'});await notifyPartner(env,gone&&gone.partner_id,'allocation','Allocation removed','One of your allocations was removed by the administrator.','allocations');return json({ok:true})}
      let b=await body(request),patch={updated_at:new Date().toISOString()};
      if(b.assigned_target!==undefined)patch.assigned_target=Math.max(0,Math.round(num(b.assigned_target)));
      if(b.note!==undefined)patch.note=String(b.note).slice(0,500);
      if(b.start_date!==undefined)patch.start_date=cleanDate(b.start_date);
      if(b.deadline!==undefined)patch.deadline=cleanDate(b.deadline);
      if(b.status!==undefined){if(!ALLOCATION_STATUSES.includes(b.status))return fail('Invalid allocation status.');patch.status=b.status}
      // acquired_users & commission are automated (contributions & payments) and never edited manually
      let [out]=await db(env,`allocations?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      await notifyPartner(env,out.partner_id,'allocation','Allocation updated','The administrator updated your allocation'+(patch.assigned_target!==undefined?' — new target '+Number(patch.assigned_target).toLocaleString():'')+'.','allocations');
      return json(out);
    }

    if(path==='payments'&&method==='GET'){
      if(!can('payments','show'))return denied();
      let [pays,projects,partners,allocs]=await Promise.all([db(env,'payments?select=*&order=payment_date.desc,created_at.desc&limit=1000'),db(env,'projects?select=id,name,start_date,deadline'),db(env,'partners?select=id,name,partner_code'),db(env,'allocations?select=project_id,partner_id,start_date,deadline')]);
      const pm=Object.fromEntries(projects.map(x=>[x.id,x])),sm=Object.fromEntries(partners.map(x=>[x.id,x]));
      return json(pays.map(p=>{const ar=allocs.find(a=>a.project_id===p.project_id&&a.partner_id===p.partner_id);return {...payToRow(p,pm,sm),start_date:ar?.start_date||null,deadline:ar?.deadline||null}}));
    }
    if(path==='payments'&&method==='POST'){
      if(!can('payments','add'))return denied();
      let b=await body(request);
      const allocationId=b.allocation_id||b.project_id;
      if(!allocationId||!b.partner_id)return fail('Project and agent are required.');
      if(!PAYMENT_STATUSES.includes(b.status))return fail('Invalid payment status.');
      let amount=num(b.amount);
      if(amount<=0)return fail('Payment amount must be greater than zero.');
      let [alloc]=await db(env,`allocations?id=eq.${allocationId}&partner_id=eq.${b.partner_id}&select=*`);
      if(!alloc)return fail('This agent has no allocation for the selected project.',400);
      const [out]=await db(env,'payments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:b.partner_id,project_id:alloc.project_id,payment_date:b.payment_date||new Date().toISOString().slice(0,10),amount:Math.round(amount*100)/100,status:b.status})});
      await notifyPartner(env,b.partner_id,'payment','New payment added','A payment of $'+(Math.round(amount*100)/100).toFixed(2)+' was added with status "'+b.status+'" for you.','payments');
      // Commission is only added when the payment is PAID (scheduled/pending add nothing).
      if(b.status==='paid')await db(env,`allocations?id=eq.${alloc.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({commission:Math.round((num(alloc.commission)+amount)*100)/100,updated_at:new Date().toISOString()})});
      return json(out,201);
    }
    if(path.startsWith('payments/')&&(method==='PATCH'||method==='DELETE')){
      if(!can('payments',method==='PATCH'?'edit':'delete'))return denied();
      let id=path.split('/')[1];
      let [existing]=await db(env,`payments?id=eq.${id}&select=*`);
      if(!existing)return fail('Payment not found.',404);
      if(method==='DELETE'){
        if(existing.status==='paid'){
          let [alloc]=await db(env,`allocations?project_id=eq.${existing.project_id}&partner_id=eq.${existing.partner_id}&select=*`);
          if(alloc)await db(env,`allocations?id=eq.${alloc.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({commission:Math.max(0,Math.round((num(alloc.commission)-num(existing.amount))*100)/100),updated_at:new Date().toISOString()})});
        }
        await db(env,`payments?id=eq.${id}`,{method:'DELETE'});
        await notifyPartner(env,existing.partner_id,'payment','Payment deleted','A payment of $'+num(existing.amount).toFixed(2)+' was deleted.','payments');
        return json({ok:true});
      }
      let b=await body(request),patch={updated_at:new Date().toISOString()};
      if(b.status!==undefined){
        if(!PAYMENT_STATUSES.includes(b.status))return fail('Invalid payment status.');
        if(b.status!=='paid'&&existing.status==='paid')return fail('A paid payment cannot be reverted. Delete it instead.',400);
        const nowPaid=b.status==='paid'&&existing.status!=='paid';
        patch.status=b.status;
        if(nowPaid){
          let [alloc]=await db(env,`allocations?project_id=eq.${existing.project_id}&partner_id=eq.${existing.partner_id}&select=*`);
          if(alloc)await db(env,`allocations?id=eq.${alloc.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({commission:Math.round((num(alloc.commission)+num(existing.amount))*100)/100,updated_at:new Date().toISOString()})});
        }
      }
      let [out]=await db(env,`payments?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      if(patch.status==='paid'&&existing.status!=='paid')await notifyPartner(env,existing.partner_id,'payment','Payment marked as paid','Your payment of $'+num(existing.amount).toFixed(2)+' is now marked PAID — commission updated.','payments');
      return json(out);
    }

    if(path==='performance'&&method==='GET'){
      if(!can('performance','show'))return denied();
      let [allocs,partners,projects]=await Promise.all([
        db(env,'allocations?select=*&order=created_at.asc'),
        db(env,'partners?select=id,name,partner_code,type'),
        db(env,'projects?select=id,name')]);
      const pm=Object.fromEntries(projects.map(x=>[x.id,x.name])),sm=Object.fromEntries(partners.map(x=>[x.id,x]));
      const rows=allocs.map(a=>({id:a.id,partner_id:a.partner_id,name:sm[a.partner_id]?.name||'—',partner_code:sm[a.partner_id]?.partner_code||'',type:sm[a.partner_id]?.type||'',project_id:a.project_id,project_name:pm[a.project_id]||'—',category:a.category||'users',assigned:num(a.assigned_target),acquired:num(a.acquired_users),commission:num(a.commission),start_date:a.start_date||null,deadline:a.deadline||null,pct:num(a.assigned_target)>0?Math.round(num(a.acquired_users)/num(a.assigned_target)*100):0})).sort((a,b)=>b.pct-a.pct||b.acquired-a.acquired);
      return json(rows.map((r,i)=>({...r,rank:i+1})));
    }

    if(path==='team-allocations'&&method==='GET'){
      let [rows,partners,members,projects]=await Promise.all([
        db(env,'team_allocations?select=*&order=created_at.desc&limit=2000'),
        db(env,'partners?select=id,name,partner_code'),
        db(env,'team_members?select=id,name,code'),
        db(env,'projects?select=id,name')]);
      const sm=Object.fromEntries(partners.map(x=>[x.id,x])),mm=Object.fromEntries(members.map(x=>[x.id,x])),pm=Object.fromEntries(projects.map(x=>[x.id,x.name]));
      return json(rows.map(t=>({...t,partner_name:sm[t.partner_id]?.name||'—',partner_code:sm[t.partner_id]?.partner_code||'',member_name:mm[t.team_member_id]?.name||'—',member_code:mm[t.team_member_id]?.code||'',project_name:pm[t.project_id]||'—'})));
    }
    if(path==='contributions'&&method==='GET'){
      if(!can('contribute','show'))return denied();
      let [rows,partners,projects,allocs,files]=await Promise.all([
        db(env,'contributions?select=*&order=created_at.desc&limit=1000'),
        db(env,'partners?select=id,name,partner_code'),
        db(env,'projects?select=id,name'),
        db(env,'allocations?select=id,project_id,category'),
        db(env,'contribution_files?select=*&order=created_at.asc')]);
      const pm=Object.fromEntries(projects.map(x=>[x.id,x.name])),sm=Object.fromEntries(partners.map(x=>[x.id,x])),am=Object.fromEntries(allocs.map(x=>[x.id,x]));
      return json(rows.map(c=>({...c,partner_name:sm[c.partner_id]?.name||'—',partner_code:sm[c.partner_id]?.partner_code||'',project_name:pm[c.project_id]||'—',category:am[c.allocation_id]?.category||'',start_date:am[c.allocation_id]?.start_date||null,deadline:am[c.allocation_id]?.deadline||null,files:files.filter(f=>f.contribution_id===c.id)})));
    }
    if(path.startsWith('contributions/')&&method==='PATCH'){
      if(!can('contribute','edit'))return denied();
      const id=path.split('/')[1];
      let [c]=await db(env,`contributions?id=eq.${id}&select=*`);
      if(!c)return fail('Contribution request not found.',404);
      if(c.status!=='pending')return fail('This contribution request was already '+c.status+'.',409);
      let b=await body(request),action=String(b.action||'');
      if(!['accept','reject'].includes(action))return fail('action must be accept or reject.');
      if(action==='accept'){
        let [alloc]=c.allocation_id?await db(env,`allocations?id=eq.${c.allocation_id}&select=*`):[];
        if(!alloc)return fail('The allocation for this contribution no longer exists.',400);
        await db(env,`allocations?id=eq.${alloc.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({acquired_users:num(alloc.acquired_users)+c.acquired,updated_at:new Date().toISOString()})});
      }
      const [out]=await db(env,`contributions?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:action==='accept'?'accepted':'rejected',reviewed_at:new Date().toISOString(),reviewed_by:s.id,review_note:b.note?String(b.note).slice(0,500):null,updated_at:new Date().toISOString()})});
      await notifyPartner(env,c.partner_id,'contribute',action==='accept'?'Contribution accepted':'Contribution rejected',(action==='accept'?'Your contribution of '+c.acquired+' acquired was accepted and added to your allocation.':'Your contribution ('+(c.code||'request')+') was rejected.'+(b.note?' Note: '+String(b.note).slice(0,140):'')),'contribute');
      return json(out);
    }

    if(/^partners\/[^/]+\/logs$/.test(path)&&method==='GET'){
      const id=path.split('/')[1];
      let [logs,partner,paymentMethods]=await Promise.all([
        db(env,`partner_logs?partner_id=eq.${id}&select=*&order=created_at.desc&limit=200`),
        db(env,`partners?id=eq.${id}&select=*`),
        db(env,`payment_methods?partner_id=eq.${id}&select=*&order=created_at.asc`)]);
      if(!partner.length)return fail('Agent not found.',404);
      return json({partner:publicPartner(partner[0]),logs,paymentMethods});
    }

    if(path==='vaultium'&&method==='GET'){
      if(!can('vaultium','show'))return denied();
      let [files,contributions,partners,projects,allocs]=await Promise.all([
        db(env,'contribution_files?select=*&order=created_at.desc&limit=2000'),
        db(env,'contributions?select=id,code,project_id,partner_id,created_at,allocation_id'),
        db(env,'partners?select=id,name,partner_code'),
        db(env,'projects?select=id,name'),
        db(env,'allocations?select=id,category')]);
      const pm=Object.fromEntries(projects.map(x=>[x.id,x.name])),sm=Object.fromEntries(partners.map(x=>[x.id,x])),am=Object.fromEntries(allocs.map(x=>[x.id,x]));
      return json(files.map(f=>{
        const c=contributions.find(x=>x.id===f.contribution_id);
        return {...f,contribution_code:c?.code||'',category:am[c?.allocation_id]?.category||'',project_name:c?(pm[c.project_id]||'—'):'—',partner_name:sm[f.partner_id]?.name||'—',partner_code:sm[f.partner_id]?.partner_code||''};
      }));
    }
    if(/^files\/[^/]+$/.test(path)&&method==='DELETE'){
      if(!can('vaultium','delete'))return denied();
      let [f]=await db(env,`contribution_files?id=eq.${path.split('/')[1]}&select=*`);
      if(!f)return fail('File not found.',404);
      if(env.VAULTIUM)await env.VAULTIUM.delete(f.r2_key).catch(()=>{});
      else if(env.IOS_PROOF)await env.IOS_PROOF.delete(f.r2_key).catch(()=>{});
      await db(env,`contribution_files?id=eq.${f.id}`,{method:'DELETE'});
      return json({ok:true});
    }

    if(path==='helpdesk'&&method==='GET'&&s.role==='admin'){
      if(s.kind==='user'){
        let rows=await db(env,`admin_user_messages?user_id=eq.${s.id}&select=*&order=created_at.desc&limit=500`);
        const unread=rows.filter(m=>m.sender_type==='owner'&&!m.read_by_user).length;
        return json({mode:'user',totalUnread:unread,threads:[{kind:'user',id:s.id,name:'Primary Administrator',code:'DoxTox',last:rows[0]?.body||'Start a conversation with the administrator.',last_at:rows[0]?.created_at||new Date().toISOString(),unread,total:rows.length}]});
      }
      let [agentMsgs,partners,userMsgs,users]=await Promise.all([
        db(env,'helpdesk_messages?select=*&order=created_at.desc&limit=5000'),
        db(env,'partners?select=id,name,partner_code'),
        db(env,'admin_user_messages?select=*&order=created_at.desc&limit=5000'),
        db(env,'admin_users?select=id,name,email,status&order=created_at.desc')]);
      const sm=Object.fromEntries(partners.map(x=>[x.id,x])),threads={};
      for(const m of agentMsgs){
        const key='agent:'+m.partner_id;
        threads[key]??={kind:'agent',id:m.partner_id,name:sm[m.partner_id]?.name||'—',code:sm[m.partner_id]?.partner_code||'',last:'',last_at:m.created_at,unread:0,total:0};
        const t=threads[key];t.total++;if(m.sender_type==='agent'&&!m.read_by_admin)t.unread++;if(!t.last_at||new Date(m.created_at)>=new Date(t.last_at)){t.last=m.body;t.last_at=m.created_at}
      }
      const umap=Object.fromEntries(users.map(x=>[x.id,x]));
      for(const u of users){const key='user:'+u.id;threads[key]??={kind:'user',id:u.id,name:u.name,code:u.status,last:'No messages yet.',last_at:u.created_at,unread:0,total:0}}
      for(const m of userMsgs){
        const key='user:'+m.user_id,u=umap[m.user_id];
        threads[key]??={kind:'user',id:m.user_id,name:u?.name||'User',code:u?.status||'',last:'',last_at:m.created_at,unread:0,total:0};
        const t=threads[key];t.total++;if(m.sender_type==='user'&&!m.read_by_owner)t.unread++;if(!t.last_at||new Date(m.created_at)>=new Date(t.last_at)){t.last=m.body;t.last_at=m.created_at}
      }
      const list=Object.values(threads).sort((a,b)=>new Date(b.last_at)-new Date(a.last_at));
      return json({mode:'owner',threads:list,totalUnread:list.reduce((a,t)=>a+t.unread,0)});
    }
    if(/^helpdesk\/agent\/[^/]+$/.test(path)&&method==='GET'&&s.role==='admin'){
      const pid=path.split('/')[2];
      let [rows,partner]=await Promise.all([db(env,`helpdesk_messages?partner_id=eq.${pid}&select=*&order=created_at.asc&limit=1000`),db(env,`partners?id=eq.${pid}&select=id,name,partner_code`)]);
      if(!partner.length)return fail('Agent not found.',404);
      await db(env,`helpdesk_messages?partner_id=eq.${pid}&sender_type=eq.agent&read_by_admin=eq.false`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({read_by_admin:true})});
      return json({thread:{kind:'agent',id:pid,name:partner[0].name,code:partner[0].partner_code},messages:rows.map(m=>({...m,read_by_admin:true}))});
    }
    if(/^helpdesk\/agent\/[^/]+$/.test(path)&&method==='POST'&&s.role==='admin'){
      const pid=path.split('/')[2];let b=await body(request),text=String(b.body||'').trim();if(!text)return fail('Message cannot be empty.');
      let [partner]=await db(env,`partners?id=eq.${pid}&select=id`);if(!partner)return fail('Agent not found.',404);
      const [out]=await db(env,'helpdesk_messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:pid,sender_type:'admin',sender_id:s.id,body:text.slice(0,2000),read_by_admin:true})});return json(out,201);
    }
    if(/^helpdesk\/user\/[^/]+$/.test(path)&&method==='GET'&&s.role==='admin'){
      const uid=path.split('/')[2];
      if(s.kind==='user'&&uid!==s.id)return fail('Permission denied.',403);
      let [rows,user]=await Promise.all([db(env,`admin_user_messages?user_id=eq.${uid}&select=*&order=created_at.asc&limit=1000`),db(env,`admin_users?id=eq.${uid}&select=id,name,email,status`)]);
      if(!user.length)return fail('User not found.',404);
      if(s.kind==='user')await db(env,`admin_user_messages?user_id=eq.${uid}&sender_type=eq.owner&read_by_user=eq.false`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({read_by_user:true})});
      else await db(env,`admin_user_messages?user_id=eq.${uid}&sender_type=eq.user&read_by_owner=eq.false`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({read_by_owner:true})});
      return json({thread:{kind:'user',id:uid,name:s.kind==='user'?'Primary Administrator':user[0].name,code:user[0].status},messages:rows.map(m=>({...m,read_by_owner:true,read_by_user:true}))});
    }
    if(/^helpdesk\/user\/[^/]+$/.test(path)&&method==='POST'&&s.role==='admin'){
      const uid=path.split('/')[2];
      if(s.kind==='user'&&uid!==s.id)return fail('Permission denied.',403);
      let b=await body(request),text=String(b.body||'').trim();if(!text)return fail('Message cannot be empty.');
      let [user]=await db(env,`admin_users?id=eq.${uid}&select=id`);if(!user)return fail('User not found.',404);
      const sender=s.kind==='user'?'user':'owner';
      const [out]=await db(env,'admin_user_messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_id:uid,sender_type:sender,sender_id:s.id,body:text.slice(0,2000),read_by_owner:sender==='owner',read_by_user:sender==='user'})});return json(out,201);
    }
    if(/^helpdesk\/[^/]+$/.test(path)&&method==='GET'&&s.role==='admin'){
      const pid=path.split('/')[1];
      let [rows,partner]=await Promise.all([
        db(env,`helpdesk_messages?partner_id=eq.${pid}&select=*&order=created_at.asc&limit=1000`),
        db(env,`partners?id=eq.${pid}&select=id,name,partner_code`)]);
      if(!partner.length)return fail('Agent not found.',404);
      await db(env,`helpdesk_messages?partner_id=eq.${pid}&sender_type=eq.agent&read_by_admin=eq.false`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({read_by_admin:true})});
      return json({partner:partner[0],messages:rows.map(m=>({...m,read_by_admin:true}))});
    }
    if(/^helpdesk\/[^/]+$/.test(path)&&method==='POST'&&s.role==='admin'){
      const pid=path.split('/')[1];
      let b=await body(request),text=String(b.body||'').trim();
      if(!text)return fail('Message cannot be empty.');
      let [partner]=await db(env,`partners?id=eq.${pid}&select=id`);
      if(!partner)return fail('Agent not found.',404);
      const [out]=await db(env,'helpdesk_messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:pid,sender_type:'admin',sender_id:s.id,body:text.slice(0,2000),read_by_admin:true})});
      return json(out,201);
    }

    if(path==='withdrawals'&&method==='GET'){
      if(!can('payments','show'))return denied();
      let [rows,partners]=await Promise.all([
        db(env,'withdrawals?select=*&order=created_at.desc&limit=1000'),
        db(env,'partners?select=id,name,partner_code')]);
      const sm=Object.fromEntries(partners.map(x=>[x.id,x]));
      return json(rows.map(w=>({...w,partner_name:sm[w.partner_id]?.name||'—',partner_code:sm[w.partner_id]?.partner_code||''})));
    }
    if(path.startsWith('withdrawals/')&&method==='PATCH'){
      if(!can('payments','edit'))return denied();
      let id=path.split('/')[1];
      let [w]=await db(env,`withdrawals?id=eq.${id}&select=*`);
      if(!w)return fail('Withdrawal request not found.',404);
      if(w.status!=='pending')return fail('This withdrawal was already '+w.status+'.',409);
      let b=await body(request),action=String(b.action||'');
      if(action==='accept'){
        const provider=String(b.provider_number||'').trim(),trx=String(b.trx||'').trim();
        if(!provider)return fail('Provider number is required.',400);
        if(!trx)return fail('Transaction ID (trx) is required.',400);
        const [out]=await db(env,`withdrawals?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'accepted',provider_number:provider.slice(0,60),trx:trx.slice(0,100),updated_at:new Date().toISOString()})});
        await notifyPartner(env,w.partner_id,'withdraw','Withdrawal accepted','Your withdrawal of $'+num(w.amount).toFixed(2)+' was accepted. TRX: '+trx,'payments');
        return json(out);
      }
      if(action==='reject'){
        const [out]=await db(env,`withdrawals?id=eq.${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'rejected',reject_reason:b.reason?String(b.reason).slice(0,500):null,updated_at:new Date().toISOString()})});
        await notifyPartner(env,w.partner_id,'withdraw','Withdrawal rejected','Your withdrawal of $'+num(w.amount).toFixed(2)+' was rejected.'+(b.reason?' Reason: '+String(b.reason).slice(0,140):''),'payments');
        return json(out);
      }
      return fail('action must be accept or reject.');
    }

    return fail('Not found.',404);
  }catch(e){return fail(e.message||'Unexpected server error.',500)}
}
