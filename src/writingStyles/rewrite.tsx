/** "Rewrite in a style…": the instruction for a selection, the default style, and the list to choose from. */

import { useEffect, useRef, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { useProject } from '../state/project';
import { defaultLabel } from './defaults';
import type { EffectiveStyle } from './resolve';
import { StyleSearchList } from './StylePicker';
import { getActiveStyle, getStyle, loadRecentStyles, onStyleChoicesChanged, resolveRewriteDefault, setActiveStyle } from './store';

/**
 * What a rewrite asks for. The style itself travels as the request's `styleId`, so the model
 * reads it in the same <writing_style> block as always, with the writer's style guide.
 * `fallbackName` names a custom style the project carries but this computer does not have.
 */
export function rewriteInstruction(styleId: string, fallbackName?: string | null): { instruction: string; label: string } | null {
  const name = getStyle(styleId)?.name ?? fallbackName;
  if (!name) return null;
  return {
    label: t('In a style: {name}', { name }),
    instruction: `Rewrite this passage in the writing style you were given (${name}). Keep every event, fact and meaning the same, and change only how it is written.`,
  };
}

/**
 * The style a rewrite of this scene uses unless the writer picks another: the scene's, the
 * book's, then the project's. Null while loading, and when there is none.
 */
export function useRewriteDefault(nodeId: string | null | undefined): EffectiveStyle | null {
  const open = useProject((s) => s.status.open);
  const path = useProject((s) => s.status.path);
  const version = useDataVersion('meta');
  const [changes, setChanges] = useState(0);
  const [found, setFound] = useState<EffectiveStyle | null>(null);
  useEffect(() => onStyleChoicesChanged(() => setChanges((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    if (!open) {
      setFound(null);
      return undefined;
    }
    resolveRewriteDefault({ nodeId }).then(
      (style) => live && setFound(style),
      () => live && setFound(null),
    );
    return () => {
      live = false;
    };
  }, [open, path, nodeId, version, changes]);
  return found;
}

export async function setProjectDefault(styleId: string): Promise<void> {
  try {
    await setActiveStyle({ kind: 'project' }, styleId);
    const name = getStyle(styleId)?.name;
    toast(name ? t('Using {name} for this project.', { name }) : t('Using that style for this project.'), 'success');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

interface PickerStart {
  first: { styleId: string; label: string } | null;
  recent: string[];
  projectDefaultId: string | null;
}

async function loadPickerStart(nodeId: string | null | undefined): Promise<PickerStart> {
  const [effective, recent, project] = await Promise.all([
    resolveRewriteDefault({ nodeId }),
    loadRecentStyles(),
    getActiveStyle({ kind: 'project' }),
  ]);
  const first = effective ? { styleId: effective.styleId, label: defaultLabel(effective.level, effective.name ?? effective.styleId) } : null;
  return { first, recent, projectDefaultId: project?.styleId ?? null };
}

/**
 * A small panel for choosing a style to rewrite in. The default style is at the top and
 * chosen, so Enter uses it, and recently used styles come next. Escape or a click away closes it.
 */
export function RewriteInStylePicker({ nodeId, onChoose, onClose }: {
  /** The scene being rewritten, whose style comes first. None for a wiki page. */
  nodeId?: string | null;
  onChoose: (styleId: string, name: string | null) => void;
  onClose: () => void;
}) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<PickerStart | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => onStyleChoicesChanged(() => setChanges((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    // Nothing shows until the default is known, so Enter never picks a style by accident.
    loadPickerStart(nodeId).then(
      (loaded) => live && setStart(loaded),
      () => live && setStart({ first: null, recent: [], projectDefaultId: null }),
    );
    return () => {
      live = false;
    };
  }, [nodeId, changes]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="style-rewrite-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {start && (
        <StyleSearchList
          autoFocus
          value={null}
          label={t('Rewrite in which style?')}
          first={start.first}
          recent={start.recent}
          projectDefaultId={start.projectDefaultId}
          onSetDefault={(id) => void setProjectDefault(id)}
          onChoose={(id) => {
            if (id) onChoose(id, getStyle(id)?.name ?? null);
          }}
        />
      )}
    </div>
  );
}
