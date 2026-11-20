'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  operatorInventorySchema,
  operatorKindSchema,
  operatorQueuedSchema,
  type OperatorCursor,
  type OperatorInventory,
  type OperatorKind,
} from '@/lib/whatsapp/coexistence/operator-contract';
import { useAuth } from '@/hooks/use-auth';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';

const kinds = operatorKindSchema.options;

const reasonLabels = new Map([
  ['decode_failed', 'invalidPayload'],
  ['unsupported_payload', 'invalidPayload'],
  ['worker_failed', 'processingFailed'],
  ['commit_failed', 'processingFailed'],
  ['processing_failed', 'processingFailed'],
  ['hydration_parent_missing', 'invalidPayload'],
  ['binding_changed', 'bindingChanged'],
  ['import_consent_required', 'importConsentRequired'],
  ['binding_paused', 'bindingChanged'],
  ['identity_changed', 'bindingChanged'],
  ['lifecycle_target_unknown', 'bindingChanged'],
  ['retry_expired', 'expired'],
  ['retention_expired', 'expired'],
  ['event_expired', 'expired'],
  ['inbound_expired', 'expired'],
  ['lease_expired', 'uncertain'],
  ['execution_uncertain', 'uncertain'],
  ['inbound_future', 'invalidPayload'],
  ['identity_missing', 'invalidPayload'],
  ['identity_conflict', 'invalidPayload'],
  ['message_identity_conflict', 'invalidPayload'],
  ['invalid_hydration', 'invalidPayload'],
  ['invalid_contact_action', 'invalidPayload'],
  ['invalid_message', 'invalidPayload'],
  ['invalid_timestamp', 'invalidPayload'],
  ['direction_conflict', 'invalidPayload'],
  ['unsupported_operation', 'invalidPayload'],
  ['invalid_live_message', 'invalidPayload'],
  ['invalid_update', 'invalidPayload'],
  ['invalid_update_identity', 'invalidPayload'],
  ['invalid_message_status', 'invalidPayload'],
  ['invalid_provider_status', 'invalidPayload'],
  ['invalid_error_code', 'invalidPayload'],
  ['invalid_reaction', 'invalidPayload'],
  ['unsupported_update', 'invalidPayload'],
  ['update_identity_conflict', 'invalidPayload'],
  ['message_origin_conflict', 'invalidPayload'],
]);

export function CoexistenceOperatorPanel() {
  const { user, accountId } = useAuth();

  return <OperatorAccountPanel key={`${user?.id ?? ''}:${accountId ?? ''}`} />;
}

function OperatorAccountPanel() {
  const t = useTranslations('Settings.whatsapp');

  const {
    user,
    accountId,
    loading: authLoading,
    profileLoading,
    canEditSettings,
  } = useAuth();

  const allowed =
    !authLoading &&
    !profileLoading &&
    Boolean(user && accountId) &&
    canEditSettings;

  const [query, setQuery] = useState<{
    kind: OperatorKind;
    cursor: OperatorCursor | null;
  }>({ kind: 'jobs', cursor: null });

  const [page, setPage] = useState<OperatorInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  const retryRequest = useRef<AbortController | null>(null);

  const intents = useRef(
    new Map<string, { requestId: string; queued: boolean }>()
  );

  const retryBusy = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);

  const [notice, setNotice] = useState<
    'queued' | 'unknownAcceptance' | 'staleEligibility' | null
  >(null);

  useEffect(
    () => () => {
      retryRequest.current?.abort();
    },
    []
  );

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    active.current = controller;
    const params = new URLSearchParams({ kind: query.kind, limit: '25' });

    if (query.cursor) {
      params.set('before_created_at', query.cursor.created_at);
      params.set('before_id', query.cursor.id);
    }

    fetch(`/api/whatsapp/coexistence/operator?${params}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Operator view unavailable');
        const data = operatorInventorySchema.parse(await response.json());

        if (data.items.length > 25)
          throw new Error('Operator page exceeded limit');

        if (!controller.signal.aborted) setPage(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [allowed, query]);

  function load(kind: OperatorKind, cursor: OperatorCursor | null = null) {
    active.current?.abort();
    setPage(null);
    setFailed(false);
    setLoading(true);
    setQuery({ kind, cursor });
  }

  async function retry() {
    if (
      !allowed ||
      !selected ||
      retryBusy.current ||
      !page?.enabled ||
      query.kind !== 'jobs'
    )
      return;
    const row = page.items.find((item) => item.id === selected);

    if (
      !row ||
      row.state !== 'quarantined' ||
      !row.retry_eligible ||
      !row.current_binding ||
      row.operator_requested_at
    )
      return;
    let intent = intents.current.get(selected);

    if (intent?.queued) return;

    if (!intent) {
      intent = { requestId: crypto.randomUUID(), queued: false };
      intents.current.set(selected, intent);
    }

    retryBusy.current = true;
    setRetrying(true);
    setNotice(null);
    const controller = new AbortController();
    retryRequest.current = controller;

    try {
      const response = await fetch(
        `/api/whatsapp/coexistence/operator/jobs/${selected}/retry`,
        {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: intent.requestId }),
          signal: controller.signal,
        }
      );

      if (controller.signal.aborted) return;

      if (response.status === 409) {
        setSelected(null);
        setNotice('staleEligibility');
        load('jobs');

        return;
      }

      if (response.status !== 202) throw new Error('Retry acceptance unknown');
      operatorQueuedSchema.parse(await response.json());

      if (controller.signal.aborted) return;
      intent.queued = true;
      setQueuedIds((ids) => [...ids, selected]);
      setNotice('queued');
      setSelected(null);
      load('jobs');
    } catch {
      if (!controller.signal.aborted) setNotice('unknownAcceptance');
    } finally {
      retryBusy.current = false;

      if (!controller.signal.aborted) setRetrying(false);
    }
  }

  return (
    <section className="space-y-6">
      <SettingsPanelHead
        title={t('title')}
        description={t('operator.description')}
      />
      {!allowed ? (
        <Alert>
          <AlertDescription>{t('operator.managedReadOnly')}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('operator.title')}</CardTitle>
            <CardDescription>{t('operator.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="coexistence-queue">{t('operator.queue')}</label>
              <select
                id="coexistence-queue"
                value={query.kind}
                disabled={loading || retrying}
                onChange={(event) => {
                  const kind = kinds.find(
                    (value) => value === event.target.value
                  );

                  if (kind) load(kind);
                }}
                className="border-input bg-background rounded-md border p-2 text-sm"
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`operator.kinds.${kind}`)}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                disabled={loading || retrying}
                onClick={() => load(query.kind)}
              >
                {t('operator.refresh')}
              </Button>
            </div>
            {notice && (
              <Alert role="status">
                <AlertDescription>{t(`operator.${notice}`)}</AlertDescription>
              </Alert>
            )}
            {loading && <p role="status">{t('operator.loading')}</p>}
            {failed && (
              <Alert role="alert">
                <AlertDescription>{t('operator.loadFailed')}</AlertDescription>
              </Alert>
            )}
            {page && (
              <>
                {!page.enabled && (
                  <Alert>
                    <AlertDescription>
                      {t('operator.disabled')}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {t(
                      page.connection.managed
                        ? 'operator.managed'
                        : 'operator.unmanaged'
                    )}
                  </Badge>
                  <Badge variant="outline">
                    {t(
                      page.connection.connected
                        ? 'operator.connected'
                        : 'operator.disconnected'
                    )}
                  </Badge>
                  <Badge variant="outline">
                    {t(
                      page.connection.verified
                        ? 'operator.verified'
                        : 'operator.unverified'
                    )}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-sm">
                  {t('operator.observedAt')}:{' '}
                  <time dateTime={page.observed_at}>{page.observed_at}</time>
                </p>
                <p>
                  {t('operator.count')}: {page.count}
                  {page.count_capped ? '+' : ''}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('operator.id')}</TableHead>
                      <TableHead>{t('operator.state')}</TableHead>
                      <TableHead>{t('operator.createdAt')}</TableHead>
                      <TableHead>{t('operator.reason')}</TableHead>
                      <TableHead>{t('operator.action')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.items.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-xs">
                          {row.id}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {t(`operator.states.${row.state}`)}
                          </Badge>
                          {row.overdue && <p>{t('operator.overdue')}</p>}
                          {!row.current_binding && (
                            <p>{t('operator.oldBinding')}</p>
                          )}
                          {row.state === 'ambiguous' && (
                            <p>{t('operator.uncertain')}</p>
                          )}
                        </TableCell>
                        <TableCell>
                          <time dateTime={row.created_at}>
                            {row.created_at}
                          </time>
                        </TableCell>
                        <TableCell>
                          {t(
                            `operator.reasons.${reasonLabels.get(row.reason ?? '') ?? 'unknown'}`
                          )}
                        </TableCell>
                        <TableCell>
                          {page.enabled &&
                            query.kind === 'jobs' &&
                            row.state === 'quarantined' &&
                            row.current_binding &&
                            row.retry_eligible &&
                            !row.operator_requested_at &&
                            !queuedIds.includes(row.id) && (
                              <Button
                                variant="outline"
                                disabled={retrying}
                                onClick={() => {
                                  setSelected(row.id);
                                  setNotice(null);
                                }}
                              >
                                {t('operator.retry')}
                              </Button>
                            )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {page.items.length === 0 && <p>{t('operator.empty')}</p>}
                <Button
                  variant="outline"
                  disabled={!page.next_cursor || loading || retrying}
                  onClick={() => load(query.kind, page.next_cursor)}
                >
                  {t('operator.next')}
                </Button>
              </>
            )}
            {selected && (
              <Dialog
                open
                onOpenChange={(open) => {
                  if (!open && !retryBusy.current) setSelected(null);
                }}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t('operator.confirmTitle')}</DialogTitle>
                    <DialogDescription>
                      {t('operator.confirmDescription')}
                    </DialogDescription>
                  </DialogHeader>
                  <p className="font-mono text-xs">{selected}</p>
                  {notice === 'unknownAcceptance' && (
                    <Alert role="alert">
                      <AlertDescription>
                        {t('operator.unknownAcceptance')}
                      </AlertDescription>
                    </Alert>
                  )}
                  <DialogFooter>
                    <Button
                      variant="ghost"
                      disabled={retrying}
                      onClick={() => setSelected(null)}
                    >
                      {t('operator.cancel')}
                    </Button>
                    <Button disabled={retrying} onClick={retry}>
                      {t(retrying ? 'operator.retrying' : 'operator.confirm')}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
