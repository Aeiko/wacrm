import { describe, expect, it } from 'vitest';
import { normalizeDelivery } from './normalize';
import { deliverySchema, type JsonValue } from './payload';

const metadata = {
  display_phone_number: '+1 555 000 1234',
  phone_number_id: '1234',
};

function delivery(field: string, value: Record<string, JsonValue>) {
  return deliverySchema.parse({
    waba_id: '5678',
    field,
    value: { metadata, ...value },
  });
}

const liveMessage = {
  id: 'wamid.live',
  from: '15550005678',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'Live customer' },
};

const liveStatus = {
  id: 'wamid.outbound',
  status: 'read',
  timestamp: '1700000000',
  recipient_id: liveMessage.from,
};

const liveReaction = {
  ...liveMessage,
  id: 'wamid.reaction',
  type: 'reaction',
  reaction: { message_id: 'wamid.target', emoji: '👍' },
};

describe('live inbound normalization', () => {
  it.each(['sent', 'delivered', 'read', 'played', 'failed'])(
    'normalizes %s without creating a sending or live-message operation',
    (status) => {
      expect(
        normalizeDelivery(
          delivery('messages', {
            statuses: [
              {
                ...liveStatus,
                status,
                conversation: { id: 'conversation' },
                pricing: { billable: true },
              },
            ],
          })
        )
      ).toEqual([
        {
          kind: 'message_status',
          wamid: 'wamid.outbound',
          occurred_at: '2023-11-14T22:13:20.000Z',
          status: status === 'played' ? 'read' : status,
          provider_status: status,
          identity: {
            phone: liveMessage.from,
            wa_user_id: null,
            wa_parent_user_id: null,
            wa_username: null,
            name: null,
          },
          error_code: null,
          error_title: null,
          error_details: null,
        },
      ]);
    }
  );
  it.each(['👍', '', undefined])(
    'normalizes reaction emoji %j separately from live messages',
    (emoji) => {
      expect(
        normalizeDelivery(
          delivery('messages', {
            messages: [
              {
                ...liveReaction,
                reaction:
                  emoji === undefined
                    ? { message_id: 'wamid.target' }
                    : { message_id: 'wamid.target', emoji },
              },
            ],
            contacts: [
              { wa_id: '15550009999', profile: { name: 'Wrong' } },
              {
                wa_id: liveMessage.from,
                user_id: 'US.12345678',
                profile: { name: 'Customer' },
              },
            ],
          })
        )
      ).toEqual([
        {
          kind: 'reaction',
          wamid: 'wamid.reaction',
          target_wamid: 'wamid.target',
          emoji: emoji ?? '',
          occurred_at: '2023-11-14T22:13:20.000Z',
          identity: {
            phone: liveMessage.from,
            wa_user_id: 'US.12345678',
            wa_parent_user_id: null,
            wa_username: null,
            name: 'Customer',
          },
        },
      ]);
    }
  );

  it('accepts messages, statuses and reactions together without merging operation kinds', () => {
    expect(
      normalizeDelivery(
        delivery('messages', {
          messages: [liveMessage, liveReaction],
          statuses: [liveStatus],
        })
      ).map((operation) => operation.kind)
    ).toEqual(['message_status', 'live_message', 'reaction']);
  });

  it('preserves bounded failure details and strips ordinary Meta enrichment', () => {
    expect(
      normalizeDelivery(
        delivery('messages', {
          statuses: [
            {
              ...liveStatus,
              status: 'failed',
              errors: [
                {
                  code: 131049,
                  title: 'Not delivered',
                  message: 'Not delivered',
                  href: '/errors',
                  error_data: { details: 'Delivery failed', extra: true },
                },
              ],
            },
          ],
        })
      )
    ).toMatchObject([
      {
        kind: 'message_status',
        error_code: 131049,
        error_title: 'Not delivered',
        error_details: 'Delivery failed',
      },
    ]);
  });

  it('accepts verified BSUID-only recipients and matched profile enrichment', () => {
    expect(
      normalizeDelivery(
        delivery('messages', {
          statuses: [
            {
              id: 'wamid.bsuid',
              status: 'delivered',
              timestamp: '1700000000',
              recipient_user_id: 'US.12345678',
              recipient_parent_user_id: 'US.ENT.87654321',
            },
          ],
          contacts: [
            { wa_id: '15550009999' },
            {
              user_id: 'US.12345678',
              profile: { name: 'Customer', username: 'customer' },
            },
          ],
        })
      )
    ).toMatchObject([
      {
        kind: 'message_status',
        identity: {
          phone: '',
          wa_user_id: 'US.12345678',
          wa_parent_user_id: 'US.ENT.87654321',
          wa_username: 'customer',
          name: 'Customer',
        },
      },
    ]);
  });

  it.each<Record<string, JsonValue>>([
    {},
    { statuses: [] },
    { messages: [], statuses: [liveStatus] },
    { statuses: [{ ...liveStatus, status: 'future_status' }] },
    { statuses: [{ ...liveStatus, timestamp: '1700000000junk' }] },
    { statuses: [{ ...liveStatus, timestamp: '-1' }] },
    { statuses: [{ ...liveStatus, recipient_id: 'bad' }] },
    {
      statuses: [
        { ...liveStatus, recipient_id: metadata.display_phone_number },
      ],
    },
    {
      statuses: [{ id: 'wamid.none', status: 'sent', timestamp: '1700000000' }],
    },
    { statuses: [{ ...liveStatus, recipient_type: 'group' }] },
    { statuses: [{ ...liveStatus, recipient_user_id: 'bad' }] },
    {
      statuses: [{ ...liveStatus, recipient_user_id: 'US.11111111' }],
      contacts: [{ wa_id: liveMessage.from, user_id: 'US.22222222' }],
    },
    {
      statuses: [{ ...liveStatus, recipient_user_id: 'US.11111111' }],
      contacts: [{ wa_id: '15550009999', user_id: 'US.11111111' }],
    },
    {
      statuses: [
        {
          ...liveStatus,
          recipient_user_id: 'US.11111111',
          recipient_parent_user_id: 'US.22222222',
        },
      ],
      contacts: [{ user_id: 'US.11111111', parent_user_id: 'US.33333333' }],
    },
    { statuses: [{ ...liveStatus, errors: [{ code: 1.5 }] }] },
    {
      statuses: [
        { ...liveStatus, errors: [{ code: 1, title: 'x'.repeat(1025) }] },
      ],
    },
    {
      statuses: [
        {
          ...liveStatus,
          errors: [{ code: 1, error_data: { details: 'x'.repeat(65537) } }],
        },
      ],
    },
    {
      messages: [liveReaction],
      statuses: [{ ...liveStatus, status: 'unknown' }],
    },
    {
      messages: [liveMessage, { ...liveReaction, reaction: { emoji: '👍' } }],
      statuses: [liveStatus],
    },
    {
      messages: [{ ...liveReaction, reaction: { message_id: '', emoji: '' } }],
    },
    {
      messages: [
        {
          ...liveReaction,
          reaction: { message_id: 'x'.repeat(513), emoji: '' },
        },
      ],
    },
    {
      messages: [
        {
          ...liveReaction,
          reaction: { message_id: 'wamid.target', emoji: 'x'.repeat(65) },
        },
      ],
    },
    {
      messages: [
        {
          ...liveReaction,
          reaction: { message_id: 'wamid.target', emoji: null },
        },
      ],
    },
    { messages: [{ ...liveReaction, timestamp: '1.5' }] },
    { messages: [{ ...liveReaction, from: metadata.display_phone_number }] },
    { messages: [{ ...liveReaction, to: '15550009999' }] },
    { messages: [{ ...liveReaction, to_user_id: 'US.11111111' }] },
    {
      messages: [{ ...liveReaction, from_user_id: 'US.11111111' }],
      contacts: [{ wa_id: liveMessage.from, user_id: 'US.22222222' }],
    },
    {
      messages: [{ ...liveReaction, from_user_id: 'US.11111111' }],
      contacts: [
        { wa_id: metadata.display_phone_number, user_id: 'US.11111111' },
      ],
    },
    { messages: [liveMessage], statuses: [liveStatus], unknown: true },
    {
      messages: Array.from({ length: 5000 }, () => liveMessage),
      statuses: [liveStatus],
    },
    { statuses: Array.from({ length: 5001 }, () => liveStatus) },
  ])(
    'quarantines mixed updates atomically when any member is unsupported %#',
    (value) => {
      expect(normalizeDelivery(delivery('messages', value))).toEqual([
        { kind: 'quarantine', code: 'unsupported_payload' },
      ]);
    }
  );

  it('accepts the combined 5000-item boundary', () => {
    expect(
      normalizeDelivery(
        delivery('messages', {
          messages: [liveReaction],
          statuses: Array.from({ length: 4999 }, () => liveStatus),
        })
      )
    ).toHaveLength(5000);
  });

  it.each(['smb_message_echoes', 'history'])(
    'does not promote %s reactions to live events',
    (field) => {
      const value: Record<string, JsonValue> =
        field === 'history'
          ? {
              history: [
                {
                  threads: [{ id: liveMessage.from, messages: [liveReaction] }],
                },
              ],
            }
          : {
              message_echoes: [
                { ...liveReaction, from: '15550001234', to: liveMessage.from },
              ],
            };

      expect(normalizeDelivery(delivery(field, value))).toEqual([
        { kind: 'quarantine', code: 'unsupported_message_content_or_status' },
      ]);
    }
  );

  it('matches contacts by identifier, never array position, and preserves reply identity', () => {
    expect(
      normalizeDelivery(
        delivery('messages', {
          messaging_product: 'whatsapp',
          contacts: [
            { wa_id: '15550009999', profile: { name: 'Wrong' } },
            {
              wa_id: liveMessage.from,
              user_id: 'US.12345678',
              profile: { name: 'Customer' },
            },
          ],
          messages: [{ ...liveMessage, context: { id: 'wamid.reply' } }],
        })
      )
    ).toMatchObject([
      {
        kind: 'live_message',
        source: 'cloud_api',
        sender_type: 'customer',
        status: 'delivered',
        wamid: 'wamid.live',
        interactive_reply_id: null,
        reply_wamid: 'wamid.reply',
        occurred_at: '2023-11-14T22:13:20.000Z',
        identity: {
          phone: liveMessage.from,
          wa_user_id: 'US.12345678',
          name: 'Customer',
        },
      },
    ]);
  });

  it('accepts a BSUID-only sender without borrowing an unrelated phone', () => {
    expect(
      normalizeDelivery(
        delivery('messages', {
          contacts: [{ wa_id: '15550009999' }],
          messages: [
            {
              id: liveMessage.id,
              timestamp: liveMessage.timestamp,
              type: 'text',
              text: liveMessage.text,
              from_user_id: 'US.12345678',
            },
          ],
        })
      )
    ).toMatchObject([
      {
        kind: 'live_message',
        identity: { phone: '', wa_user_id: 'US.12345678' },
      },
    ]);
  });

  it.each<Record<string, JsonValue>>([
    {
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'yes', title: 'Yes' },
      },
    },
    {
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: 'yes', title: 'Yes' },
      },
    },
    { type: 'button', button: { payload: 'yes', text: 'Yes' } },
  ])('retains interactive reply IDs: $type', (reply) => {
    expect(
      normalizeDelivery(
        delivery('messages', { messages: [{ ...liveMessage, ...reply }] })
      )
    ).toMatchObject([
      {
        kind: 'live_message',
        content_type: 'interactive',
        content_text: 'Yes',
        interactive_reply_id: 'yes',
      },
    ]);
  });

  it.each<Record<string, JsonValue>>([
    {
      type: 'text',
      text: { body: 'Live customer' },
      content_type: 'text',
      content_text: 'Live customer',
      media_id: null,
    },
    {
      type: 'image',
      image: { id: 'private-media', mime_type: 'image/jpeg', caption: 'Photo' },
      content_type: 'image',
      content_text: 'Photo',
      media_id: 'private-media',
    },
    {
      type: 'audio',
      audio: { id: 'audio-1' },
      content_type: 'audio',
      content_text: null,
      media_id: 'audio-1',
    },
    {
      type: 'video',
      video: { id: 'video-1' },
      content_type: 'video',
      content_text: null,
      media_id: 'video-1',
    },
    {
      type: 'document',
      document: { id: 'doc-1', filename: 'file.pdf' },
      content_type: 'document',
      content_text: 'file.pdf',
      media_id: 'doc-1',
    },
    {
      type: 'sticker',
      sticker: { id: 'sticker-1' },
      content_type: 'image',
      content_text: null,
      media_id: 'sticker-1',
    },
    {
      type: 'location',
      location: { latitude: 1, longitude: 2 },
      content_type: 'location',
      content_text: '{"latitude":1,"longitude":2}',
      media_id: null,
    },
    {
      type: 'interactive',
      interactive: { type: 'future_reply' },
      content_type: 'interactive',
      content_text: '[Interactive reply]',
      media_id: null,
    },
    {
      type: 'button',
      button: { payload: 'payload-only' },
      content_type: 'interactive',
      content_text: 'payload-only',
      media_id: null,
    },
  ])(
    'preserves supported live content without fetching media: $type',
    ({ content_type, content_text, media_id, ...message }) => {
      expect(
        normalizeDelivery(
          delivery('messages', { messages: [{ ...liveMessage, ...message }] })
        )
      ).toMatchObject([
        {
          kind: 'live_message',
          content_type,
          content_text,
          media_id,
          placeholder: false,
        },
      ]);
    }
  );

  it.each<Record<string, JsonValue>>([
    { messages: [] },
    { statuses: [{ id: 'wamid.status' }] },
    { messages: [liveMessage], statuses: [] },
    { messages: [liveMessage], messaging_product: 'other' },
    { messages: [{ ...liveMessage, from: '15550001234' }] },
    {
      messages: [
        {
          id: liveMessage.id,
          timestamp: liveMessage.timestamp,
          type: 'text',
          text: liveMessage.text,
        },
      ],
    },
    { messages: [{ ...liveMessage, from: 'bad' }] },
    { messages: [{ ...liveMessage, type: 'image' }] },
    { messages: [{ ...liveMessage, type: 'interactive' }] },
    {
      messages: [
        {
          ...liveMessage,
          type: 'interactive',
          interactive: { type: 'button_reply' },
        },
      ],
    },
    { messages: [liveMessage, { ...liveMessage, type: 'reaction' }] },
    { messages: [{ ...liveMessage, type: 'template' }] },
    { messages: [{ ...liveMessage, type: 'media_placeholder' }] },
    { messages: [{ ...liveMessage, type: 'button', button: {} }] },
    {
      messages: [
        {
          ...liveMessage,
          from_user_id: 'US.11111111',
          from_parent_user_id: 'US.22222222',
        },
      ],
      contacts: [{ user_id: 'US.11111111', parent_user_id: 'US.33333333' }],
    },
    {
      messages: [{ ...liveMessage, from_user_id: 'US.11111111' }],
      contacts: [{ user_id: 'US.11111111', wa_id: '15550001234' }],
    },
    {
      messages: [liveMessage],
      contacts: [
        { wa_id: liveMessage.from, user_id: 'US.11111111' },
        { wa_id: liveMessage.from, user_id: 'US.22222222' },
      ],
    },
    {
      messages: [{ ...liveMessage, from_user_id: 'US.11111111' }],
      contacts: [{ wa_id: liveMessage.from, user_id: 'US.22222222' }],
    },
  ])(
    'quarantines the whole unsupported or conflicting live change %#',
    (value) => {
      expect(normalizeDelivery(delivery('messages', value))).toEqual([
        { kind: 'quarantine', code: 'unsupported_payload' },
      ]);
    }
  );
});

describe('Coexistence delivery normalization', () => {
  it('does not combine a recipient phone with a contradictory contact BSUID', () => {
    const result = normalizeDelivery(
      delivery('smb_message_echoes', {
        message_echoes: [
          {
            id: 'wamid.conflict',
            to: '15550005678',
            to_user_id: 'US.11111111',
            timestamp: '1700000000',
            type: 'text',
            text: { body: 'Conflict' },
          },
        ],
        contacts: [{ wa_id: '15550005678', user_id: 'US.22222222' }],
      })
    );

    expect(result).toEqual([
      { kind: 'quarantine', code: 'conflicting_echo_recipient' },
    ]);
  });

  it('records error-only declined history without phone metadata', () => {
    expect(
      normalizeDelivery(
        deliverySchema.parse({
          waba_id: '5678',
          field: 'history',
          value: { history: [{ errors: [{ code: 2593109 }] }] },
        })
      )
    ).toEqual([
      {
        kind: 'progress',
        phase: null,
        chunk_order: null,
        progress: null,
        error_code: 2593109,
      },
    ]);
  });

  it('rejects punctuation-only business phone metadata', () => {
    const result = normalizeDelivery(
      deliverySchema.parse({
        waba_id: '5678',
        field: 'smb_message_echoes',
        value: {
          metadata: { phone_number_id: '1234', display_phone_number: '------' },
          message_echoes: [
            {
              id: 'wamid.invalid',
              to: '15550005678',
              timestamp: '1700000000',
              type: 'text',
              text: { body: 'Invalid' },
            },
          ],
        },
      })
    );

    expect(result).toEqual([{ kind: 'quarantine', code: 'malformed_echo' }]);
  });

  it('keeps media hydration separate from contact creation and live acceptance', () => {
    const result = normalizeDelivery(
      delivery('history', {
        messages: [
          {
            id: 'wamid.placeholder',
            timestamp: '1700000000',
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg' },
          },
        ],
      })
    );

    expect(result).toEqual([
      {
        kind: 'hydration',
        wamid: 'wamid.placeholder',
        media_id: 'media-1',
        media_type: 'image/jpeg',
        content_type: 'image',
        content_text: null,
      },
    ]);
  });

  it('retains declined-sharing as progress without requiring threads', () => {
    expect(
      normalizeDelivery(
        delivery('history', { history: [{ errors: [{ code: 2593109 }] }] })
      )
    ).toEqual([
      {
        kind: 'progress',
        phase: null,
        chunk_order: null,
        progress: null,
        error_code: 2593109,
      },
    ]);
  });

  it('records address-book removal without issuing a CRM delete operation', () => {
    const result = normalizeDelivery(
      delivery('smb_app_state_sync', {
        state_sync: [
          {
            type: 'contact',
            action: 'remove',
            contact: { user_id: 'US.12345678' },
            metadata: { timestamp: '1700000000' },
          },
        ],
      })
    );

    expect(result).toEqual([
      {
        kind: 'contact',
        action: 'remove',
        occurred_at: '2023-11-14T22:13:20.000Z',
        identity: {
          phone: '',
          wa_user_id: 'US.12345678',
          wa_parent_user_id: null,
          wa_username: null,
          name: null,
        },
      },
    ]);
  });

  it('does not accept parseInt-style timestamp coercion or malformed primary identities', () => {
    const invalidMessages: JsonValue[] = [
      {
        id: 'wamid.invalid',
        to: '15550005678',
        timestamp: '1700000000junk',
        type: 'text',
        text: { body: 'Invalid' },
      },
      {
        id: 'wamid.invalid',
        to_user_id: 'not-a-bsuid',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'Invalid' },
      },
    ];

    for (const message of invalidMessages) {
      expect(
        normalizeDelivery(
          delivery('smb_message_echoes', { message_echoes: [message] })
        )
      ).toEqual([{ kind: 'quarantine', code: 'malformed_echo' }]);
    }
  });

  it('identifies the echo recipient without contacts and preserves its device time', () => {
    const result = normalizeDelivery(
      delivery('smb_message_echoes', {
        message_echoes: [
          {
            from: '15550001234',
            to: '15550005678',
            id: 'wamid.echo',
            timestamp: '1700000000',
            type: 'text',
            text: { body: 'From phone' },
          },
        ],
      })
    );

    expect(result).toMatchObject([
      {
        kind: 'message',
        source: 'phone_app',
        sender_type: 'agent',
        wamid: 'wamid.echo',
        occurred_at: '2023-11-14T22:13:20.000Z',
        identity: { phone: '15550005678' },
        content_text: 'From phone',
      },
    ]);
  });

  it('keeps history direction separate from a BSUID-only thread identity', () => {
    const result = normalizeDelivery(
      delivery('history', {
        history: [
          {
            metadata: { phase: 0, chunk_order: 1, progress: 50 },
            threads: [
              {
                context: { user_id: 'US.12345678' },
                messages: [
                  {
                    from_user_id: 'US.12345678',
                    id: 'wamid.in',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Customer' },
                  },
                  {
                    from: '15550001234',
                    id: 'wamid.out',
                    timestamp: '1700000001',
                    type: 'media_placeholder',
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(result).toMatchObject([
      {
        kind: 'message',
        source: 'history',
        sender_type: 'customer',
        identity: { phone: '', wa_user_id: 'US.12345678' },
      },
      {
        kind: 'message',
        source: 'history',
        sender_type: 'agent',
        placeholder: true,
      },
      { kind: 'progress', phase: 0, chunk_order: 1, progress: 50 },
    ]);
  });

  it('quarantines a media type whose matching payload is absent', () => {
    const result = normalizeDelivery(
      delivery('smb_message_echoes', {
        message_echoes: [
          {
            to: '15550005678',
            id: 'wamid.bad-media',
            timestamp: '1700000000',
            type: 'image',
            video: { id: 'wrong-kind' },
          },
        ],
      })
    );

    expect(result).toEqual([
      { kind: 'quarantine', code: 'unsupported_message_content_or_status' },
    ]);
  });

  it.each([
    ['sent', 'SENT', 'sent'],
    ['delivered', 'DELIVERED', 'delivered'],
    ['read', 'READ', 'read'],
    ['played', 'PLAYED', 'read'],
    ['error', 'ERROR', 'failed'],
    ['pending', 'PENDING', 'pending'],
    ['future_status', 'FUTURE_STATUS', null],
    [' Read ', 'Read', null],
  ])('interprets only documented history statuses: %s / %s', (lower, upper, expected) => {
    for (const status of [lower, upper]) {
      const result = normalizeDelivery(
        delivery('history', {
          history: [
            {
              threads: [
                {
                  id: '15550005678',
                  messages: [
                    {
                      from: '15550005678',
                      id: 'wamid.history-status',
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: 'Past message' },
                      history_context: { status },
                    },
                  ],
                },
              ],
            },
          ],
        })
      );

      expect(result).toMatchObject(
        expected === null
          ? [{ kind: 'quarantine', code: 'unsupported_message_content_or_status' }]
          : [{ kind: 'message', source: 'history', status: expected }]
      );
    }
  });

  it('quarantines directionless history instead of inventing an outbound sender', () => {
    const result = normalizeDelivery(
      delivery('history', {
        history: [
          {
            threads: [
              {
                id: '15550005678',
                messages: [
                  {
                    id: 'wamid.unknown',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Unknown' },
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(result).toEqual([
      { kind: 'quarantine', code: 'ambiguous_history_direction' },
    ]);
  });
});
