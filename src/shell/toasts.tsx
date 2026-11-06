import { create } from 'zustand';

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

export type ToastKind = 'info' | 'success' | 'error';

/** A button on a toast. A toast with one stays until dismissed, so it can be pressed. */
export interface ToastAction {
  label: string;
  run: () => void;
}

interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  action?: ToastAction;
}

interface ToastStore {
  toasts: Toast[];
  push: (text: string, kind: ToastKind, action?: ToastAction) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (text, kind, action) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
    // Errors stay until dismissed, since the user may need to act on them.
    if (kind !== 'error' && !action) window.setTimeout(() => get().dismiss(id), 3500);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Shows a toast, and returns a function that takes it away early. */
export function toast(text: string, kind: ToastKind = 'info', action?: ToastAction): () => void {
  const { push, dismiss } = useToasts.getState();
  const id = push(text, kind, action);
  return () => dismiss(id);
}

export function ToastHost() {
  useLocale();
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          <span>{item.text}</span>
          {item.action && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                dismiss(item.id);
                item.action?.run();
              }}
            >
              {item.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label={t('Dismiss')} onClick={() => dismiss(item.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
