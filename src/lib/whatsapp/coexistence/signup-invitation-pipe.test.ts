import { PassThrough, Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { readSignupInvitationPipe } from './signup-invitation-pipe';
import type { SupervisedSignupInvitation } from './supervised-signup';

const invite = {
  appId: '123',
  wabaId: '777',
  phoneId: '888',
  loginConfigId: '456',
  intendedPhone: '+12025550124',
  nonce: '10000000-0000-4000-8000-000000000001',
  actorId: '10000000-0000-4000-8000-000000000002',
  sessionId: '10000000-0000-4000-8000-000000000003',
  accountId: '10000000-0000-4000-8000-000000000004',
  attemptId: '10000000-0000-4000-8000-000000000005',
  intentId: '10000000-0000-4000-8000-000000000006',
  revision: '10000000-0000-4000-8000-000000000007',
} satisfies SupervisedSignupInvitation;

const json = JSON.stringify(invite);
const frame = Buffer.from(`${json}\n`);

afterEach(() => vi.useRealTimers());

it('returns the invitation only after EOF, even when the LF is written separately', async () => {
  const pipe = new PassThrough();
  const settled = vi.fn();
  const result = readSignupInvitationPipe(pipe).then(settled);
  pipe.write(frame.subarray(0, -1));
  pipe.write(frame.subarray(-1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).not.toHaveBeenCalled();
  pipe.end();
  await result;
  expect(settled).toHaveBeenCalledExactlyOnceWith(invite);
});

it.each([
  ['empty input', Buffer.alloc(0)],
  ['partial JSON', Buffer.from(`${json.slice(0, -1)}\n`)],
  ['missing LF', Buffer.from(json)],
  ['CRLF', Buffer.from(`${json}\r\n`)],
  ['trailing newline', Buffer.from(`${json}\n\n`)],
  ['second frame', Buffer.concat([frame, frame])],
  ['outer receipt', Buffer.from(`${JSON.stringify({ status: 'issued', invitation: invite })}\n`)],
  ['array', Buffer.from(`[${json}]\n`)],
  ['extra field', Buffer.from(`${JSON.stringify({ ...invite, extra: true })}\n`)],
  ['invalid ID', Buffer.from(`${JSON.stringify({ ...invite, appId: '0' })}\n`)],
  ['duplicate key', Buffer.from(`{"appId":"123",${json.slice(1)}\n`)],
  ['noncompact serializer', Buffer.from(`${JSON.stringify(invite, null, 2)}\n`)],
  ['noncanonical escape', Buffer.from(`${json.replace('123', '\\u003123')}\n`)],
  ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frame])],
  ['malformed UTF-8', Buffer.concat([Buffer.from([0xc0, 0x80]), frame])],
  ['decoded input', json + '\n'],
])('rejects %s', async (_label, data) => {
  const pipe = Readable.from([data]);
  await expect(readSignupInvitationPipe(pipe)).resolves.toBeNull();
  expect(pipe.destroyed).toBe(true);
});

it('destroys an oversized stream without waiting for EOF', async () => {
  const pipe = new PassThrough();
  const result = readSignupInvitationPipe(pipe);
  pipe.write(Buffer.alloc(4096, 0x20));
  pipe.write(Buffer.from('\n'));
  await expect(result).resolves.toBeNull();
  expect(pipe.destroyed).toBe(true);
});

it('times out and destroys an open stream even after receiving a complete frame', async () => {
  vi.useFakeTimers();
  const pipe = new PassThrough();
  const result = readSignupInvitationPipe(pipe);
  pipe.write(frame);
  await vi.advanceTimersByTimeAsync(4000);
  await expect(result).resolves.toBeNull();
  expect(pipe.destroyed).toBe(true);
});

it.each([undefined, new Error('private stream failure')])(
  'rejects an aborted stream before EOF (%s)',
  async (error) => {
    const pipe = new PassThrough();
    const result = readSignupInvitationPipe(pipe);
    pipe.write(frame);
    pipe.destroy(error);
    await expect(result).resolves.toBeNull();
  }
);
