import { isAscii } from 'node:buffer';
import type { Readable } from 'node:stream';
import {
  supervisedSignupInvitationSchema,
  type SupervisedSignupInvitation,
} from './supervised-signup';

const MAX_BYTES = 4096;
const TIMEOUT_MS = 4000;

async function readFrame(
  input: Readable
): Promise<SupervisedSignupInvitation | null> {
  if (
    !input.readable ||
    input.readableDidRead ||
    input.readableFlowing ||
    input.readableEncoding
  ) return null;

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) return null;

    size += chunk.length;

    if (size > MAX_BYTES || !isAscii(chunk)) return null;

    if (chunk.length) chunks.push(chunk);
  }

  if (!input.readableEnded || input.readableAborted) return null;

  const frame = Buffer.concat(chunks, size).toString('utf8');

  if (!frame.endsWith('\n')) return null;

  const json = frame.slice(0, -1);
  const value: unknown = JSON.parse(json);

  // Reserializing also rejects duplicate keys, which JSON.parse alone would accept.
  if (JSON.stringify(value) !== json) return null;

  const result = supervisedSignupInvitationSchema.safeParse(value);

  return result.success ? result.data : null;
}

/** The local host must first verify that stdin is a private pipe inherited from its supervisor. */
export async function readSignupInvitationPipe(
  input: Readable
): Promise<SupervisedSignupInvitation | null> {
  const deadline = Promise.withResolvers<null>();
  const timer = setTimeout(() => deadline.resolve(null), TIMEOUT_MS);
  let invitation: SupervisedSignupInvitation | null = null;

  try {
    invitation = await Promise.race([readFrame(input), deadline.promise]);
  } catch {
    // Do not expose parser or stream errors; they may contain invitation data.
  } finally {
    clearTimeout(timer);

    if (!invitation) input.destroy();
  }

  return invitation;
}
