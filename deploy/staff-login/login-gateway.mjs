import { createServer } from 'node:https';
import { request } from 'node:http';
import { isIPv4 } from 'node:net';
import { readFileSync } from 'node:fs';

const mode=process.env.LOGIN_GATEWAY_MODE;
if(!['private-fixture-v1','private-staging-v1'].includes(mode)) process.exit(78);
const fixture=mode==='private-fixture-v1';
const dir='/run/staff-login';
const {owner,auth,rest}=JSON.parse(readFileSync(`${dir}/gateway/upstreams.json`,'utf8'));
const {LOGIN_API_HOST:api,LOGIN_CRM_HOST:crm}=process.env;
const hostName=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
if(!hostName.test(api)||!hostName.test(crm)||api===crm||(fixture?![api,crm].every(h=>h.endsWith('.fixture.invalid')):api!=='wacrm-api-staging.sqkii.land'||crm!=='wacrm-staging.sqkii.land')) throw Error('exact trial origins required');
if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owner)) throw Error('fixture owner required');
const anon=readFileSync(`${dir}/anon`,'utf8').trim();
const anonClaims=()=>JSON.parse(Buffer.from(anon.split('.')[1],'base64url'));
if(fixture?anon!=='synthetic-anon-key-not-a-credential':anon.length>2048||anonClaims().role!=='anon') throw Error('public anon token required');
const privateHost=host=>isIPv4(host)&&/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host);
if(!privateHost(auth)||!privateHost(rest)) throw Error('literal private IPv4 endpoints required');
const upstreams={auth:{host:auth,port:fixture?19999:9999},rest:{host:rest,port:fixture?3101:3000},crm:{host:'crm',port:3000}};
const origin='https://'+crm;
const headers=new Set('apikey authorization content-type x-client-info x-supabase-api-version accept-profile content-profile prefer range range-unit'.split(' '));
const tables=new Set('profiles accounts messages contacts deals broadcasts automation_logs conversations message_reactions'.split(' '));
const buckets=new Map();
function limited(kind,address){
  const now=Date.now(); for(const [k,v] of buckets)if(now>=v.end)buckets.delete(k);
  const key=kind+':'+address;
  if(!buckets.has(key)){if(buckets.size>=2048)return true;buckets.set(key,{count:0,end:now+60_000});}
  return ++buckets.get(key).count>(kind==='password'?5:30);
}
async function session(s){
  if(!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s??''))return false;
  try{
    const {host,port}=upstreams.auth;
    const r=await fetch(`http://${host}:${port}/user`,{headers:{authorization:s},redirect:'error',signal:AbortSignal.timeout(3500)});
    if(!r.ok){await r.body?.cancel();return false;}
    // GoTrue validates the actual bearer; role and subject come from its verified user response.
    const {id,role,aud}=await r.json();
    const claims=JSON.parse(Buffer.from(s.split('.')[1],'base64url'));
    return id===owner&&role==='authenticated'&&aud==='authenticated'&&claims.sub===id&&claims.role===role&&claims.aud===aud&&claims.iss===`https://${api}/auth/v1`&&Number.isSafeInteger(claims.exp)&&claims.exp>Date.now()/1000;
  }catch{return false;}
}
function end(res,status){res.writeHead(status);res.end();}
function pass(req,res,{host,port},path,keys,body){
  const forward={};for(const k of keys)if(req.headers[k]!==undefined)forward[k]=req.headers[k];
  if(body)forward['content-length']=body.length;
  const upstream=request({hostname:host,port,path,method:req.method,headers:forward,timeout:8000},r=>{
    const out={};for(const [k,v] of Object.entries(r.headers))if(!/^(access-control-|cache-control$|connection$|transfer-encoding$|server$|via$)/.test(k)&&(host===upstreams.crm.host||k!=='set-cookie'))out[k]=v;
    res.writeHead(r.statusCode,out); r.pipe(res);
  });
  upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>res.headersSent?res.destroy():end(res,502));
  res.on('close',()=>upstream.destroy());upstream.end(body);
}
const server=createServer({key:readFileSync(`${dir}/gateway/key.pem`),cert:readFileSync(`${dir}/ca.pem`),maxHeaderSize:16_384,requestTimeout:8000,headersTimeout:5000,connectionsCheckingInterval:1000},async(req,res)=>{
  try {
    res.setHeader('Cache-Control','no-store');
    const host=req.headers.host,m=req.method,raw=req.url;
    if(!raw||raw.length>8192||req.socket.servername!==host||![api,crm].includes(host))return end(res,400);
    const [path,query]=raw.split('?',2);
    if(!/^\/[A-Za-z0-9_./-]*$/.test(path)||path.includes('//')||path.split('/').some(x=>x==='.'||x==='..'))return end(res,404);
    if(host===crm){
      if(!['GET','HEAD'].includes(m)||!(/^\/_next\/static\//.test(path)||['/login','/dashboard','/inbox','/favicon.ico'].includes(path)))return end(res,404);
      return pass(req,res,upstreams.crm,raw,['host','accept','accept-language','cookie','rsc','next-router-state-tree','next-url','next-router-prefetch','next-router-segment-prefetch','sec-fetch-site']);
    }
    res.setHeader('Vary','Origin');
    if(req.headers.origin===origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Expose-Headers','Content-Range, Range-Unit, Preference-Applied');}
    else if(req.headers.origin)return end(res,403);
    const get=m==='OPTIONS'?req.headers['access-control-request-method']:m;
    const auth=path.startsWith('/auth/v1/');
    const token=path==='/auth/v1/token'&&get==='POST';
    const user=path==='/auth/v1/user'&&get==='GET'&&!query;
    const logout=path==='/auth/v1/logout'&&get==='POST'&&(!query||/^scope=(global|local)$/.test(query));
    const rest=path.startsWith('/rest/v1/')&&(get==='GET'&&tables.has(path.slice(9))||get==='POST'&&path==='/rest/v1/rpc/dashboard_overview'&&!query);
    const grant=/^grant_type=(password|refresh_token)$/.exec(query??'')?.[1];
    if(!(token&&grant||user||logout||rest))return end(res,404);
    if(m==='OPTIONS'){
      const wanted=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
      // PostgREST's SDK adds this marker on read retries; the gateway does not forward it.
      if(req.headers.origin!==origin||wanted.some(x=>!headers.has(x)&&!(rest&&get==='GET'&&x==='x-retry-count')))return end(res,403);
      res.setHeader('Vary','Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      res.setHeader('Access-Control-Allow-Methods',get);res.setHeader('Access-Control-Allow-Headers',wanted.join(', '));return end(res,204);
    }
    if(['host','origin','apikey','authorization','accept-profile','content-profile'].some(k=>(req.headersDistinct[k]?.length??0)>1))return end(res,400);
    if(req.headers.apikey!==anon||(!token&&!await session(req.headers.authorization))||(token&&req.headers.authorization!==`Bearer ${anon}`))return end(res,401);
    if(['accept-profile','content-profile'].some(k=>req.headers[k]&&req.headers[k]!=='public'))return end(res,403);
    if(token&&limited(grant,req.socket.remoteAddress))return end(res,429);
    let body;if(m==='POST'){
      const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192){end(res,413);return;}parts.push(chunk);}body=Buffer.concat(parts);
    }
    return pass(req,res,auth?upstreams.auth:upstreams.rest,raw.slice(8),headers,body);
  }catch{if(!res.headersSent)end(res,400);else res.destroy();}
});
server.maxConnections=48;server.on('checkContinue',(_q,r)=>end(r,417));server.on('upgrade',(_q,s)=>s.destroy());server.listen(443,'0.0.0.0');
