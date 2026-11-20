'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  historyRequestStatusSchema,
  type HistoryRequestStatus,
} from '@/lib/whatsapp/coexistence/history-request-contract';
import { HistoryRequestForm } from './coexistence-history-request-form';

const route = '/history-request';

type View =
  | (HistoryRequestStatus & { revision: number })
  | {
      state:
        | 'closed'
        | 'inspecting'
        | 'submitting'
        | 'failed'
        | 'denied'
        | 'stale'
        | 'uncertain';
    };

type PermissionsChange = { revision: number; saving: boolean };

export function CoexistenceHistoryRequestPanel({
  permissions,
}: {
  permissions: PermissionsChange;
}) {
  const {
    user,
    accountId,
    accountRole,
    accountStatus,
    profile,
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
    profile?.account_id !== accountId ||
    profile.account_role !== 'owner'
  )
    return null;

  return (
    <HistoryRequestPanel
      key={`${user.id}:${accountId}`}
      permissions={permissions}
    />
  );
}

function HistoryRequestPanel({
  permissions,
}: {
  permissions: PermissionsChange;
}) {
  const t = useTranslations('Settings.whatsapp.historyRequest');
  const [view, setView] = useState<View>({ state: 'closed' });
  const inFlight = useRef<AbortController | null>(null);
  const submitted = useRef(false);

  const state =
    view.state === 'ready' && view.revision !== permissions.revision
      ? 'stale'
      : view.state;

  const review =
    view.state === 'ready' && state === 'ready' && !permissions.saving
      ? view.review
      : null;

  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    if (!review) return;

    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.parse(review.deadline_at);

    function expire() {
      const remaining = deadline - Date.now();

      if (remaining > 0)
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      else
        setView((current) =>
          current.state === 'ready' && current.review === review
            ? { state: 'stale' }
            : current
        );
    }

    timer = setTimeout(expire, 0);

    return () => clearTimeout(timer);
  }, [review]);

  async function run(body?: URLSearchParams) {
    if (permissions.saving || inFlight.current) return;

    const controller = new AbortController();
    inFlight.current = controller;

    if (body) submitted.current = true;
    setView({ state: body ? 'submitting' : 'inspecting' });

    const options: RequestInit = {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    };

    try {
      let response = await fetch(
        route,
        body
          ? { ...options, method: 'POST', body, redirect: 'manual' }
          : options
      );

      if (controller.signal.aborted) return;

      const acknowledged = Boolean(body && response.type === 'opaqueredirect');

      // Read the fixed result without following a redirect that could replay the POST.
      if (acknowledged) response = await fetch(route, options);

      if (controller.signal.aborted) return;

      if (response.status === 401 || response.status === 403) {
        setView({
          state:
            submitted.current && (!body || acknowledged)
              ? 'uncertain'
              : 'denied',
        });
      } else if (response.status === 409 && body && !acknowledged) {
        submitted.current = false;
        setView({ state: 'stale' });
      } else if (!response.ok || (body && !acknowledged)) {
        throw new Error('History request response unavailable');
      } else {
        const status = historyRequestStatusSchema.parse(await response.json());

        if (controller.signal.aborted) return;

        if (
          submitted.current &&
          (status.state === 'ready' || status.state === 'unavailable')
        ) {
          setView({ state: 'uncertain' });
        } else if (
          status.state === 'ready' &&
          Date.parse(status.review.deadline_at) <= Date.now()
        ) {
          setView({ state: 'stale' });
        } else {
          setView({ ...status, revision: permissions.revision });
        }
      }
    } catch {
      if (!controller.signal.aborted)
        setView({ state: submitted.current ? 'uncertain' : 'failed' });
    } finally {
      inFlight.current = null;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      !review ||
      submitted.current ||
      new FormData(event.currentTarget).get('confirmation') !== 'history-now-v1'
    )
      return;

    if (Date.parse(review.deadline_at) <= Date.now()) {
      setView({ state: 'stale' });

      return;
    }

    return run(
      new URLSearchParams({
        context: review.context,
        decision_id: review.decision_id,
        request_id: review.request_id,
        confirmation: 'history-now-v1',
      })
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="status" className="text-sm">
          {state !== 'closed' && <p>{t(`states.${state}`)}</p>}
        </div>
        {review && (
          <HistoryRequestForm role="owner" review={review} onSubmit={submit} />
        )}
        <Button
          type="button"
          variant="outline"
          disabled={
            permissions.saving ||
            state === 'inspecting' ||
            state === 'submitting'
          }
          onClick={() => run()}
        >
          {t(state === 'closed' ? 'inspect' : 'inspectAgain')}
        </Button>
      </CardContent>
    </Card>
  );
}
