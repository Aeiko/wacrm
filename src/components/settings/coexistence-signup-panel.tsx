'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useAuth } from '@/hooks/use-auth';
import {
  signupAttemptSchema,
  signupStatusSchema,
  type SignupStatus,
} from '@/lib/whatsapp/coexistence/signup-contract';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

const statusSchema = signupStatusSchema.strict().extend({
  attempt: signupAttemptSchema
    .strict()
    .extend({
      preview: signupAttemptSchema.shape.preview.unwrap().strict().nullable(),
      created_at: signupAttemptSchema.shape.created_at.max(40),
      lease_until: signupAttemptSchema.shape.lease_until.max(40),
    })
    .nullable(),
});

export function CoexistenceSignupPanel() {
  const {
    user,
    profile,
    accountId,
    accountRole,
    accountStatus,
    loading,
    profileLoading,
  } = useAuth();

  if (
    loading ||
    profileLoading ||
    accountStatus !== 'ready' ||
    !user ||
    !accountId ||
    accountRole !== 'owner' ||
    profile?.account_role !== 'owner' ||
    profile.account_id !== accountId
  )
    return null;

  return <SignupInspection key={`${user.id}:${accountId}`} />;
}

function SignupInspection() {
  const t = useTranslations('Settings.whatsapp.signup');
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SignupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus(null);
    setFailed(false);
    setBusy(true);

    try {
      const response = await fetch('/api/whatsapp/coexistence/signup', {
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) throw new Error('Status unavailable');
      const body = statusSchema.parse(await response.json());

      if (!controller.signal.aborted) setStatus(body);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function toggle() {
    if (open) {
      request.current?.abort();
      setStatus(null);
      setBusy(false);
      setFailed(false);
      setOpen(false);
    } else {
      setOpen(true);
      void refresh();
    }
  }

  const attempt = status?.attempt;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          variant="outline"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="coexistence-signup-status"
        >
          {t(open ? 'hide' : 'inspect')}
        </Button>
        {open && (
          <div
            id="coexistence-signup-status"
            className="space-y-4"
            aria-busy={busy}
          >
            <p>{t('policy')}</p>
            <Alert>
              <AlertDescription>{t('unavailable')}</AlertDescription>
            </Alert>
            <p>{t('notActivated')}</p>
            <div role="status" aria-live="polite">
              {busy && <p>{t('loading')}</p>}
              {failed && <p>{t('failed')}</p>}
              {status && !status.enabled && <p>{t('disabled')}</p>}
              {status && !attempt && <p>{t('empty')}</p>}
              {attempt && (
                <dl className="grid gap-2 break-all">
                  <dt>{t('state')}</dt>
                  <dd>{t(`states.${attempt.state}`)}</dd>
                  <dt>{t('intendedPhone')}</dt>
                  <dd>{attempt.intended_phone}</dd>
                  <dt>{t('createdAt')}</dt>
                  <dd>{attempt.created_at}</dd>
                  <dt>{t('leaseUntil')}</dt>
                  <dd>{attempt.lease_until}</dd>
                  {attempt.reason && (
                    <>
                      <dt>{t('reason')}</dt>
                      <dd>{t(`reasons.${attempt.reason}`)}</dd>
                    </>
                  )}
                </dl>
              )}
              {attempt?.preview && (
                <section aria-label={t('preview')}>
                  <h3>{t('preview')}</h3>
                  <dl className="grid gap-2 break-all">
                    <dt>{t('displayPhone')}</dt>
                    <dd>{attempt.preview.display_phone_number}</dd>
                    <dt>{t('normalizedPhone')}</dt>
                    <dd>{attempt.preview.normalized_phone_number}</dd>
                    <dt>{t('phoneId')}</dt>
                    <dd>{attempt.preview.phone_number_id}</dd>
                    <dt>{t('wabaId')}</dt>
                    <dd>{attempt.preview.waba_id}</dd>
                  </dl>
                </section>
              )}
            </div>
            <Button variant="outline" disabled={busy} onClick={refresh}>
              {t('refresh')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
