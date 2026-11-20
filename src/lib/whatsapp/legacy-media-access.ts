import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { decrypt } from './encryption';

const connectionSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  user_id: z.string().min(1),
  phone_number_id: z.string().regex(/^\d+$/),
  access_token: z.string().min(1),
  status: z.literal('connected'),
  coexistence_app_id: z.null(),
  coexistence_generation: z.string().min(1),
});

export type LegacyMediaConnection = z.infer<typeof connectionSchema>;

// Shared by the raw proxy and public mirror; never authorize from editable message URLs.
export async function assertLegacyMediaAccess(
  db: SupabaseClient,
  expectedConnection: LegacyMediaConnection,
  accessToken: string,
  mediaId: string
): Promise<string> {
  try {
    if (!/^\d+$/.test(mediaId)) throw new Error();
    const expected = connectionSchema.parse(expectedConnection);

    const { data, error } = await db
      .from('whatsapp_config')
      .select(
        'id,account_id,user_id,phone_number_id,access_token,status,coexistence_app_id,coexistence_generation'
      )
      .eq('id', expected.id)
      .eq('account_id', expected.account_id)
      .single();

    if (error) throw new Error();
    const current = connectionSchema.parse(data);

    if (
      current.id !== expected.id ||
      current.account_id !== expected.account_id ||
      current.user_id !== expected.user_id ||
      current.phone_number_id !== expected.phone_number_id ||
      current.coexistence_generation !== expected.coexistence_generation ||
      current.access_token !== expected.access_token ||
      decrypt(current.access_token) !== accessToken
    )
      throw new Error();

    const owner = await db
      .from('profiles')
      .select('account_id')
      .eq('user_id', current.user_id)
      .single();

    if (owner.error || owner.data?.account_id !== current.account_id)
      throw new Error();

    // An independently managed binding for this phone is private even before ledger capture commits.
    const managed = await db
      .from('whatsapp_config')
      .select('id')
      .eq('phone_number_id', current.phone_number_id)
      .not('coexistence_app_id', 'is', null)
      .limit(1);

    if (
      managed.error ||
      !Array.isArray(managed.data) ||
      managed.data.length !== 0
    )
      throw new Error();

    const signup = await db.rpc('coexistence_signup_media_allowed', {
      p_account_id: current.account_id,
      p_config_id: current.id,
      p_generation: current.coexistence_generation,
    });

    if (signup.error || signup.data !== true) throw new Error();

    const classification = await db.rpc('coexistence_is_private_media', {
      p_media_id: mediaId,
    });

    if (classification.error || classification.data !== false)
      throw new Error();

    return current.phone_number_id;
  } catch {
    // Transport errors and database responses can contain credentials; expose none of them.
    throw new Error('Legacy media unavailable');
  }
}
