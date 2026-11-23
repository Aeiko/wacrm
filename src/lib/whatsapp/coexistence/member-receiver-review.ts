import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { memberSubscriptionMatches } from '../coexistence-meta';
import type { MemberReceiverReview } from './member-activation-evidence';

const directory = '/run/wacrm-member-readiness';
const epoch = z.string().regex(/^[a-f0-9]{64}$/);

const heartbeat = z.strictObject({
  epoch,
  release: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  since: z.iso.datetime(),
  checkedAt: z.iso.datetime(),
});

const callback = 'https://wacrm.sqkii.land/api/whatsapp/webhook';
const id = z.string().regex(/^[1-9]\d{0,31}$/);

const receipt = z.strictObject({
  epoch,
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
  monitor: string | undefined,
  now = Date.now()
) {
  try {
    const proof = receipt.parse(JSON.parse(raw));

    if (!monitor) return false;

    const live = heartbeat.parse(JSON.parse(monitor));
    const checked = Date.parse(live.checkedAt);
    const since = Date.parse(live.since);
    const start = Date.parse(proof.reviewedAt);
    const end = Date.parse(proof.expiresAt);

    return (
      live.epoch === proof.epoch &&
      live.release === release &&
      since <= start &&
      start <= checked &&
      checked <= now &&
      now - checked <= 5_000 &&
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

async function readProof(name: 'app-routing.json' | 'receiver-epoch.json') {
  const file = await open(
    `${directory}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );

  try {
    const stat = await file.stat();

    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o222) !== 0 || stat.size > 2048)
      return undefined;

    const bytes = Buffer.alloc(2049);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

    return bytesRead === stat.size ? bytes.subarray(0, bytesRead).toString('utf8') : undefined;
  } finally {
    await file.close();
  }
}

export async function reviewMemberAppRouting(pins: {
  appId: string;
  loginConfigId: string;
  partnerId: string;
}) {
  try {
    const proof = await readProof('app-routing.json');
    const monitor = await readProof('receiver-epoch.json');

    return !!proof && appRoutingMatches(proof, pins, process.env.WHATSAPP_MEMBER_RECEIVER_RELEASE, monitor);
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
