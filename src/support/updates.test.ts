import { describe, expect, it } from 'vitest';

import { statusMessage } from './updates';

describe('statusMessage', () => {
  it('tells someone on the latest version which version that is', () => {
    expect(statusMessage({ status: 'current', current: '1.2.3' }).message).toContain('1.2.3');
  });

  it('explains a missing or private repository without calling it an error', () => {
    const { title, message } = statusMessage({ status: 'noReleases', current: '1.2.3' });
    expect(title).toBe('No releases found');
    expect(message).toMatch(/private/);
  });

  it('gives each failure its own advice', () => {
    expect(statusMessage({ status: 'offline', current: '1' }).message).toMatch(/internet connection/);
    expect(statusMessage({ status: 'rateLimited', current: '1' }).message).toMatch(/limiting/);
    expect(statusMessage({ status: 'failed', current: '1' }).message).toMatch(/could not read/);
  });
});
