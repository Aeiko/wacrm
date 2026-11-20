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
  const current={email_confirmed_at:null,app_metadata:{wacrm_email_first:true}};
  const jwt=method=>`Bearer e30.${Buffer.from(JSON.stringify({sub:code,role:'authenticated',aud:'authenticated',iss:`https://${api}/auth/v1`,exp:Math.floor(Date.now()/1000)+300,session_id:code,amr:[{method}]})).toString('base64url')}.fixture`;

  const auth=await listen(0,addr.auth,async(req,res)=>{
    const chunks=[];

for await(const c of req)chunks.push(c);
    const raw=Buffer.concat(chunks).toString();

    if(req.url==='/rpc/can_confirm_public_registration')return res.end(JSON.stringify(JSON.parse(raw).p_token===link.get('token')));
    authCalls.push({url:req.url,method:req.method,body:raw&&JSON.parse(raw)});

    if(req.url==='/user'&&req.method==='GET')return res.end(JSON.stringify({id:code,role:'authenticated',aud:'authenticated',...current}));

    if(req.url==='/user'&&req.method==='PUT'){
      current.app_metadata={};

      return res.end('{}');
    }

    if(req.url.startsWith('/verify?'))res.writeHead(303,{location:callback+'&code='+code});
    else res.writeHead(200);
    res.end();
  });

  const app=await listen(0,addr.crmIP,(req,res)=>res.end(req.url.split('?')[0]));
  const reservation=reservePort();
  await new Promise((resolve,reject)=>reservation.once('error',reject).listen(0,addr.listen,resolve));
  gatewayPort=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const fixturePorts={gateway:gatewayPort, auth:auth.address().port, crm:app.address().port, rest:auth.address().port};
  writeFileSync(join(dir,'gateway/upstreams.json'),JSON.stringify({...addr,fixturePorts}));
  const env={...process.env,LOGIN_GATEWAY_MODE:'private-http-fixture-v1',LOGIN_GATEWAY_FIXTURE_DIR:dir,LOGIN_CRM_HOST:crm,LOGIN_API_HOST:api};
  let child;

  async function start(enabled){
    child=spawn(process.execPath,[fileURLToPath(new URL('./login-gateway.mjs',import.meta.url))],{env:{...env,LOGIN_PUBLIC_EMAIL_REGISTRATION:enabled?'true':'false'},stdio:'ignore'});

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
    const page=await call('/auth/v1/verify?'+link);
    assert.equal(page.status,200);
    assert.equal(page.headers['referrer-policy'],'no-referrer');
    assert.match(page.body,/Confirm email/);
    assert.equal(authCalls.length,1,'preview must not consume the credential');
    assert.equal((await call('/auth/v1/verify?'+link+'&type=invite')).status,404);
    assert.equal((await call('/auth/v1/verify',{method:'POST',headers:{...formHeaders,'sec-fetch-site':'cross-site'},body:'token='+link.get('token')})).status,403);
    const confirmed=await call('/auth/v1/verify',{method:'POST',headers:formHeaders,body:'token='+link.get('token')});
    assert.equal(confirmed.status,303);assert.equal(confirmed.headers.location,callback+'&code='+code);
    assert.equal(authCalls[1].method,'GET');
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
    assert.equal((await setPassword('email/signup')).status,403);
    assert.equal((await call('/auth/v1/token?grant_type=password',{method:'POST',headers:publicHeaders,body:'{}'})).status,200);
  }finally{await stop();await Promise.all([auth,app].map(s=>new Promise(r=>s.close(r))));rmSync(dir,{recursive:true,force:true});}
});
