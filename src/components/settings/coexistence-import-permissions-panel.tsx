'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useAuth } from '@/hooks/use-auth';
import {
  importSettingsReceiptSchema,
  importSettingsRequestSchema,
  importSettingsStatusSchema,
  type ImportSettingsReceipt,
  type ImportSettingsRequest,
  type ImportSettingsStatus,
} from '@/lib/whatsapp/coexistence/import-settings-contract';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const route = '/api/whatsapp/coexistence/import-permissions';
const emptyChoices = { history: false, contacts: false };

type View =
  | { kind: 'closed' | 'loading' | 'failed' | 'denied' | 'stale' }
  | { kind: 'inspected'; connection: ImportSettingsStatus['connection'] }
  | { kind: 'recorded'; receipt: ImportSettingsReceipt }
  | { kind: 'uncertain'; intent: ImportSettingsRequest };

type Props = {
  historyOnly?: boolean;
  onSavingChange?: (saving: boolean) => void;
};

export function CoexistenceImportPermissionsPanel({
  onSavingChange,
  historyOnly,
}: Props = {}) {
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
    <ImportPermissions
      key={`${user.id}:${accountId}`}
      onSavingChange={onSavingChange}
      historyOnly={historyOnly}
    />
  );
}

function ImportPermissions({ onSavingChange, historyOnly }: Props) {
  const t = useTranslations('Settings.whatsapp.importPermissions');
  const format = useFormatter();
  const [view, setView] = useState<View>({ kind: 'closed' });
  const [draft, setDraft] = useState(emptyChoices);
  const [confirmWithdrawal, setConfirmWithdrawal] = useState(false);
  const [expiredContext, setExpiredContext] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const connection = view.kind === 'inspected' ? view.connection : null;

  const locallyExpired =
    connection !== null && connection.context === expiredContext;

  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    if (connection?.state !== 'effective' || !connection.expires_at) return;

    const expiresAt = Date.parse(connection.expires_at);
    let timer: ReturnType<typeof setTimeout>;

    function checkExpiry() {
      const remaining = expiresAt - Date.now();

      if (remaining > 0) {
        timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      } else if (connection) {
        setExpiredContext(connection.context);
      }
    }

    timer = setTimeout(checkExpiry, 0);

    return () => clearTimeout(timer);
  }, [connection]);

  async function run(intent?: ImportSettingsRequest) {
    if (inFlight.current) return;

    const controller = new AbortController();
    inFlight.current = controller;

    if (intent) onSavingChange?.(true);
    setView({ kind: 'loading' });
    setDraft(emptyChoices);
    setConfirmWithdrawal(false);
    setExpiredContext(null);

    try {
      const response = await fetch(
        historyOnly ? '/history-permissions' : route,
        {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
          ...(intent && {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(intent),
          }),
        }
      );

      if (controller.signal.aborted) return;

      if (response.status === 401 || response.status === 403) {
        setView({ kind: 'denied' });
      } else if (response.status === 409) {
        setView({ kind: 'stale' });
      } else if (!response.ok) {
        throw new Error('Import permissions response unavailable');
      } else if (intent) {
        const receipt = importSettingsReceiptSchema.parse(
          await response.json()
        );

        if (
          receipt.request_id !== intent.request_id ||
          receipt.history !== intent.history ||
          receipt.contacts !== intent.contacts
        )
          throw new Error('Mismatched import permissions receipt');

        if (!controller.signal.aborted) setView({ kind: 'recorded', receipt });
      } else {
        const { connection: inspected } = importSettingsStatusSchema.parse(
          await response.json()
        );

        if (controller.signal.aborted) return;

        if (inspected?.state === 'effective' && inspected.expires_at) {
          if (Date.parse(inspected.expires_at) > Date.now()) {
            setDraft({
              history: inspected.history,
              contacts: !historyOnly && inspected.contacts,
            });
          } else {
            setExpiredContext(inspected.context);
          }
        }

        setView({ kind: 'inspected', connection: inspected });
      }
    } catch {
      if (!controller.signal.aborted) {
        setView(intent ? { kind: 'uncertain', intent } : { kind: 'failed' });
      }
    } finally {
      inFlight.current = null;

      if (intent) onSavingChange?.(false);
    }
  }

  function save(withdraw: boolean) {
    if (!connection) return;

    if (withdraw) {
      if (!connection.can_withdraw || !confirmWithdrawal) return;
    } else if (
      !connection.can_grant ||
      locallyExpired ||
      (connection.state === 'effective' &&
        connection.expires_at !== null &&
        Date.parse(connection.expires_at) <= Date.now()) ||
      (!draft.history && !draft.contacts)
    ) {
      return;
    }

    return run(
      importSettingsRequestSchema.parse({
        context: connection.context,
        request_id: crypto.randomUUID(),
        previous_request_id: connection.previous_request_id,
        ...(withdraw ? emptyChoices : draft),
        version: 'projection-v1',
      })
    );
  }

  function expiry(at: string) {
    return (
      <p>
        {t('expires')}{' '}
        <time dateTime={at}>
          {format.dateTime(new Date(at), {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </time>
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.kind === 'closed' ? (
          <Button variant="outline" onClick={() => run()}>
            {t('inspect')}
          </Button>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">{t('limits')}</p>
            <div role="status" className="space-y-2 text-sm">
              {view.kind === 'loading' && <p>{t('loading')}</p>}
              {view.kind === 'failed' && <p>{t('failed')}</p>}
              {view.kind === 'denied' && <p>{t('denied')}</p>}
              {view.kind === 'stale' && <p>{t('stale')}</p>}
              {view.kind === 'uncertain' && <p>{t('uncertain')}</p>}
              {view.kind === 'recorded' && (
                <>
                  <p>
                    {t(
                      view.receipt.history || view.receipt.contacts
                        ? 'recorded'
                        : 'withdrawalRecorded'
                    )}
                  </p>
                  {(view.receipt.history || view.receipt.contacts) &&
                    expiry(view.receipt.expires_at)}
                </>
              )}
              {view.kind === 'inspected' && !connection && <p>{t('empty')}</p>}
              {connection && (
                <>
                  <p>
                    {t('phoneIdSuffix', { suffix: connection.phone_id_suffix })}
                  </p>
                  <p>
                    {t(
                      locallyExpired
                        ? 'states.inactive'
                        : `states.${connection.state}`
                    )}
                  </p>
                  <p>
                    {t(
                      connection.history ? 'savedHistoryOn' : 'savedHistoryOff'
                    )}
                  </p>
                  <p>
                    {t(
                      connection.contacts
                        ? 'savedContactsOn'
                        : 'savedContactsOff'
                    )}
                  </p>
                  {connection.expires_at &&
                    connection.state !== 'withdrawn' &&
                    expiry(connection.expires_at)}
                  {!connection.can_grant && <p>{t('grantUnavailable')}</p>}
                  {locallyExpired && <p>{t('expired')}</p>}
                </>
              )}
            </div>
            {connection && (
              <>
                <fieldset
                  disabled={
                    !connection.can_grant || locallyExpired || confirmWithdrawal
                  }
                  className="space-y-2"
                >
                  <legend className="mb-2 text-sm font-medium">
                    {t('choices')}
                  </legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!locallyExpired && draft.history}
                      onChange={(event) =>
                        setDraft({ ...draft, history: event.target.checked })
                      }
                    />
                    {t('history')}
                  </label>
                  {!historyOnly && (
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={!locallyExpired && draft.contacts}
                        onChange={(event) =>
                          setDraft({ ...draft, contacts: event.target.checked })
                        }
                      />
                      {t('contacts')}
                    </label>
                  )}
                  <Button
                    type="button"
                    disabled={!draft.history && !draft.contacts}
                    onClick={() => save(false)}
                  >
                    {t('save')}
                  </Button>
                </fieldset>
                {connection.can_withdraw &&
                  (confirmWithdrawal ? (
                    <div className="space-y-2">
                      <p className="text-sm">{t('confirmText')}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="destructive"
                          onClick={() => save(true)}
                        >
                          {t('confirmWithdrawal')}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setConfirmWithdrawal(false)}
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => setConfirmWithdrawal(true)}
                    >
                      {t('withdraw')}
                    </Button>
                  ))}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={view.kind === 'loading'}
                onClick={() => run()}
              >
                {t('refresh')}
              </Button>
              {view.kind === 'uncertain' && (
                <Button variant="outline" onClick={() => run(view.intent)}>
                  {t('retry')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
