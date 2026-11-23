import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { memberSubscriptionMatches } from '../coexistence-meta';
import type { MemberReceiverReview } from './member-activation-evidence';

const filename = '/run/wacrm-member-readiness/app-routing.json';
const callback = 'https://wacrm.sqkii.land/api/whatsapp/webhook';
const id = z.string().regex(/^[1-9]\d{0,31}$/);

const receipt = z.strictObject({
  appId: id,
  loginConfigId: id,
  partnerId: id,
  callback: z.literal(callback),
  release: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  // Receipt references the scoped dashboard read and signed lifecycle rehearsal on installed software.
  dashboardEvidence: z.string().regex(/^[a-f0-9]{64}$/),
  lifecycleEvidence: z.string().regex(/^[a-f0-9]{64}$/),
  messagesVersion: z.enum(['v26.0', 'v27.0']),
  accountUpdateVersion: z.literal('v27.0'),
  reviewedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export function appRoutingMatches(
  raw: string,
  pins: { appId: string; loginConfigId: string; partnerId: string },
  release: string | undefined,
  now = Date.now()
) {
  try {
    const proof = receipt.parse(JSON.parse(raw));
    const start = Date.parse(proof.reviewedAt);
    const end = Date.parse(proof.expiresAt);

    return (
      proof.appId === pins.appId &&
      proof.loginConfigId === pins.loginConfigId &&
      proof.partnerId === pins.partnerId &&
      proof.release === release &&
      start <= now &&
      now < end &&
      end - start <= 15 * 60_000
    );
  } catch {
    return false;
  }
}

export async function reviewMemberAppRouting(pins: {
  appId: string;
  loginConfigId: string;
  partnerId: string;
}) {
  try {
    const file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );

    try {
      const stat = await file.stat();

      if (
        !stat.isFile() ||
        stat.uid !== 0 ||
        (stat.mode & 0o222) !== 0 ||
        stat.size > 2048
      )
        return false;

      const bytes = Buffer.alloc(2049);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

      return (
        bytesRead === stat.size &&
        appRoutingMatches(
          bytes.subarray(0, bytesRead).toString('utf8'),
          pins,
          process.env.WHATSAPP_MEMBER_RECEIVER_RELEASE
        )
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

export const reviewMemberReceiver: MemberReceiverReview = async (
  target,
  signal,
  { accessToken, transport }
) => {
  if (!(await reviewMemberAppRouting(target))) return false;

  return (
    (await memberSubscriptionMatches(
      { ...target, callback },
      accessToken,
      transport,
      signal
    )) && (await reviewMemberAppRouting(target))
  );
};
