import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useProject } from '../state/project';
import { HistoryRetention, validateRetention } from './HistoryRetention';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/rpc', async (original) => ({
  ...(await original<typeof import('../lib/rpc')>()),
  rpc: rpcMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draft = (over: Partial<Record<'keepAllDays' | 'dailyForDays' | 'keepLatest', string>> = {}) => ({
  enabled: true,
  keepAllDays: '14',
  dailyForDays: '90',
  keepLatest: '10',
  ...over,
});

describe('validateRetention', () => {
  it('accepts the defaults', () => {
    expect(validateRetention(draft())).toEqual({});
  });

  it('rejects empty, fractional, negative and out-of-range numbers', () => {
    expect(Object.keys(validateRetention(draft({ keepAllDays: '' })))).toEqual(['keepAllDays']);
    expect(Object.keys(validateRetention(draft({ keepAllDays: '1.5' })))).toEqual(['keepAllDays']);
    expect(Object.keys(validateRetention(draft({ keepLatest: '-3' })))).toEqual(['keepLatest']);
    expect(Object.keys(validateRetention(draft({ keepLatest: '0' })))).toEqual(['keepLatest']);
    expect(Object.keys(validateRetention(draft({ keepLatest: '1001' })))).toEqual(['keepLatest']);
  });

  it('needs the daily period to be at least the days kept in full', () => {
    expect(Object.keys(validateRetention(draft({ keepAllDays: '30', dailyForDays: '20' })))).toEqual(['dailyForDays']);
    expect(validateRetention(draft({ keepAllDays: '30', dailyForDays: '30' }))).toEqual({});
  });
});

describe('HistoryRetention', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    rpcMock.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useProject.getState().setStatus({ open: false, name: '', path: null, dirty: false });
  });

  const input = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
  const type = (id: string, value: string) => {
    const el = input(id);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('is disabled and reads nothing when no project is open', async () => {
    await act(async () => root.render(<HistoryRetention />));
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('shows the stored values, blocks bad input and saves good input', async () => {
    rpcMock.mockImplementation(async (method: string, params: unknown) =>
      method === 'revisions.retention' ? { enabled: true, keepAllDays: 14, dailyForDays: 90, keepLatest: 10 } : params,
    );
    useProject.getState().setStatus({ open: true, name: 'World', path: null, dirty: false });
    await act(async () => root.render(<HistoryRetention />));

    expect(host.querySelector('fieldset')!.disabled).toBe(false);
    expect(input('retention-keepAllDays').value).toBe('14');
    expect(host.textContent).toContain('always kept');

    type('retention-keepLatest', '0');
    expect(input('retention-save').disabled).toBe(true);
    expect(input('retention-keepLatest').getAttribute('aria-invalid')).toBe('true');

    type('retention-keepLatest', '25');
    expect(input('retention-save').disabled).toBe(false);
    await act(async () => input('retention-save').click());
    expect(rpcMock).toHaveBeenCalledWith('revisions.setRetention', {
      enabled: true,
      keepAllDays: 14,
      dailyForDays: 90,
      keepLatest: 25,
    });
  });
});
