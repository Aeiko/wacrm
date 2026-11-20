import { connection } from 'next/server';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  await connection();

  return (
    <SettingsClient
      memberSignupEnabled={
        process.env.WHATSAPP_COEXISTENCE_ENABLED === 'true' &&
        process.env.WHATSAPP_COEXISTENCE_MEMBER_SIGNUP_ENABLED === 'true'
      }
      historyRequestEnabled={
        process.env.WHATSAPP_COEXISTENCE_ENABLED === 'true' &&
        process.env.WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED === 'true'
      }
    />
  );
}
