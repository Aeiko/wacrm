import messages from '../../messages/en.json';

export const english = { locale: 'en', messages };

export function getServerIntlConfig() {
  return {
    ...english,
    // Match the server's default time zone on both server and browser renders.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
