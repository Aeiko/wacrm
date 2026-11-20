import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { downloadMediaMessage } from './download';

const privateMessage: Message = {
  id: '12345678-1234-4234-8234-123456789abc',
  conversation_id: 'conversation',
  sender_type: 'customer',
  content_type: 'document',
  media_url:
    '/api/whatsapp/coexistence/media/12345678-1234-4234-8234-123456789abc',
  status: 'delivered',
  created_at: '2026-08-04T14:15:30.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('downloadMediaMessage', () => {
  it('never opens a private endpoint in a new tab after a network failure', async () => {
    const createElement = vi.fn();
    vi.stubGlobal('document', { createElement });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    );

    await expect(downloadMediaMessage(privateMessage)).rejects.toThrow(
      'Failed to fetch'
    );
    expect(createElement).not.toHaveBeenCalled();
  });

  it('preserves the public URL new-tab fallback for CORS failures', async () => {
    const anchor = {
      href: '',
      target: '',
      rel: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    };

    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    );
    const publicUrl = 'https://storage.test/report.pdf';

    await downloadMediaMessage({ ...privateMessage, media_url: publicUrl });
    expect(anchor.href).toBe(publicUrl);
    expect(anchor.target).toBe('_blank');
    expect(anchor.click).toHaveBeenCalledOnce();
  });
});
