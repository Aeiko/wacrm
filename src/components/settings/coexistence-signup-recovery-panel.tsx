'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { z } from 'zod';
import { useAuth } from '@/hooks/use-auth';
import {
  recoveryReceiptSchema,
  recoveryStatusSchema,
  type recoveryRequestSchema,
} from '@/lib/whatsapp/coexistence/signup-recovery-contract';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const route = '/api/whatsapp/coexistence/operator/signup-recovery';

type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;

type Attempt = NonNullable<RecoveryStatus['attempt']>;

type Intent = z.infer<typeof recoveryRequestSchema>;

function actionFor(
  attempt: Attempt | null | undefined
): Intent['action'] | null {
  if (!attempt || attempt.disposition) return null;

  if (attempt.state === 'expired_unstarted') return 'close_unstarted';

  if (
    attempt.launched_at &&
    attempt.state !== 'confirmed' &&
    attempt.state !== 'cancelled'
  )
    return 'record_hold';

  return null;
}

export function CoexistenceSignupRecoveryPanel({
  onClosed,
}: {
  onClosed: () => void;
}) {
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
    (accountRole !== 'owner' && accountRole !== 'admin') ||
    profile?.account_id !== accountId ||
    profile.account_role !== accountRole
  )
    return null;

  return (
    <RecoveryInspection
      key={`${user.id}:${accountId}:${accountRole}`}
      onClosed={onClosed}
    />
  );
}

function RecoveryInspection({ onClosed }: { onClosed: () => void }) {
  const t = useTranslations('Settings.whatsapp.recovery');
  const [open, setOpen] = useState(false);

  const [snapshot, setSnapshot] = useState<{
    status: RecoveryStatus;
    resubmitting: boolean;
  } | null>(null);

  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const pending = useRef<Intent | null>(null);
  const freshAttempt = useRef<Attempt | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
      freshAttempt.current = null;
    },
    []
  );

  async function refresh(intent?: Intent) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;

    const options: RequestInit = {
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    };

    freshAttempt.current = null;
    setSnapshot(null);
    setFailed(false);
    setBusy(true);
    let closed = false;

    try {
      if (intent) {
        pending.current = intent;

        try {
          const response = await fetch(route, {
            ...options,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(intent),
          });

          if (response.status === 401 || response.status === 403)
            pending.current = null;

          if (!response.ok) throw new Error('No recovery receipt');
          const receipt = recoveryReceiptSchema.parse(await response.json());

          if (
            receipt.attempt_id !== intent.attempt_id ||
            receipt.request_id !== intent.request_id ||
            receipt.disposition !==
              (intent.action === 'close_unstarted'
                ? 'closed_unstarted'
                : 'held_uncertain')
          )
            throw new Error('Mismatched recovery receipt');

          if (controller.signal.aborted) return;
          pending.current = null;
          closed = receipt.disposition === 'closed_unstarted';
        } catch {
          // Only manual resubmission, after checking the same attempt again.
        }
      }

      if (controller.signal.aborted) return;
      const response = await fetch(route, options);

      if (response.status === 401 || response.status === 403)
        pending.current = null;

      if (!response.ok) throw new Error('Recovery status unavailable');
      const body = recoveryStatusSchema.parse(await response.json());

      if (controller.signal.aborted) return;

      const waiting = pending.current;

      if (
        waiting &&
        (waiting.attempt_id !== body.attempt?.id ||
          waiting.action !== actionFor(body.attempt))
      ) {
        pending.current = null;
        closed =
          waiting.attempt_id === body.attempt?.id &&
          body.attempt.disposition === 'closed_unstarted';
      }

      freshAttempt.current = body.attempt;
      setSnapshot({ status: body, resubmitting: pending.current !== null });
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);

        if (closed) onClosed();
      }
    }
  }

  const attempt = snapshot?.status.attempt;
  const action = actionFor(attempt);
  const resubmitting = snapshot?.resubmitting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          variant="outline"
          disabled={busy}
          aria-expanded={open}
          aria-controls="coexistence-signup-recovery"
          onClick={() => {
            setOpen(!open);

            if (!open) void refresh();
            else freshAttempt.current = null;
          }}
        >
          {t(open ? 'hide' : 'inspect')}
        </Button>
        {open && (
          <div id="coexistence-signup-recovery" className="space-y-4">
            <p className="text-muted-foreground text-sm">{t('policy')}</p>
            <div role="status" className="space-y-2 text-sm">
              {busy && <p>{t('loading')}</p>}
              {failed && <p>{t('failed')}</p>}
              {snapshot && !attempt && <p>{t('empty')}</p>}
              {attempt && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt>{t('state')}</dt>
                  <dd>{t(`states.${attempt.state}`)}</dd>
                  <dt>{t('launchedAt')}</dt>
                  <dd>
                    {attempt.launched_at ? (
                      <time dateTime={attempt.launched_at}>
                        {attempt.launched_at}
                      </time>
                    ) : (
                      t('notRecorded')
                    )}
                  </dd>
                  <dt>{t('exchangeStarted')}</dt>
                  <dd>
                    {t(attempt.exchange_started ? 'recorded' : 'notRecorded')}
                  </dd>
                  <dt>{t('knownClaims')}</dt>
                  <dd>{attempt.known_claims}</dd>
                  {attempt.disposition && attempt.reviewed_at && (
                    <>
                      <dt>{t('disposition')}</dt>
                      <dd>{t(`dispositions.${attempt.disposition}`)}</dd>
                      <dt>{t('reviewedAt')}</dt>
                      <dd>
                        <time dateTime={attempt.reviewed_at}>
                          {attempt.reviewed_at}
                        </time>
                      </dd>
                    </>
                  )}
                </dl>
              )}
              {resubmitting && <p>{t('unknownAcceptance')}</p>}
            </div>
            {action === 'close_unstarted' && (
              <p className="text-sm">{t('closeExplanation')}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => refresh()}
              >
                {t('refresh')}
              </Button>
              {action && attempt && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (request.current || freshAttempt.current !== attempt)
                      return;

                    return refresh(
                      pending.current ?? {
                        action,
                        attempt_id: attempt.id,
                        request_id: crypto.randomUUID(),
                      }
                    );
                  }}
                >
                  {t(resubmitting ? 'resubmit' : `actions.${action}`)}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
