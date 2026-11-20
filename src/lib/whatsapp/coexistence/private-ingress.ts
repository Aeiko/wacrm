import { request } from 'node:http';
import type { JsonValue } from './payload';
import { jsonSchema } from './payload';

export async function postPrivateIngress(args: JsonValue): Promise<JsonValue> {
  const token = process.env.WHATSAPP_COEXISTENCE_PRIVATE_REST_TOKEN ?? '';

  // Loopback belongs to the approved receiver-only namespace. Never resolve a hostname,
  // use a proxy/redirect, or reuse the regular Supabase service-role client here.
  if (
    process.env.WHATSAPP_COEXISTENCE_PRIVATE_REST_ORIGIN !==
      'http://127.0.0.1:3902' ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw new Error('Private ingress configuration unavailable');

  const body = JSON.stringify(args);

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: 3902,
        path: '/rpc/coexistence_ingress',
        method: 'POST',
        agent: false,
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new Error('Private ingress rejected'));

          return;
        }

        let receipt = '';

        res.setEncoding('utf8');
        res.on('error', reject);
        res.on('data', (chunk: string) => {
          receipt += chunk;

          if (receipt.length > 16_384)
            res.destroy(new Error('Private ingress receipt too large'));
        });
        res.on('end', () => {
          try {
            resolve(jsonSchema.parse(JSON.parse(receipt)));
          } catch {
            reject(new Error('Invalid private ingress receipt'));
          }
        });
      }
    );

    req.on('error', reject);
    req.end(body);
  });
}
