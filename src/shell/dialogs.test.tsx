import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DialogHost, showDialog } from './dialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('DialogHost', () => {
  let root: Root;
  let host: HTMLDivElement;
  let app: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <>
          <div data-testid="app"><button type="button">Behind</button></div>
          <DialogHost />
        </>,
      ),
    );
    app = host.querySelector('[data-testid="app"]')!;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const nameOf = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent;

  it('names each dialog after its own heading, makes it modal, and the app inert', () => {
    let closeFirst: (v: null) => void = () => {};
    act(() => void showDialog<null>((close) => { closeFirst = close; return <h2 className="dialog-title">Recover your work?</h2>; }, null));
    act(() => void showDialog<null>(() => <h2 id="dialog-title" className="dialog-title">Second</h2>, null));
    const [first, second] = dialogs();
    expect(first.getAttribute('aria-modal')).toBe('true');
    expect(nameOf(first)).toBe('Recover your work?');
    expect(nameOf(second)).toBe('Second');
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'));
    expect(app.inert).toBe(true);

    act(() => closeFirst(null));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(dialogs()).toHaveLength(0);
    expect(app.inert).toBe(false);
  });
});
