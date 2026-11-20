import { afterEach, describe, expect, it, vi } from 'vitest';
import { getT } from './translate';

describe('getT', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses English plural rules even with a legacy locale setting', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_LOCALE', 'pt');
    const t = getT('Dashboard.overview.attention');
    expect(t('onlineNow', { count: 0 })).toBe('No teammates online');
    expect(t('onlineNow', { count: 1 })).toBe('1 teammate online');
    expect(t('onlineNow', { count: 5000 })).toBe('5,000 teammates online');
  });
});
