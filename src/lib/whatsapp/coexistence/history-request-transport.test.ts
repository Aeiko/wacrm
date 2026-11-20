import { createServer } from 'node:http';
import { connect } from 'node:net';
import { expect, it, vi } from 'vitest';
import { listenForFetch } from '@/test/http-server';
import { createHistoryRequestTransport } from './history-request-transport';

it.each([200, 307, 421, 503, 'lost', 'oversize'] as const)(
  'issues only one direct history POST for %s',
  async (reply) => {
    const incoming: string[] = [];

    const server = createServer(async (req, res) => {
      let data = '';

      for await (const chunk of req) data += chunk;
      incoming.push(`${req.method} ${req.url} ${data}`);

      if (reply === 'lost') return req.socket.destroy();
      res.writeHead(reply === 'oversize' ? 200 : reply, {
        location: '/no-follow',
      });
      res.end(reply === 'oversize' ? 'x'.repeat(65537) : '{}');
    });

    vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '123');

    try {
      const origin = await listenForFetch(server);

      const wire = createHistoryRequestTransport((_options, done) => {
        const socket = connect(Number(new URL(origin).port), '127.0.0.1', () =>
          done(null, socket)
        );

        socket.once('error', (error) => done(error, null));
      });

      const init = {
        method: 'POST',
        redirect: 'error' as const,
        signal: AbortSignal.timeout(3000),
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'application/json',
        },
        body: '{"messaging_product":"whatsapp","sync_type":"history"}',
      };

      const url = new URL('https://graph.facebook.com/v27.0/123/smb_app_data');
      await expect(
        wire(new URL('/v27.0/124/smb_app_data', url), init)
      ).rejects.toThrow();
      await expect(
        wire(url, { ...init, body: '{"sync_type":"smb_app_state_sync"}' })
      ).rejects.toThrow();
      expect(incoming).toHaveLength(0);
      const response = wire(url, init);

      if (reply === 'lost' || reply === 'oversize')
        await expect(response).rejects.toThrow();
      else expect((await response).status).toBe(reply);
      expect(incoming).toEqual([`POST ${url.pathname} ${init.body}`]);
    } finally {
      server.closeAllConnections();
      server.close();
      vi.unstubAllEnvs();
    }
  }
);
