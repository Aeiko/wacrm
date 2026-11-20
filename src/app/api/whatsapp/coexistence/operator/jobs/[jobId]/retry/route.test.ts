import { expect, it } from 'vitest';
import * as retry from './route';
import * as inventory from '../../../route';

it.each([
  retry.GET,
  retry.PUT,
  retry.PATCH,
  retry.DELETE,
  retry.HEAD,
  retry.OPTIONS,
])(
  'rejects unsupported retry methods without authentication or network work',
  async (handler) => {
    const response = handler();
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({ error: 'operator_unavailable' });
  }
);

it.each([
  inventory.POST,
  inventory.PUT,
  inventory.PATCH,
  inventory.DELETE,
  inventory.HEAD,
  inventory.OPTIONS,
])('rejects non-read inventory methods without work', (handler) => {
  const response = handler();
  expect(response.status).toBe(405);
  expect(response.headers.get('Allow')).toBe('GET');
});
