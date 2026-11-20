'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import type { AccountRole } from '@/lib/auth/roles';
import { signupAttemptSchema } from '@/lib/whatsapp/coexistence/signup-contract';

interface PreviewScope {
  actorId: string;
  accountId: string;
  sessionId: string;
  attemptId: string;
  contextId: string;
}

// Controlled render only: the signup response does not expose this scope to the browser.
export function CoexistenceHistoryRehearsal({
  context,
  preview,
}: {
  context:
    | (PreviewScope & {
        kind: 'signup-preview' | 'configuration';
        role: AccountRole;
      })
    | null;
  preview: (PreviewScope & { attempt: unknown }) | null;
}) {
  if (
    context?.kind !== 'signup-preview' ||
    context.role !== 'owner' ||
    !preview
  )
    return null;

  const scopeKeys = [
    'actorId',
    'accountId',
    'sessionId',
    'attemptId',
    'contextId',
  ] as const;

  if (scopeKeys.some((key) => !context[key] || context[key] !== preview[key]))
    return null;

  const parsed = signupAttemptSchema.safeParse(preview.attempt);

  if (!parsed.success) return null;

  const attempt = parsed.data;
  const target = attempt.preview;

  if (
    attempt.id !== context.attemptId ||
    attempt.state !== 'confirmed' ||
    attempt.reason !== null ||
    !target ||
    target.normalized_phone_number !== attempt.intended_phone
  )
    return null;

  return (
    <HistoryDraft
      key={JSON.stringify([
        ...scopeKeys.map((field) => context[field]),
        target.waba_id,
        target.phone_number_id,
        target.normalized_phone_number,
      ])}
      suffix={target.normalized_phone_number.slice(-4)}
    />
  );
}

function HistoryDraft({ suffix }: { suffix: string }) {
  const t = useTranslations('Settings.whatsapp.historyRehearsal');
  const [choice, setChoice] = useState<'no' | 'history' | 'reviewed'>('no');

  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="font-medium">{t('title')}</legend>
      <p>{t('target', { suffix })}</p>
      <p>{t('localOnly')}</p>
      <p>{t('eligibility')}</p>
      <p>{t('window')}</p>
      <p>{t('contactsUnavailable')}</p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={choice !== 'no'}
          onChange={(event) =>
            setChoice(event.target.checked ? 'history' : 'no')
          }
        />
        {t('historyOnly')}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={choice !== 'history'}
          onClick={() => setChoice('reviewed')}
        >
          {t('review')}
        </Button>
        <Button type="button" variant="outline" onClick={() => setChoice('no')}>
          {t('cancel')}
        </Button>
      </div>
      <div role="status">{choice === 'reviewed' && <p>{t('reviewed')}</p>}</div>
    </fieldset>
  );
}
