import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as reservePort } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const crm = 'crm.fixture.invalid', api = 'api.fixture.invalid';
const origin = `https://${crm}`, callback = `${origin}/auth/callback?next=%2Fsignup%2Fpassword`;
const code = 'c4bff808-f17f-4459-8825-ac4af294ae68';
const link = new URLSearchParams({ token: 'pkce_'+ 'a'.repeat(56), type: 'signup', redirect_to: callback });
const signup = '/auth/v1/signup?' + new URLSearchParams({ redirect_to: callback });
const anon = 'synthetic-anon-key-not-a-credential';
const publicHeaders = { origin, apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json;charset=UTF-8' };
const finish='/signup/finish';
const verifierValue='b'.repeat(56);
const verifierCookie=value=>`sb-api-auth-token-code-verifier=base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const formHeaders = { origin: 'null', 'sec-fetch-site': 'same-origin', 'content-type':'application/x-www-form-urlencoded' };
const exchange = '/auth/v1/token?grant_type=pkce';
const addr={ auth:'127.0.0.4', rest:'127.0.0.4', proxy:'127.0.0.2', listen:'127.0.0.1', crmIP:'127.0.0.3' };

let gatewayPort;

function call(path, { method='GET', host=api, headers={}, body, source=addr.proxy }={}){
  return new Promise((resolve,reject)=>{
    const req=request({hostname:addr.listen,port:gatewayPort,path,method,localAddress:source,headers:{host,...headers}},r=>{
      const chunks=[];r.on('data',x=>chunks.push(x));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks).toString()}));
    });

req.on('error',reject);req.end(body);
  });
}

async function listen(port, host, handle){
  const server=createServer(handle);
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,host,resolve));

  return server;
}

await test('registration is opt-in, email-only and bounded independently of login',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wacrm-registration-gateway-'));
  mkdirSync(join(dir,'gateway'));writeFileSync(join(dir,'anon'),anon);
  const authCalls=[];
  const historyCalls=[];
  let accountRole='owner';
  const current={email_confirmed_at:null,app_metadata:{wacrm_email_first:true}};
  const exp=Math.floor(Date.now()/1000)+300;
  const jwt=method=>`Bearer e30.${Buffer.from(JSON.stringify({sub:code,role:'authenticated',aud:'authenticated',iss:`https://${api}/auth/v1`,exp,session_id:code,amr:[{method}]})).toString('base64url')}.fixture`;

  const auth=await listen(0,addr.auth,async(req,res)=>{
    const chunks=[];

for await(const c of req)chunks.push(c);
    const raw=Buffer.concat(chunks).toString();

    if(req.url==='/rpc/can_confirm_public_registration')return res.end(JSON.stringify(JSON.parse(raw).p_token===link.get('token')));

    if(req.url==='/rpc/can_finish_public_registration'){
      const {p_token,p_challenge}=JSON.parse(raw);

      return res.end(JSON.stringify(p_token===link.get('token')&&p_challenge===createHash('sha256').update(verifierValue).digest('base64url')));
    }

    if(req.url.startsWith('/profiles?'))return res.end(JSON.stringify([{user_id:code,account_id:code,account_role:accountRole}]));

    if(req.url.startsWith('/accounts?'))return res.end(JSON.stringify([{id:code,owner_user_id:code}]));

    authCalls.push({url:req.url,method:req.method,body:raw&&JSON.parse(raw),authorization:req.headers.authorization});

    if(req.url==='/token?grant_type=pkce')return res.end(JSON.stringify({access_token:jwt('email/signup').slice(7)}));

    if(req.url==='/user'&&req.method==='GET')return res.end(JSON.stringify({id:code,role:'authenticated',aud:'authenticated',...current}));

    if(req.url==='/user'&&req.method==='PUT'){
      current.app_metadata={};

      return res.end('{}');
    }

    if(req.url.startsWith('/verify?')){
      current.email_confirmed_at='2000-01-01T00:00:00Z';
      res.writeHead(303,{location:callback+'&code='+code});
    }
    else res.writeHead(200);
    res.end();
  });

  const app=await listen(0,addr.crmIP,async(req,res)=>{
    if(req.url.startsWith('/history-')){
      const parts=[];

      for await(const chunk of req)parts.push(chunk);
      historyCalls.push({path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(parts).toString()});
    }

    res.end(req.url.split('?')[0]);
  });

  const reservation=reservePort();
  await new Promise((resolve,reject)=>reservation.once('error',reject).listen(0,addr.listen,resolve));
  gatewayPort=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const fixturePorts={gateway:gatewayPort, auth:auth.address().port, crm:app.address().port, rest:auth.address().port};
  writeFileSync(join(dir,'gateway/upstreams.json'),JSON.stringify({...addr,fixturePorts}));
  const env={...process.env,LOGIN_GATEWAY_MODE:'private-http-fixture-v1',LOGIN_GATEWAY_FIXTURE_DIR:dir,LOGIN_CRM_HOST:crm,LOGIN_API_HOST:api};
  let child;

  async function start(enabled){
    child=spawn(process.execPath,[fileURLToPath(new URL('./login-gateway.mjs',import.meta.url))],{env:{...env,LOGIN_PUBLIC_EMAIL_REGISTRATION:enabled?'true':'false',LOGIN_HISTORY_REQUEST_ENABLED:enabled?'true':'false'},stdio:'ignore'});

    for(let i=0;i<50;i++){
      if(child.exitCode!==null)throw Error('gateway failed to start');

      try{await call('/login',{host:crm});

return;}catch{await delay(40);}
    }

    throw Error('gateway not ready');
  }

  async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}}

  try{
    await start(false);
    assert.equal((await call('/history-request',{host:crm})).status,404);
    assert.equal((await call('/history-permissions',{host:crm})).status,404);
    assert.equal((await call('/signup',{host:crm})).status,404);
    assert.equal((await call(signup,{method:'POST',headers:publicHeaders})).status,404);
    await stop();await start(true);
    assert.equal((await call('/signup',{host:crm})).status,200);
    assert.equal((await call('/signup?invite=inert',{host:crm})).status,404);
    assert.equal((await call('/login',{host:crm,source:'127.0.0.1'})).status,403);
    assert.equal((await call(signup,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'apikey, authorization, content-type, x-client-info, x-supabase-api-version'}})).status,204);
    assert.equal((await call(signup,{method:'POST',headers:{...publicHeaders,origin:'https://wrong.fixture.invalid'}})).status,403);
    assert.equal((await call('/auth/v1/signup?redirect_to=https://wrong.fixture.invalid',{method:'POST',headers:publicHeaders})).status,404);
    const post=(p)=>call(signup,{method:'POST',headers:publicHeaders,body:JSON.stringify(p)});
    const account={email:'owner@example.invalid',password:randomBytes(24).toString('base64url'),data:{full_name:'Fresh Owner'},code_challenge:'a'.repeat(43),code_challenge_method:'s256'};
    assert.equal((await post({...account,code_challenge:[account.code_challenge]})).status,400);
    assert.equal((await post({...account,role:'service_role',phone:'123',data:{...account.data,account_role:'admin',account_id:code}})).status,200);
    const {password: generated, ...sent}=authCalls[0].body;
    assert.ok(generated!==account.password&&/^[A-Za-z0-9_-]{43}$/.test(generated));
    assert.deepEqual(sent,{email:account.email,data:{full_name:account.data.full_name,wacrm_email_first:true},code_challenge:account.code_challenge,code_challenge_method:'s256'});
    assert.equal((await call(signup,{method:'POST',headers:{...publicHeaders,'content-type':'text/plain'},body:JSON.stringify(account)})).status,415);
    assert.equal((await post(account)).status,429);
    const preview=await call('/auth/v1/verify?'+link);
    assert.equal(preview.status,303);
    const path=finish+'?token='+link.get('token');
    assert.equal(preview.headers.location,origin+path);
    assert.equal(preview.headers['referrer-policy'],'no-referrer');
    assert.equal((await call(path,{host:crm})).status,409);
    const page=await call(path,{host:crm,headers:{cookie:verifierCookie(verifierValue)}});
    assert.equal(page.status,200);
    assert.match(page.body,/Verify email and set password/);
    assert.equal(authCalls.length,1,'GET must not touch GoTrue');

    const complete=(cookie, confirm=account.password)=>call(finish,{host:crm,method:'POST',headers:{...formHeaders,...(cookie&&{cookie})},
      body:new URLSearchParams({token:link.get('token'),password:account.password,confirm}).toString()});

    assert.equal((await complete(null)).status,409);
    assert.equal((await complete(verifierCookie('c'.repeat(56)))).status,409);
    assert.equal((await complete(verifierCookie(verifierValue),'different')).status,400);
    assert.equal(authCalls.length,1,'invalid browser and password must not touch GoTrue');
    assert.equal((await call('/auth/v1/verify',{method:'POST',headers:formHeaders,body:'token='+link.get('token')})).status,404);
    assert.equal((await call('/auth/callback?next=%2Fsignup%2Fpassword&code='+code,{host:crm})).body,'/auth/callback');
    assert.equal((await call('/auth/callback?next=%2Fsignup%2Fpassword&token_hash=invalid&type=invite',{host:crm})).status,404);
    assert.equal((await call(exchange,{method:'POST',headers:publicHeaders})).status,404);
    const {origin:_,...privateHeaders}=publicHeaders;
    assert.equal((await call(exchange,{method:'POST',headers:privateHeaders,body:JSON.stringify({auth_code:code,code_verifier:'b'.repeat(56)})})).status,200);
    assert.equal((await call('/auth/v1/admin/users')).status,404);
    assert.equal((await call('/rest/v1/rpc/can_confirm_public_registration',{method:'POST',headers:publicHeaders,body:'{}'})).status,404);
    assert.equal((await call('/auth/v1/verify',{method:'POST',headers:formHeaders,body:'token=pkce_'+'b'.repeat(56)})).status,404);
    const setPassword=(method,body={password:account.password})=>call('/auth/v1/user',{method:'PUT',headers:{...publicHeaders,authorization:jwt(method)},body:JSON.stringify(body)});
    assert.equal((await setPassword('email/signup')).status,403);
    current.email_confirmed_at='2000-01-01T00:00:00Z';
    assert.equal((await setPassword('password')).status,403);
    assert.equal((await setPassword('email/signup',{password:account.password,email:account.email})).status,400);
    assert.equal((await setPassword('email/signup',{password:account.password,code_challenge:'fixture'})).status,400);
    assert.equal((await setPassword('email/signup',{password:account.password,code_challenge_method:'s256'})).status,400);
    assert.equal((await setPassword('email/signup',{password:account.password,code_challenge:null,code_challenge_method:null})).status,200);
    assert.deepEqual(authCalls.findLast(x=>x.method==='PUT').body,{password:account.password});

    const cookie='sb-api-auth-token=base64-'+Buffer.from(JSON.stringify({access_token:jwt('password').slice(7)})).toString('base64url');
    const history=(path,options={})=>call(path,{host:crm,...options,headers:{cookie,...options.headers}});
    const contentType='application/x-www-form-urlencoded';
    const body='confirmation=history-now-v1';
    const postHistory=(headers,command=body)=>history('/history-request',{method:'POST',headers:{'content-type':contentType,...headers},body:command});

    assert.equal((await call('/history-request',{host:crm})).status,401);
    assert.equal((await history('/history-request',{host:api})).status,404);
    assert.equal((await history('/history-request?')).status,404);
    assert.equal((await history('/history-request/')).status,404);
    assert.equal((await history('/history-request',{method:'HEAD'})).status,404);
    assert.equal((await history('/history-permissions',{headers:{apikey:anon}})).status,401);
    assert.equal((await postHistory({'x-forwarded-host':crm})).status,403);
    assert.equal((await postHistory({origin,'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await postHistory({origin,'content-type':'application/json'})).status,415);
    assert.equal((await postHistory({origin},'a'.repeat(1025))).status,413);
    accountRole='admin';
    assert.equal((await history('/history-request')).status,403);
    accountRole='owner';
    assert.equal(historyCalls.length,0);
    assert.equal((await history('/history-permissions')).status,200);
    assert.equal((await history('/history-permissions',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,200);
    assert.equal((await postHistory({origin,'sec-fetch-site':'same-origin','x-forwarded-host':'wrong.invalid'})).status,200);
    assert.deepEqual(historyCalls.map(c=>[c.path,c.method,c.body]),[
      ['/history-permissions','GET',''],['/history-permissions','POST','{}'],['/history-request','POST',body],
    ]);
    assert.equal(historyCalls[2].headers['x-forwarded-host'],undefined);
    assert.equal((await setPassword('email/signup')).status,403);
    current.app_metadata={wacrm_email_first:true};
    const unrelated=Buffer.from(JSON.stringify({access_token:jwt('password').slice(7)})).toString('base64url');
    const completed=await complete(verifierCookie(verifierValue)+`; sb-api-auth-token=base64-${unrelated}`);
    assert.equal(completed.status,303);
    assert.equal(completed.headers.location,'/login');
    assert.equal(completed.headers['set-cookie'],undefined);
    const write=authCalls.findLast(x=>x.method==='PUT');
    assert.equal(write.body.password,account.password);
    assert.equal(write.authorization,jwt('email/signup'));
    assert.equal(authCalls.at(-1).url,'/logout?scope=local');
    assert.equal((await call('/auth/v1/token?grant_type=password',{method:'POST',headers:publicHeaders,body:'{}'})).status,200);
  }finally{await stop();await Promise.all([auth,app].map(s=>new Promise(r=>s.close(r))));rmSync(dir,{recursive:true,force:true});}
});
