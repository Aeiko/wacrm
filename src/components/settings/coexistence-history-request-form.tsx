import type { FormEventHandler } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import {
  historyRequestReviewSchema,
  type HistoryRequestReview,
} from '@/lib/whatsapp/coexistence/history-request-contract';

// The server owns eligibility and deadline enforcement.
export function HistoryRequestForm({
  role,
  review,
  onSubmit,
}: {
  role: 'owner' | 'admin' | 'member';
  review: HistoryRequestReview | null;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  if (role !== 'owner') return null;

  const parsed = historyRequestReviewSchema.safeParse(review);

  if (!parsed.success) return null;

  return <ReviewedHistoryRequest review={parsed.data} onSubmit={onSubmit} />;
}

function ReviewedHistoryRequest({
  review,
  onSubmit,
}: {
  review: HistoryRequestReview;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  const t = useTranslations('Settings.whatsapp.historyRequest');
  const format = useFormatter();

  return (
    <details>
      <summary>{t('review')}</summary>
      <p>{t('target', { suffix: review.phone_id_suffix })}</p>
      <p>
        {t('deadline')}{' '}
        <time dateTime={review.deadline_at}>
          {format.dateTime(new Date(review.deadline_at), {
            dateStyle: 'medium',
            timeStyle: 'long',
            timeZone: 'UTC',
          })}
        </time>
      </p>
      <p>{t('scope')}</p>
      <p>{t('outcome')}</p>
      <form
        action="/history-request"
        method="post"
        autoComplete="off"
        onSubmit={onSubmit}
      >
        <input type="hidden" name="context" value={review.context} />
        <input type="hidden" name="decision_id" value={review.decision_id} />
        <input type="hidden" name="request_id" value={review.request_id} />
        <label>
          <input
            type="checkbox"
            name="confirmation"
            value="history-now-v1"
            required
          />{' '}
          {t('confirmation')}
        </label>
        <button type="submit">{t('submit')}</button>
      </form>
    </details>
  );
}
