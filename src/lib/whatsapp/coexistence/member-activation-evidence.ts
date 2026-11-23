import {
  validateCoexistenceToken,
  verifyCoexistencePhone,
  type CoexistenceFetch,
} from '../coexistence-meta';

export type MemberActivationTarget = {
  appId: string;
  partnerId: string;
  loginConfigId: string;
  wabaId: string;
  phoneNumberId: string;
  intendedPhone: string;
};

// The installed verifier must check authenticated receiver and subscription evidence,
// including current stop coverage, for this exact pair. Never source this from the form.
export type MemberReceiverReview = (
  target: MemberActivationTarget,
  signal: AbortSignal,
  context: { accessToken: string; transport: CoexistenceFetch }
) => Promise<boolean>;

export async function verifyMemberActivationEvidence(
  target: MemberActivationTarget,
  accessToken: string,
  appAccessToken: string,
  transport: CoexistenceFetch,
  reviewReceiver: MemberReceiverReview,
  signal: AbortSignal
) {
  signal.throwIfAborted();

  const grants = await validateCoexistenceToken(
    { expectedAppId: target.appId, accessToken, appAccessToken, signal },
    transport
  );

  const management = grants.granular_scopes?.filter(
    ({ scope }) => scope === 'whatsapp_business_management'
  );

  if (
    !management?.length ||
    management.some(
      ({ target_ids }) =>
        !target_ids?.length || target_ids.some((id) => id !== target.wabaId)
    ) ||
    grants.granular_scopes?.some(
      ({ scope, target_ids }) =>
        scope === 'whatsapp_business_messaging' &&
        target_ids !== undefined &&
        (target_ids.length !== 1 || target_ids[0] !== target.wabaId)
    )
  )
    throw new Error('Activation grant scope unavailable');

  const phone = await verifyCoexistencePhone(
    {
      wabaId: target.wabaId,
      accessToken,
      discoveryPhone: target.intendedPhone,
      signal,
    },
    transport
  );

  if (phone.phoneNumberId !== target.phoneNumberId)
    throw new Error('Activation phone changed');

  if (
    (await reviewReceiver(target, signal, { accessToken, transport })) !== true
  )
    throw new Error('Activation receiver evidence unavailable');

  signal.throwIfAborted();

  return new Date(
    Math.min(
      grants.expires_at,
      grants.data_access_expires_at ?? grants.expires_at
    ) * 1000
  ).toISOString();
}
