import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const id = '11111111-1111-4111-8111-111111111111';
const origin = 'https://crm.example.invalid';

function request(body: Record<string, string> = {}, source = origin) {
  return new Request(origin + '/api/whatsapp/reply', {
    method: 'POST',
    headers: { origin: source, 'content-type': 'application/json', 'idempotency-key': id },
    body: JSON.stringify({ conversation_id: id, message_type: 'text', content_text: 'fixture', ...body }),
  });
}

describe('explicit managed inbox reply route', () => {
  beforeEach(() => {
    vi.stubEnv('MANAGED_INBOX_REPLY_ENABLED', 'true');
    vi.stubEnv('MANAGED_INBOX_REPLY_ACCOUNT', id);
    vi.stubEnv('MANAGED_INBOX_REPLY_CONFIG', id);
    vi.stubEnv('MANAGED_INBOX_REPLY_GENERATION', id);
    vi.stubEnv('MANAGED_INBOX_REPLY_REST_ORIGIN', 'http://172.29.240.5:3000');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('is disabled by default', async () => {
    vi.stubEnv('MANAGED_INBOX_REPLY_ENABLED', '');
    expect((await POST(request())).status).toBe(404);
  });

  it('denies a cross-origin request or a missing private binding', async () => {
    expect((await POST(request({}, 'https://other.example.invalid'))).status).toBe(403);
    vi.stubEnv('MANAGED_INBOX_REPLY_ACCOUNT', '');
    expect((await POST(request())).status).toBe(503);
  });

  it('rejects templates and contact-based sends without accessing the provider', async () => {
    expect((await POST(request({ message_type: 'template' }))).status).toBe(400);
    expect((await POST(request({ contact_id: id }))).status).toBe(400);
  });
});
