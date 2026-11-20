import { renameSync, writeFileSync } from 'node:fs';

const totals = {
  seen: 0,
  committed: 0,
  auth_rejected: 0,
  invalid_delivery: 0,
  storage_failure: 0,
};

const snapshot = '/run/wacrm-outcomes/counts.json';
let pending = false;

export const postOutcomes = {
  count(outcome: keyof typeof totals) {
    if (process.env.WHATSAPP_COEXISTENCE_PRIVATE_OUTCOMES !== 'true') return;

    if (totals[outcome] < Number.MAX_SAFE_INTEGER) totals[outcome]++;

    if (pending) return;

    pending = true;

    // At most one small atomic write per second; never hold a request open for diagnostics.
    setTimeout(() => {
      pending = false;

      try {
        writeFileSync(`${snapshot}.tmp`, JSON.stringify(totals), {
          mode: 0o600,
        });
        renameSync(`${snapshot}.tmp`, snapshot);
      } catch {
        // Diagnostics must not change the webhook result or emit request logs.
      }
    }, 1000).unref();
  },
};
