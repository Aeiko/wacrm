import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'http://127.0.0.1:8080';
const headers = { Host: 'wacrm.sqkii.land' };

function call(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      res.setEncoding('utf8');
      let body = '';

      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers), text: async () => body }));
    });

    req.on('error', reject).end();
  });
}

test('serves only the two signed-out notices and cross-links', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { stdio: 'ignore' });
  const exited = once(child, 'exit');

  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) throw new Error('Notices server exited');

      if (await call(`${origin}/privacy`, { headers }).catch(() => null)) break;
      await delay(50);
    }

    for (const [path, link, text] of [
      ['/privacy', '/data-deletion', 'Google Workspace sends account verification emails'],
      ['/data-deletion', '/privacy', 'Signing out or closing your login'],
    ]) {
      const response = await call(`${origin}${path}`, { headers });
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.match(body, new RegExp(text));
      assert.ok(body.includes(`href="${link}"`));
      assert.doesNotMatch(body, /<script|<form|review draft/i);

      const head = await call(`${origin}${path}`, { headers, method: 'HEAD' });
      const post = await call(`${origin}${path}`, { headers, method: 'POST' });

      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.equal(post.status, 405);
    }

    assert.equal((await call(`${origin}/privacy`)).status, 404);

    for (const path of ['/login', '/signup', '/api/whatsapp/webhook', '/privacy/', '/privacy?x=1']) {
      assert.equal((await call(`${origin}${path}`, { headers })).status, 404);
    }
  } finally {
    child.kill();
    await exited;
  }
});
