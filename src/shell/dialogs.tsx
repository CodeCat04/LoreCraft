import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

import { t } from '../lib/i18n';

/** One choice in a dialog. The value comes back from `choose`. */
export interface DialogChoice<T> {
  label: string;
  value: T;
  /** `primary` is the default action, `danger` marks something destructive. */
  tone?: 'primary' | 'danger' | 'normal';
}

interface ActiveDialog {
  id: number;
  render: (close: () => void) => ReactNode;
  onDismiss: () => void;
  /** Where the keyboard was before this opened, to go back to. */
  returnFocus: HTMLElement | null;
}

interface DialogStore {
  stack: ActiveDialog[];
  open: (dialog: Omit<ActiveDialog, 'id' | 'returnFocus'>) => number;
  close: (id: number) => void;
}

let nextId = 1;

const useDialogs = create<DialogStore>((set, get) => ({
  stack: [],
  open: (dialog) => {
    const id = nextId++;
    const active = document.activeElement;
    const returnFocus = active instanceof HTMLElement ? active : null;
    set((s) => ({ stack: [...s.stack, { ...dialog, id, returnFocus }] }));
    return id;
  },
  close: (id) => {
    const closing = get().stack.find((d) => d.id === id);
    set((s) => ({ stack: s.stack.filter((d) => d.id !== id) }));
    // The app behind is still inert until React catches up, and an inert element cannot take
    // the keyboard, so it is released first when the last dialog closes.
    if (get().stack.length === 0) releaseBackground();
    if (closing?.returnFocus?.isConnected) closing.returnFocus.focus({ preventScroll: true });
  },
}));

const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]';

/** Shows a dialog with buttons. Escape or clicking away returns `dismissValue`. */
export function choose<T>(options: {
  title: string;
  message?: ReactNode;
  choices: DialogChoice<T>[];
  dismissValue: T;
}): Promise<T> {
  return new Promise((resolve) => {
    const finish = (value: T, close: () => void) => {
      close();
      resolve(value);
    };
    useDialogs.getState().open({
      onDismiss: () => resolve(options.dismissValue),
      render: (close) => (
        <div className="dialog" role="alertdialog" aria-labelledby="dialog-title">
          <h2 id="dialog-title" className="dialog-title">{options.title}</h2>
          {options.message && <div className="dialog-message">{options.message}</div>}
          <div className="dialog-actions">
            {options.choices.map((choice) => (
              <button
                key={choice.label}
                type="button"
                className={`btn${choice.tone === 'primary' ? ' btn-primary' : ''}${choice.tone === 'danger' ? ' btn-danger' : ''}`}
                autoFocus={choice.tone === 'primary'}
                onClick={() => finish(choice.value, close)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      ),
    });
  });
}

export function confirm(options: {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return choose<boolean>({
    title: options.title,
    message: options.message,
    dismissValue: false,
    choices: [
      { label: t('Cancel'), value: false },
      {
        label: options.confirmLabel ?? t('OK'),
        value: true,
        tone: options.danger ? 'danger' : 'primary',
      },
    ],
  });
}

function PromptBody(props: {
  title: string;
  label?: string;
  message?: ReactNode;
  initial: string;
  placeholder?: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const problem = props.validate?.(value) ?? null;
  return (
    <form
      className="dialog"
      role="dialog"
      aria-labelledby="dialog-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) props.onSubmit(value);
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{props.title}</h2>
      {props.message && <div className="dialog-message">{props.message}</div>}
      <label className="field">
        {props.label && <span className="field-label">{props.label}</span>}
        <input
          ref={inputRef}
          className="input"
          autoFocus
          value={value}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {problem && value && <div className="field-error">{problem}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.onCancel}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!!problem}>{props.confirmLabel}</button>
      </div>
    </form>
  );
}

/** Asks for one line of text. Returns null if cancelled. */
export function promptText(options: {
  title: string;
  label?: string;
  message?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().open({
      onDismiss: () => resolve(null),
      render: (close) => (
        <PromptBody
          title={options.title}
          label={options.label}
          message={options.message}
          initial={options.initial ?? ''}
          placeholder={options.placeholder}
          confirmLabel={options.confirmLabel ?? t('OK')}
          validate={options.validate}
          onSubmit={(value) => {
            close();
            resolve(value);
          }}
          onCancel={() => {
            close();
            resolve(null);
          }}
        />
      ),
    });
  });
}

/** Shows custom content. `close` ends it, and the promise resolves with its value. */
export function showDialog<T>(
  render: (close: (value: T) => void) => ReactNode,
  dismissValue: T,
): Promise<T> {
  return new Promise((resolve) => {
    useDialogs.getState().open({
      onDismiss: () => resolve(dismissValue),
      render: (closeDialog) => (
        <div className="dialog dialog-wide" role="dialog" aria-labelledby="dialog-title">
          {render((value) => {
            closeDialog();
            resolve(value);
          })}
        </div>
      ),
    });
  });
}

/** Marks the dialog in `backdrop` modal, and names it after its heading if it has no name. */
function labelDialog(backdrop: HTMLElement) {
  const box =
    backdrop.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]') ??
    (backdrop.firstElementChild as HTMLElement | null);
  if (!box) return;
  if (!box.getAttribute('role')) box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  if (box.getAttribute('aria-label')) return;
  const labelled = box.getAttribute('aria-labelledby');
  const ownId = `dialog-title-${backdrop.dataset.dialog}`;
  // A dialog that names itself with its own id keeps that name.
  if (labelled && labelled !== 'dialog-title' && labelled !== ownId && document.getElementById(labelled)) return;
  // A dialog can change what it shows, such as a list that becomes a form, and its new
  // heading arrives with the shared id. The name follows the heading now showing.
  const heading =
    box.querySelector<HTMLElement>('#dialog-title') ??
    (labelled === ownId && box.querySelector(`#${ownId}`) ? null : box.querySelector<HTMLElement>('h1, h2, h3, .dialog-title'));
  if (!heading) return;
  for (const el of box.querySelectorAll('[aria-labelledby="dialog-title"]')) el.setAttribute('aria-labelledby', ownId);
  box.querySelector(`#${ownId}`)?.removeAttribute('id');
  heading.id = ownId;
  box.setAttribute('aria-labelledby', ownId);
}

/** Makes everything but the dialogs and toasts inert. Returns how to undo it. */
function setBackgroundInert(on: boolean): (() => void) | undefined {
  if (!on) return undefined;
  const host = document.querySelector('[data-dialog]')?.parentElement;
  if (!host) return undefined;
  const changed: HTMLElement[] = [];
  for (const child of host.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.hasAttribute('data-dialog') || child.inert || child.matches('.toasts')) continue;
    child.inert = true;
    child.setAttribute('data-dialog-inert', '');
    changed.push(child);
  }
  return () => changed.forEach(release);
}

function release(el: HTMLElement) {
  el.inert = false;
  el.removeAttribute('data-dialog-inert');
}

function releaseBackground() {
  document.querySelectorAll<HTMLElement>('[data-dialog-inert]').forEach(release);
}

/** Tab cycles within the top dialog, since everything behind it is out of reach. */
function keepFocusInside(e: KeyboardEvent) {
  const dialogs = document.querySelectorAll('.dialog-backdrop');
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return;
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)',
    ),
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !dialog.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

export function DialogHost() {
  const stack = useDialogs((s) => s.stack);
  const close = useDialogs((s) => s.close);
  const top = stack[stack.length - 1];

  // A dialog takes the keyboard. Left behind the backdrop, keys would keep acting on
  // whatever was focused, such as Enter pressing the button that opened this.
  const topId = top?.id;
  useEffect(() => {
    if (topId === undefined) return;
    const box = document.querySelector<HTMLElement>(`[data-dialog="${topId}"]`);
    if (box && !box.contains(document.activeElement)) box.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [topId]);

  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // An open list of suggestions closes first, and the dialog stays.
        if ((e.target as HTMLElement | null)?.matches?.('[role="combobox"][aria-expanded="true"]')) return;
        e.stopPropagation();
        close(top.id);
        top.onDismiss();
      } else if (e.key === 'Tab') {
        keepFocusInside(e);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [top, close]);

  // Every dialog is modal and named. Many dialogs share the `dialog-title` id, which would
  // clash when two are open, so each takes its own id from its first heading. The app behind
  // the dialogs is made inert, so neither the keyboard nor a screen reader can reach it.
  useLayoutEffect(() => {
    const labelAll = () => {
      for (const backdrop of document.querySelectorAll<HTMLElement>('[data-dialog]')) labelDialog(backdrop);
    };
    labelAll();
    // A dialog's own content changes without this host rendering again, so watch it.
    const observer = new MutationObserver(labelAll);
    for (const backdrop of document.querySelectorAll<HTMLElement>('[data-dialog]')) {
      observer.observe(backdrop, { childList: true, subtree: true });
    }
    const release = setBackgroundInert(stack.length > 0);
    return () => {
      observer.disconnect();
      release?.();
    };
  });

  return (
    <>
      {stack.map((dialog) => (
        <div
          key={dialog.id}
          className="dialog-backdrop"
          data-dialog={dialog.id}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              close(dialog.id);
              dialog.onDismiss();
            }
          }}
        >
          {dialog.render(() => close(dialog.id))}
        </div>
      ))}
    </>
  );
}
