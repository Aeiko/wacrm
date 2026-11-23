import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const gateway = process.env.MEMBER_GATEWAY_UNDER_TEST;

assert.ok(
  gateway,
  'set MEMBER_GATEWAY_UNDER_TEST to the patched login-gateway.mjs'
);

const addr = {
  auth: '127.0.0.4',
  rest: '127.0.0.4',
  proxy: '127.0.0.2',
  listen: '127.0.0.1',
  crmIP: '127.0.0.3',
};

const crm = 'crm.fixture.invalid',
  api = 'api.fixture.invalid',
  origin = `https://${crm}`;

const page = '/settings/connect-whatsapp',
  action = '/supervised-discovery';

const id = '79deabef-028d-489f-9d3b-499acf0b38b1';
const workspace = 'e20a6c6a-fd43-49c9-9a2a-c3e26abe5105';
const anon = 'synthetic-anon-key-not-a-credential';
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');

const jwt = (role) =>
  `header.${b64({ sub: id, aud: role, role, exp: 4102444800, session_id: id, iss: `https://${api}/auth/v1` })}.signature`;

const token = jwt('authenticated');
const value = (access) => `base64-${b64({ access_token: access })}`;
const name = 'sb-api-auth-token';
const cookie = `${name}=${value(token)}`;
const splitCookie = `${name}.0=${value(token).slice(0, 80)}; ${name}.1=${value(token).slice(80)}`;
const launch = { action: 'launch', intended_phone: '+12025550124' };

const postHeaders = {
  cookie,
  origin,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json;charset=UTF-8',
};

async function serve(host, handler) {
  const s = createServer(handler);
  await new Promise((resolve, reject) =>
    s.once('error', reject).listen(0, host, resolve)
  );

  return s;
}

const close = (s) => new Promise((resolve) => s.close(resolve));

test('permanent member gateway retains independent registration, member, and reply fences', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-origin-'));
  mkdirSync(join(dir, 'gateway'));
  writeFileSync(join(dir, 'anon'), anon);
  const calls = [];

  let profiles = [
    { user_id: id, account_id: workspace, account_role: 'viewer' },
  ];

  const auth = await serve(addr.auth, (req, res) => {
    if (req.url !== '/user' || req.headers.authorization !== `Bearer ${token}`)
      res.writeHead(401).end();
    else
      res.end(
        JSON.stringify({ id, role: 'authenticated', aud: 'authenticated' })
      );
  });

  const rest = await serve(addr.rest, (req, res) => {
    if (
      req.url !==
        `/profiles?select=user_id,account_id,account_role&user_id=eq.${id}&limit=2` ||
      req.headers.authorization !== `Bearer ${token}` ||
      req.headers.apikey !== anon
    )
      res.writeHead(403).end();
    else res.end(JSON.stringify(profiles));
  });

  const app = await serve(addr.crmIP, async (req, res) => {
    const chunks = [];

    for await (const c of req) chunks.push(c);
    calls.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    res
      .writeHead(200, { 'Cache-Control': 'public, max-age=60' })
      .end('fixture');
  });

  const reservation = await serve(addr.listen);
  const port = reservation.address().port;
  await close(reservation);
  writeFileSync(
    join(dir, 'gateway/upstreams.json'),
    JSON.stringify({
      ...addr,
      fixturePorts: {
        gateway: port,
        auth: auth.address().port,
        rest: rest.address().port,
        crm: app.address().port,
      },
    })
  );

  function call(
    path,
    { method = 'GET', host = crm, source = addr.proxy, headers, body } = {}
  ) {
    return new Promise((resolve, reject) => {
      const r = request(
        {
          hostname: addr.listen,
          port,
          localAddress: source,
          path,
          method,
          headers: { host, ...headers },
        },
        (res) => {
          res
            .resume()
            .on('end', () =>
              resolve({ status: res.statusCode, headers: res.headers })
            );
        }
      );

      r.on('error', reject).end(body);
    });
  }

  const status = async (expected, path, options) =>
    assert.equal((await call(path, options)).status, expected, path);

  const post = (body, headers = postHeaders) => ({
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  let child;

  async function start(flags = {}) {
    child = spawn(process.execPath, [gateway], {
      env: {
        ...process.env,
        LOGIN_GATEWAY_MODE: 'private-http-fixture-v1',
        LOGIN_GATEWAY_FIXTURE_DIR: dir,
        LOGIN_CRM_HOST: crm,
        LOGIN_API_HOST: api,
        LOGIN_MEMBER_SIGNUP_ENABLED: '',
        LOGIN_PUBLIC_EMAIL_REGISTRATION: '',
        MANAGED_INBOX_REPLY_ENABLED: '',
        ...flags,
      },
      stdio: 'ignore',
    });

    for (let i = 0; i < 50 && child.exitCode === null; i++) {
      try {
        await status(200, '/login');
        calls.length = 0;

        return;
      } catch {
        await delay(40);
      }
    }

    throw Error('gateway not ready');
  }

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
  }

  try {
    await start();
    await status(404, page, { headers: { cookie } });
    await status(404, action, post(launch));
    await status(404, '/api/whatsapp/send', post(launch));
    await status(404, '/signup');
    await stop();
    await start({
      LOGIN_MEMBER_SIGNUP_ENABLED: 'true',
      LOGIN_PUBLIC_EMAIL_REGISTRATION: 'true',
      MANAGED_INBOX_REPLY_ENABLED: 'true',
    });

    for (const path of [
      page + '/',
      page + '?workspace=other',
      action + '?',
      action + '?state=x',
      action + '/extra',
    ])
      await status(404, path, { headers: { cookie } });
    await status(404, action, { host: api, headers: { cookie } });
    await status(404, action, { method: 'HEAD', headers: { cookie } });
    await status(404, action, { method: 'OPTIONS', headers: { origin } });
    await status(404, page, post(launch));
    await status(403, action, {
      source: addr.listen,
      headers: { cookie, 'x-forwarded-for': addr.proxy },
    });
    await status(
      403,
      action,
      post(launch, { ...postHeaders, origin: 'https://other.fixture.invalid' })
    );
    await status(
      403,
      action,
      post(launch, { ...postHeaders, origin: [origin, origin] })
    );
    await status(
      403,
      action,
      post(launch, { ...postHeaders, 'sec-fetch-site': 'same-site' })
    );
    await status(401, action);
    await status(401, action, {
      headers: { cookie: `${name}.1=${value(token)}` },
    });
    await status(401, action, { headers: { cookie: `${cookie}; ${cookie}` } });
    await status(401, action, {
      headers: { cookie: `${name}=${value(jwt('service_role'))}` },
    });
    await status(401, action, {
      headers: { cookie, authorization: `Bearer ${token}` },
    });
    await status(400, action, {
      headers: { cookie, 'content-length': '2' },
      body: '{}',
    });
    profiles = [
      { user_id: id, account_id: workspace, account_role: 'outsider' },
    ];
    await status(403, action, post(launch));
    profiles = [{ user_id: id, account_id: workspace, account_role: 'viewer' }];
    await status(
      415,
      action,
      post(launch, { ...postHeaders, 'content-type': 'text/plain' })
    );
    await status(
      415,
      action,
      post(launch, { ...postHeaders, 'content-encoding': 'gzip' })
    );

    for (const bad of [
      { ...launch, account_id: workspace },
      { ...launch, actor_id: id },
      { action: 'finish', state: id, code: 'a\nb' },
      { action: 'confirm', state: id, waba_id: '01', phone_number_id: '1' },
    ])
      await status(400, action, post(bad));
    await status(
      413,
      action,
      post(
        { action: 'finish', state: id, code: 'a'.repeat(42 * 1024) },
        { ...postHeaders, 'transfer-encoding': 'chunked' }
      )
    );
    assert.equal(calls.length, 0, 'denied traffic never reached CRM');

    await status(200, `${page}?_rsc=test123`, {
      method: 'HEAD',
      headers: { cookie: splitCookie },
    });
    assert.equal(
      (await call(action, { headers: { cookie } })).headers['cache-control'],
      'no-store'
    );

    const activation = {
      action: 'activate',
      state: id,
      waba_id: '1234',
      phone_number_id: '2345',
      normalized_phone_number: '+12025550124',
    };

    await status(
      400,
      action,
      post({ ...activation, normalized_phone_number: '0124' }, postHeaders)
    );
    await status(
      400,
      action,
      post({ ...activation, access_token: 'not-allowed' }, postHeaders)
    );

    for (const command of [
      activation,
      launch,
      { action: 'finish', state: id, code: 'fixture-code' },
      {
        action: 'confirm',
        state: id,
        waba_id: '1234',
        phone_number_id: '2345',
      },
    ]) {
      const response = await call(
        action,
        post(command, {
          ...postHeaders,
          'x-forwarded-proto': 'http',
          'x-forwarded-host': api,
          'x-fixture': 'not-forwarded',
        })
      );

      assert.equal(response.status, 200);
      const last = calls.at(-1);
      assert.equal(last.path, action);
      assert.deepEqual(JSON.parse(last.body), command);
      assert.equal(last.headers['x-forwarded-proto'], 'https');

      for (const key of [
        'x-forwarded-host',
        'x-fixture',
        'authorization',
        'apikey',
      ])
        assert.equal(last.headers[key], undefined);
    }

    await status(200, '/signup');
    await status(404, '/auth/callback?next=%2Fdashboard&code=' + id, {
      host: api,
    });
    await status(
      200,
      '/api/whatsapp/send',
      post(launch, {
        ...postHeaders,
        'content-type': 'application/json',
        'idempotency-key': id,
      })
    );
    assert.equal(calls.at(-1).path, '/api/whatsapp/reply');
    await status(404, '/api/whatsapp/reply', post(launch));
    await status(403, '/settings?tab=whatsapp', { headers: { cookie } });
    await status(403, '/api/whatsapp/coexistence/signup', {
      headers: { cookie },
    });
    await status(404, '/rest/v1/rpc/coexistence_member_signup', {
      host: api,
      ...post(launch, { apikey: anon, authorization: `Bearer ${token}` }),
    });
    await status(401, '/rest/v1/rpc/dashboard_overview', {
      host: api,
      ...post(
        {},
        {
          apikey: jwt('service_role'),
          authorization: `Bearer ${jwt('service_role')}`,
        }
      ),
    });
  } finally {
    await stop();
    await Promise.all([auth, rest, app].map(close));
    rmSync(dir, { recursive: true, force: true });
  }
});
