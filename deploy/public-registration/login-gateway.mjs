import { createServer, request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { readFileSync } from 'node:fs';

const mode=process.env.LOGIN_GATEWAY_MODE;

if(!['private-http-fixture-v1','private-http-staging-v1'].includes(mode)) process.exit(78);

const fixture=mode==='private-http-fixture-v1';
const dir=fixture&&process.env.LOGIN_GATEWAY_FIXTURE_DIR||'/run/staff-login';
const {auth,rest,proxy,listen,crmIP,fixturePorts}=JSON.parse(readFileSync(`${dir}/gateway/upstreams.json`,'utf8'));
const {LOGIN_API_HOST:api,LOGIN_CRM_HOST:crm}=process.env;
const hostName=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

if(!hostName.test(api)||!hostName.test(crm)||api===crm||(fixture?![api,crm].every(h=>h.endsWith('.fixture.invalid')):api!=='wacrm-api.sqkii.land'||crm!=='wacrm.sqkii.land')) throw Error('exact trial origins required');

const isText=value=>value!==Object(value)&&value===String(value);

const uuid=value=>isText(value)&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)&&value!=='00000000-0000-0000-0000-000000000000';
const accountRoles=new Set(['owner','admin','agent','viewer']);
const anon=readFileSync(`${dir}/anon`,'utf8').trim();
const anonClaims=()=>JSON.parse(Buffer.from(anon.split('.')[1],'base64url'));

if(fixture?anon!=='synthetic-anon-key-not-a-credential':anon.length>2048||anonClaims().role!=='anon') throw Error('public anon token required');

const privateHost=host=>isIPv4(host)&&/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host);

if(![auth,rest,proxy,listen,crmIP].every(h=>privateHost(h)||fixture&&isIPv4(h)&&h.startsWith('127.'))||new Set([proxy,listen,crmIP]).size!==3||[auth,rest].some(x=>[proxy,listen,crmIP].includes(x))) throw Error('exact private IPv4 endpoints required');

const upstreams={auth:{host:auth,port:fixture?(fixturePorts?.auth??19999):9999},rest:{host:rest,port:fixture?(fixturePorts?.rest??3101):3000},crm:{host:crmIP,port:fixture?(fixturePorts?.crm??3000):3000}};
const origin='https://'+crm;
const apiOrigin='https://'+api;
const member=process.env.LOGIN_MEMBER_SIGNUP_ENABLED==='true';
const registration=process.env.LOGIN_PUBLIC_EMAIL_REGISTRATION==='true';
const callback=origin+'/auth/callback';
const passwordPath='/signup/password';
const finishPath='/signup/finish';
const signupRedirect=callback+'?next='+encodeURIComponent(passwordPath);
const budget={password:5,refresh_token:30,signup:3,verify:20,pkce:20,firstPassword:20};
const passwordWrites=new Set();
const jsonContentType=req=>req.headersDistinct['content-type']?.length===1&&/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(req.headers['content-type']);
const challenge=/^[A-Za-z0-9_-]{43}$/;
const verifier=/^[A-Za-z0-9._~-]{43,128}$/;
const signupToken=/^pkce_[0-9a-f]{56}$/;
const headers=new Set('apikey authorization content-type x-client-info x-supabase-api-version accept-profile content-profile prefer range range-unit'.split(' '));
const pageHeaders='host accept accept-language cookie rsc next-router-state-tree next-url next-router-prefetch next-router-segment-prefetch sec-fetch-site'.split(' ');
const tables=new Set('profiles accounts messages contacts deals broadcasts automation_logs conversations message_reactions contact_notes contact_tags message_templates'.split(' '));
const embeds=new Set('contacts contact_tags tags conversations pipeline_stages automations'.split(' '));

function safeSelect(query){
  const selects=new URLSearchParams(query).getAll('select');

  if(!selects.length)return true;

  if(selects.length!==1||!/^[a-zA-Z0-9_*,():!\s]+$/.test(selects[0]))return false;

  return selects[0].split('(').slice(0,-1).every(p=>{
    const relation=/(?:^|[:,(])\s*([a-z_]+)\s*$/.exec(p)?.[1];

    return embeds.has(relation);
  });
}

const buckets=new Map();

function limited(kind,address){
  const now=Date.now();

 for(const [k,v] of buckets)if(now>=v.end)buckets.delete(k);
  const key=kind+':'+address;

  if(!buckets.has(key)){if(buckets.size>=2048)return true;buckets.set(key,{count:0,end:now+60_000});}

  return ++buckets.get(key).count>budget[kind];
}

async function session(s,{signupOnly=false}={}){
  if(!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s??''))return false;

  try{
    const {host,port}=upstreams.auth;
    const r=await fetch(`http://${host}:${port}/user`,{headers:{authorization:s},redirect:'error',signal:AbortSignal.timeout(3500)});

    if(!r.ok){await r.body?.cancel();

return false;}

    // GoTrue validates the actual bearer; role and subject come from its verified user response.
    const {id,role,aud,email_confirmed_at,app_metadata}=await r.json();
    const claims=JSON.parse(Buffer.from(s.split('.')[1],'base64url'));

    if(signupOnly&&(!email_confirmed_at||app_metadata?.wacrm_email_first!==true||!claims.amr?.some(x=>x.method==='email/signup')))return null;

    return uuid(id)&&role==='authenticated'&&aud==='authenticated'&&claims.sub===id&&claims.role===role&&claims.aud===aud&&claims.iss===`https://${api}/auth/v1`&&Number.isSafeInteger(claims.exp)&&claims.exp>Date.now()/1000&&uuid(claims.session_id)?id:null;
  }catch{return false;}
}

// Match the packaged Supabase SSR base64 cookie, including contiguous numbered chunks.
function cookieBearer(req){
  if(req.headersDistinct.cookie?.length!==1)return;
  const name=`sb-${api.split('.')[0]}-auth-token`, parts=new Map();

  for(const item of (req.headers.cookie??'').split(';')){
    const i=item.indexOf('=');

 if(i<1)continue;
    const k=item.slice(0,i).trim();

    if(k!==name&&!k.startsWith(name+'.'))continue;
    const suffix=k.slice(name.length);

    if((suffix&&!/^\.[0-4]$/.test(suffix))||parts.has(suffix))return;
    parts.set(suffix,item.slice(i+1));
  }

  const whole=parts.get('');

  if(!parts.size||(whole!==undefined&&parts.size!==1))return;
  const chunks=Array.from({length:parts.size},(_,i)=>parts.get('.'+i));

  if(whole===undefined&&chunks.some(v=>!v))return;
  const value=whole??chunks.join('');

  if(!/^base64-[A-Za-z0-9_-]{1,15000}$/.test(value))return;

  try{
    const token=JSON.parse(Buffer.from(value.slice(7),'base64url')).access_token;

    if(isText(token)&&token.length<=8192)return 'Bearer '+token;
  }catch{return;}
}

async function membership(id,bearer,requireOwner=false){
  if(!id)return false;
  const {host,port}=upstreams.rest;

  try{
    // Fixed server-side filters under the verified user's existing RLS, never a service key.
    const read=async path=>{
      const r=await fetch(`http://${host}:${port}/${path}`,{headers:{apikey:anon,authorization:bearer,'accept-profile':'public'},redirect:'error',signal:AbortSignal.timeout(3500)});

      if(!r.ok){await r.body?.cancel();

return [];}

      return await r.json();
    };

    const profiles=await read(`profiles?select=user_id,account_id,account_role&user_id=eq.${id}&limit=2`);
    const p=Array.isArray(profiles)&&profiles.length===1&&profiles[0];

    if(!p||p.user_id!==id||!uuid(p.account_id)||!accountRoles.has(p.account_role))return false;

    if(!requireOwner)return true;

    if(p.account_role!=='owner')return false;
    const accounts=await read(`accounts?select=id,owner_user_id&id=eq.${p.account_id}&limit=2`);

    return Array.isArray(accounts)&&accounts.length===1&&accounts[0]?.id===p.account_id&&accounts[0]?.owner_user_id===id;
  }catch{return false;}
}

function end(res,status){res.writeHead(status);res.end();}

function pass(req,res,{host,port},path,keys,body,{method=req.method,memberRoute=false,timeout=8000}={}){
  const forward={};

for(const k of keys)if(req.headers[k]!==undefined)forward[k]=req.headers[k];

  if(body)forward['content-length']=body.length;

  if(memberRoute)forward['x-forwarded-proto']='https';

  const upstream=request({hostname:host,port,path,method,headers:forward,timeout},r=>{
    const out={};

for(const [k,v] of Object.entries(r.headers))if(!/^(access-control-|cache-control$|connection$|transfer-encoding$|server$|via$)/.test(k)&&(host===upstreams.crm.host||k!=='set-cookie'))out[k]=v;
    res.writeHead(r.statusCode,out); r.pipe(res);
  });

  upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>res.headersSent?res.destroy():end(res,502));
  res.on('close',()=>upstream.destroy());upstream.end(body);
}

async function readBody(req,max=8192,keepSocket=false){
  const chunks=[];let size=0;

  for await(const chunk of (keepSocket?req.iterator({destroyOnReturn:false}):req)){size+=chunk.length;

if(size>max)return null;chunks.push(chunk);}

  return Buffer.concat(chunks);
}

function memberBody(raw){
  const p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));

  if(!p||Object.getPrototypeOf(p)!==Object.prototype)return null;
  const {action,intended_phone,state,code,waba_id,phone_number_id}=p;

  if(action==='launch'&&Object.keys(p).length===2&&isText(intended_phone)&&/^\+[1-9]\d{7,14}$/.test(intended_phone))
    return Buffer.from(JSON.stringify({action,intended_phone}));

  if(!isText(state)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state))return null;

  if(action==='finish'&&Object.keys(p).length===3&&isText(code)&&code.length<=32768&&code.trim()&&!/[\r\n]/.test(code))
    return Buffer.from(JSON.stringify({action,state,code}));

  if(action==='confirm'&&Object.keys(p).length===4&&[waba_id,phone_number_id].every(v=>isText(v)&&/^[1-9]\d{0,31}$/.test(v)))
    return Buffer.from(JSON.stringify({action,state,waba_id,phone_number_id}));

  return null;
}

async function memberRequest(req,res,path,query){
  const page=path==='/settings/connect-whatsapp', post=req.method==='POST';

  if(!member||(page?!['GET','HEAD'].includes(req.method):!['GET','POST'].includes(req.method)))return end(res,404);

  if(query!==undefined&&(!page||!/^_rsc=[A-Za-z0-9_-]{1,64}$/.test(query)))return end(res,404);
  const h=req.headers,d=req.headersDistinct;

  if((d.origin?.length??0)>1||(h.origin!==undefined&&h.origin!==origin)||(post&&h.origin!==origin))return end(res,403);

  if(!page&&h['sec-fetch-site']!==undefined&&(d['sec-fetch-site']?.length!==1||h['sec-fetch-site']!=='same-origin'))return end(res,403);

  if(['authorization','apikey','x-api-key'].some(k=>d[k]))return end(res,401);

  if(!post&&(h['transfer-encoding']!==undefined||Number(h['content-length']??0)!==0))return end(res,400);

  if(post&&(d['content-type']?.length!==1||!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(h['content-type'])||d['content-encoding']))return end(res,415);

  if(post&&Number(h['content-length'])>40*1024)return end(res,413);
  const bearer=cookieBearer(req);
  const id=await session(bearer);

  if(!id)return end(res,401);

  if(!await membership(id,bearer))return end(res,403);
  let body;

  if(post){
    const raw=await readBody(req,40*1024,true);

    if(!raw){res.setHeader('Connection','close');

return end(res,413);}

    body=memberBody(raw);

    if(!body)return end(res,400);
  }

  const keys=page?pageHeaders:['host','cookie','origin','content-type','sec-fetch-site'];

  return pass(req,res,upstreams.crm,req.url,keys,body,{memberRoute:true,timeout:post?48_000:12_000});
}

function signupBody(body){
  const p=JSON.parse(body);

  if(!p||!isText(p.email)||p.email.length>254||!p.email.includes('@')||!isText(p.code_challenge)||!challenge.test(p.code_challenge)||p.code_challenge_method!=='s256')return null;
  const name=p.data?.full_name;

  if(!isText(name)||!name.trim()||name.length>120)return null;

  // Never forward client claims, extra credentials, provider selectors, or role metadata.
  return Buffer.from(JSON.stringify({email:p.email,password:randomBytes(32).toString('base64url'),data:{full_name:name.trim(),wacrm_email_first:true},code_challenge:p.code_challenge,code_challenge_method:'s256'}));
}

async function confirmationEligible(token){
  const {host,port}=upstreams.rest;

  const gate=await fetch(`http://${host}:${port}/rpc/can_confirm_public_registration`,{
    method:'POST',headers:{apikey:anon,authorization:`Bearer ${anon}`,'content-type':'application/json'},
    body:JSON.stringify({p_token:token}),redirect:'error',signal:AbortSignal.timeout(3500),
  });

  if(!gate.ok){await gate.body?.cancel();

return null;}

  const value=await gate.json();

  return value===true||value===false?value:null;
}

function signupLink(query){
  const q=new URLSearchParams(query), token=q.get('token');

  return q.size===3&&signupToken.test(token??'')&&q.get('type')==='signup'&&q.get('redirect_to')===signupRedirect?token:null;
}

function signupVerifier(req){
  const name=`sb-${api.split('.')[0]}-auth-token-code-verifier=`;
  const matches=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name));

  if(req.headersDistinct.cookie?.length!==1||matches.length!==1)return null;
  const packed=matches[0].slice(name.length);

  if(!/^base64-[A-Za-z0-9_-]{1,200}$/.test(packed))return null;
  try{
    const value=JSON.parse(Buffer.from(packed.slice(7),'base64url'));

    return isText(value)&&verifier.test(value)?value:null;
  }catch{return null;}
}

function finishPage(res,status,content){
  const scrub="history.replaceState(null, '', location.pathname);";
  const scriptHash=createHash('sha256').update(scrub).digest('base64');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});

  return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WACRM � Set your password</title><script>${scrub}</script><style>:root{color-scheme:light dark;font:1rem system-ui}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{box-sizing:border-box;width:min(94vw,28rem);padding:2rem;border:1px solid GrayText;border-radius:1rem}form,label{display:grid;gap:.5rem}form{gap:1rem}input,button{font:inherit;padding:.65rem;border-radius:.5rem}button{cursor:pointer}</style><main><strong>WACRM</strong><h1>Set your password</h1>${content}</main></html>`);
}

async function finishSignup(req,res,query){
  res.setHeader('Referrer-Policy','no-referrer');
  const unavailable='<p>Open the link in the browser you used to sign up. If it expired, <a href="/signup">start again</a>.</p>';
  const codeVerifier=signupVerifier(req);

  if(req.method==='GET'){
    const q=new URLSearchParams(query), token=q.get('token');

    if(q.size!==1||!signupToken.test(token??''))return end(res,404);
    if(!codeVerifier)return finishPage(res,409,unavailable);

    return finishPage(res,200,`<p>Choose a password to verify your email and finish signing up.</p><form method="post" action="${finishPath}"><input type="hidden" name="token" value="${token}"><label>Password<input name="password" type="password" autocomplete="new-password" minlength="6" maxlength="72" required></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="6" maxlength="72" required></label><button>Verify email and set password</button></form>`);
  }

  if(req.method!=='POST'||query!==undefined)return end(res,404);
  if(req.headersDistinct.origin?.length!==1||![origin,'null'].includes(req.headers.origin)||req.headers['sec-fetch-site']!=='same-origin'||req.headers['content-type']!=='application/x-www-form-urlencoded')return end(res,403);
  if(limited('verify',req.socket.remoteAddress))return end(res,429);
  if(!codeVerifier)return finishPage(res,409,unavailable);
  const body=await readBody(req,2048);

  if(!body)return end(res,413);
  const form=new URLSearchParams(body.toString()), token=form.get('token'), password=form.get('password');

  if(form.size!==3||!signupToken.test(token??'')||!password||password.length<6||Buffer.byteLength(password)>72||password!==form.get('confirm'))return finishPage(res,400,'<p>Passwords must match and be at least six characters, up to 72 bytes. Reopen the email link and try again.</p>');
  const rest=upstreams.rest;
  const challenge=createHash('sha256').update(codeVerifier).digest('base64url');
  const eligible=await fetch(`http://${rest.host}:${rest.port}/rpc/can_finish_public_registration`,{
    method:'POST',headers:{apikey:anon,authorization:`Bearer ${anon}`,'content-type':'application/json'},
    body:JSON.stringify({p_token:token,p_challenge:challenge}),redirect:'error',signal:AbortSignal.timeout(3500),
  });

  if(!eligible.ok){await eligible.body?.cancel();return end(res,503);}
  if(await eligible.json()!==true)return finishPage(res,409,unavailable);
  const {host,port}=upstreams.auth;
  const url=`http://${host}:${port}`;
  const q=new URLSearchParams({token,type:'signup',redirect_to:signupRedirect});
  const verification=await fetch(`${url}/verify?${q}`,{redirect:'manual',signal:AbortSignal.timeout(8000)});
  await verification.body?.cancel();
  const target=new URL(verification.headers.get('location')??'/',origin);
  const authCode=target.searchParams.get('code');

  if(verification.status!==303||target.origin!==origin||target.pathname!=='/auth/callback'||target.hash||target.searchParams.size!==2||target.searchParams.get('next')!==passwordPath||!uuid(authCode))return finishPage(res,409,unavailable);
  const exchange=await fetch(`${url}/token?grant_type=pkce`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({auth_code:authCode,code_verifier:codeVerifier}),
    redirect:'error',signal:AbortSignal.timeout(8000),
  });

  if(!exchange.ok){await exchange.body?.cancel();return finishPage(res,409,unavailable);}
  const {access_token:accessToken}=await exchange.json();
  const bearer=`Bearer ${accessToken}`;
  const id=await session(bearer,{signupOnly:true});

  // Only trust the freshly exchanged signup bearer, never a CRM session cookie.
  try{
    if(!id||passwordWrites.has(id))return end(res,403);
    passwordWrites.add(id);
    try{
      if(!await session(bearer,{signupOnly:true}))return end(res,403);
      const update=await fetch(`${url}/user`,{method:'PUT',headers:{authorization:bearer,'content-type':'application/json'},
        body:JSON.stringify({password}),redirect:'error',signal:AbortSignal.timeout(8000)});
      await update.body?.cancel();
      if(!update.ok)return finishPage(res,409,'<p>Your email was verified, but the password could not be saved. Contact WACRM support.</p>');
    }finally{passwordWrites.delete(id);}
  }finally{
    if(isText(accessToken))await fetch(`${url}/logout?scope=local`,{method:'POST',headers:{authorization:bearer},
      redirect:'error',signal:AbortSignal.timeout(2000)}).then(r=>r.body?.cancel()).catch(()=>{});
  }
  res.setHeader('Location','/login');

  return end(res,303);
}

const server=createServer({maxHeaderSize:16_384,requestTimeout:8000,headersTimeout:5000,connectionsCheckingInterval:1000},async(req,res)=>{
  try {
    res.setHeader('Cache-Control','no-store');
    const host=req.headers.host,m=req.method,raw=req.url;

    // Only the designated TLS proxy may use the plaintext listener; forwarded headers are not identity.
    if(req.socket.remoteAddress!==proxy)return end(res,403);

    if(!raw||raw.length>8192||req.headersDistinct.host?.length!==1||![api,crm].includes(host))return end(res,400);
    const mark=raw.indexOf('?');
    const path=mark<0?raw:raw.slice(0,mark),query=mark<0?undefined:raw.slice(mark+1);

    if(!/^\/[A-Za-z0-9_./-]*$/.test(path)||path.includes('//')||path.split('/').some(x=>x==='.'||x==='..'))return end(res,404);

    if(host===crm){
      if(registration&&path===finishPath)return await finishSignup(req,res,query);
      if(registration&&path==='/auth/callback'&&m==='GET'){
        res.setHeader('Referrer-Policy','no-referrer');
        const q=new URLSearchParams(query);

        if(q.get('next')!==passwordPath||q.size>5||[...q].some(([k])=>q.getAll(k).length!==1||!['next','code','error','error_code','error_description'].includes(k))||q.has('code')&&!uuid(q.get('code')))return end(res,404);

        return pass(req,res,upstreams.crm,raw,['host','cookie']);
      }

      if(path==='/api/whatsapp/send'){
        if(process.env.MANAGED_INBOX_REPLY_ENABLED!=='true'||raw!==path||m!=='POST')return end(res,404);

        if(req.headersDistinct.origin?.length!==1||req.headers.origin!==origin)return end(res,403);

        if(req.headersDistinct['idempotency-key']?.length!==1||!uuid(req.headers['idempotency-key'])||req.headers['content-type']!=='application/json')return end(res,400);
        const bearer=cookieBearer(req);

        if(!await membership(await session(bearer),bearer))return end(res,403);
        const chunks=[];let bytes=0;

        for await(const chunk of req){bytes+=chunk.length;

if(bytes>26000)return end(res,413);chunks.push(chunk);}

        return pass(req,res,upstreams.crm,'/api/whatsapp/reply',['host','cookie','origin','content-type','idempotency-key'],Buffer.concat(chunks));
      }

      if(path==='/settings/connect-whatsapp'||path==='/supervised-discovery')return await memberRequest(req,res,path,query);
      const settings=path==='/settings';
      const signupStatus=path==='/api/whatsapp/coexistence/signup';

      if(settings||signupStatus){
        // No operator mutations or invitation transport on the public listener.
        if(query!==undefined){
          const params=new URLSearchParams(query);

          if(!settings||raw!==path+'?'+params.toString()||[...params].some(([k,v])=>params.getAll(k).length!==1||(k==='tab'?!['overview','whatsapp'].includes(v):k!=='_rsc'||!/^[A-Za-z0-9_-]{1,64}$/.test(v))))return end(res,404);
        }

        if(!(m==='GET'||settings&&m==='HEAD'))return end(res,404);

        if(req.headers.origin&&req.headers.origin!==origin)return end(res,403);
        const bearer=cookieBearer(req);

        if(!await membership(await session(bearer),bearer,signupStatus||new URLSearchParams(query).get('tab')==='whatsapp'))return end(res,403);

        if(signupStatus){
          res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'});

          return res.end(JSON.stringify({enabled:false,launch_available:false,reason:'launch_prerequisites_incomplete',attempt:null}));
        }
      }else if(!['GET','HEAD'].includes(m)||!(path.startsWith('/_next/static/')||['/login','/dashboard','/inbox','/favicon.ico'].includes(path)||registration&&['/signup',passwordPath].includes(path)&&(query===undefined||/^_rsc=[A-Za-z0-9_-]{1,64}$/.test(query)||path==='/signup'&&query==='error=link_invalid')))return end(res,404);

      return pass(req,res,upstreams.crm,raw,pageHeaders);
    }

    if(registration&&path==='/auth/v1/verify'){
      if(m!=='GET')return end(res,404);
      const token=signupLink(query);
      if(!token)return end(res,404);
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Location',`${origin}${finishPath}?token=${token}`);

      return end(res,303);
    }
    res.setHeader('Vary','Origin');

    if(req.headers.origin===origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Expose-Headers','Content-Range, Range-Unit, Preference-Applied');}
    else if(req.headers.origin)return end(res,403);
    const get=m==='OPTIONS'?req.headers['access-control-request-method']:m;
    const auth=path.startsWith('/auth/v1/');
    const token=path==='/auth/v1/token'&&get==='POST';
    const user=path==='/auth/v1/user'&&get==='GET'&&!query;
    const firstPassword=registration&&path==='/auth/v1/user'&&get==='PUT'&&query===undefined;
    const logout=path==='/auth/v1/logout'&&get==='POST'&&(!query||/^scope=(global|local)$/.test(query));
    const rest=path.startsWith('/rest/v1/')&&(get==='GET'&&tables.has(path.slice(9))||get==='POST'&&path==='/rest/v1/rpc/dashboard_overview'&&!query);
    const grant=/^grant_type=(password|refresh_token)$/.exec(query??'')?.[1];
    const signupQuery=new URLSearchParams(query);
    const signup=registration&&path==='/auth/v1/signup'&&get==='POST'&&signupQuery.size===1&&signupQuery.get('redirect_to')===signupRedirect;
    // Traefik exposes this exchange only to the pinned CRM peer, never the public API router.
    const pkce=registration&&path==='/auth/v1/token'&&m==='POST'&&query==='grant_type=pkce'&&!req.headers.origin;

    if(!(token&&grant||user||logout||rest||signup||pkce||firstPassword))return end(res,404);

    if((signup||firstPassword)&&req.headers.origin!==origin)return end(res,403);

    if(rest&&get==='GET'&&!safeSelect(query))return end(res,404);

    if(token&&grant==='password'&&req.headers.origin!==origin)return end(res,403);

    if(m==='OPTIONS'){
      const wanted=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);

      // PostgREST's SDK adds this marker on read retries; the gateway does not forward it.
      if(req.headers.origin!==origin||wanted.some(x=>!headers.has(x)&&!(rest&&get==='GET'&&x==='x-retry-count')))return end(res,403);
      res.setHeader('Vary','Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      res.setHeader('Access-Control-Allow-Methods',get);res.setHeader('Access-Control-Allow-Headers',wanted.join(', '));

return end(res,204);
    }

    if(['host','origin','apikey','authorization','accept-profile','content-profile'].some(k=>(req.headersDistinct[k]?.length??0)>1))return end(res,400);
    const bearer=req.headers.authorization;

    if(req.headers.apikey!==anon||((token||signup)&&bearer!==`Bearer ${anon}`))return end(res,401);

    if(firstPassword){
      if(limited('firstPassword',req.socket.remoteAddress))return end(res,429);

      if(!jsonContentType(req))return end(res,415);
      const body=await readBody(req,1024);

      if(!body)return end(res,413);
      const p=JSON.parse(body);

      if(!p||!isText(p.password)||p.password.length<6||Buffer.byteLength(p.password)>72)return end(res,400);

      // The SDK can include unused PKCE fields on password updates.
      if(Object.keys(p).some(k=>k!=='password'&&!((k==='code_challenge'||k==='code_challenge_method')&&p[k]===null)))return end(res,400);
      const id=await session(bearer,{signupOnly:true});

      if(!id)return end(res,403);

      if(passwordWrites.has(id))return end(res,409);
      passwordWrites.add(id);

      try{
        if(!await session(bearer,{signupOnly:true}))return end(res,403);
        const {host,port}=upstreams.auth;

        const result=await fetch(`http://${host}:${port}/user`,{
          method:'PUT',headers:{authorization:bearer,'content-type':'application/json'},
          body:JSON.stringify({password:p.password}),redirect:'error',signal:AbortSignal.timeout(8000),
        });

        const resultBody=await result.arrayBuffer();
        res.writeHead(result.status,{'Content-Type':'application/json'});

        return res.end(Buffer.from(resultBody));
      }finally{passwordWrites.delete(id);}
    }

    if(!token&&!signup){
      const id=await session(bearer);

      if(!id)return end(res,401);

      if(rest&&!await membership(id,bearer))return end(res,403);
    }

    if(['accept-profile','content-profile'].some(k=>req.headers[k]&&req.headers[k]!=='public'))return end(res,403);
    const lane=signup?'signup':pkce?'pkce':token?grant:null;

    if(lane&&limited(lane,req.socket.remoteAddress))return end(res,429);
    let body;

if(m==='POST'){
      body=await readBody(req);

      if(!body)return end(res,413);
    }

    if(signup||pkce){
      if(!jsonContentType(req))return end(res,415);

      if(signup)body=signupBody(body);
      else{
        const {auth_code,code_verifier}=JSON.parse(body);
        body=uuid(auth_code)&&isText(code_verifier)&&verifier.test(code_verifier)?Buffer.from(JSON.stringify({auth_code,code_verifier})):null;
      }

      if(!body)return end(res,400);
    }

    // Do not send mail if the passwordless registration migration is not ready.
    if(signup&&await confirmationEligible(null)!==false)return end(res,503);
    const destination=signup?'/signup?'+new URLSearchParams({redirect_to:signupRedirect}):raw.slice(8);

    return pass(req,res,auth?upstreams.auth:upstreams.rest,destination,headers,body);
  }catch{if(!res.headersSent)end(res,400);else res.destroy();}
});

server.maxConnections=48;

server.on('checkContinue',(_q,r)=>end(r,417));

server.on('upgrade',(_q,s)=>s.destroy());

server.listen(fixture?(fixturePorts?.gateway??8080):8080,listen);
