/**
 * Shows one map: the image, panning and zooming, and its pins. Moving the view writes
 * straight to the DOM rather than through React, so it stays smooth with many pins.
 * Each pin is a real button, which gives it keyboard access and the wiki hover card.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import * as extras from '../api';
import { useDocSaver } from '../../editor/saving';
import { PageAutocomplete } from '../common/PageAutocomplete';
import { TypeMark } from '../common/pageTypes';
import { assetUrl } from '../../lib/assets';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { confirm } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import { useNav } from '../../state/nav';
import { useTitles } from '../../state/project';
import {
  centerOnFraction,
  clampFraction,
  clampViewport,
  fitViewport,
  fractionToScreen,
  isOnImage,
  screenToFraction,
  zoomAt,
  type Size,
  type Viewport,
} from './viewport';

const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM_SPEED = 0.0016;
const BUTTON_ZOOM_FACTOR = 1.4;
const KEY_PAN_PX = 60;
/** One arrow-key nudge of a pin, as a fraction of the image. Shift moves it further. */
const NUDGE = 0.005;
const NUDGE_FAR = 0.02;
const FLASH_MS = 1600;
const EDITOR_WIDTH_REM = 19;

export function pinName(pin: extras.MapPin): string {
  return pin.pageTitle ?? (pin.label || t('Unnamed pin'));
}

function pinDescription(pin: extras.MapPin): string {
  const vars = { name: pinName(pin), x: Math.round(pin.x * 100), y: Math.round(pin.y * 100) };
  return pin.pageId && !pin.pageTitle
    ? t('{name}, {x}% across, {y}% down, linked page is in the trash', vars)
    : t('{name}, {x}% across, {y}% down', vars);
}

/** Why the map's image is not showing, kept as a kind so it reads in the current language. */
type ImageProblem = { kind: 'missing' } | { kind: 'unloadable'; reason: string } | { kind: 'broken' };

function imageProblemText(problem: ImageProblem): string {
  if (problem.kind === 'missing') return t('This map has no image.');
  if (problem.kind === 'unloadable') {
    return t('The image for this map could not be loaded: {reason}', { reason: problem.reason });
  }
  return t('This image could not be displayed. The file may be damaged.');
}

/** What a pin does when clicked. A page opens. A label has nothing to open, so it edits. */
function pinOpensPage(pin: extras.MapPin): boolean {
  return !!pin.pageId && !!pin.pageTitle;
}

// ---- Adding and editing a pin ---------------------------------------------------

interface EditorTarget {
  /** Null when adding. */
  pin: extras.MapPin | null;
  x: number;
  y: number;
}

function PinEditor(props: {
  target: EditorTarget;
  style: React.CSSProperties;
  onSave: (choice: { pageId: string; label: string }) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  useLocale();
  const { target, style, onSave, onDelete, onCancel } = props;
  const editing = target.pin;
  const [text, setText] = useState(editing ? editing.pageTitle ?? editing.label : '');
  const resolved = useTitles((s) => s.resolve(text));
  const trimmed = text.trim();

  const submit = () => {
    if (!trimmed) return;
    onSave(resolved ? { pageId: resolved.id, label: '' } : { pageId: '', label: trimmed });
  };

  return (
    <form
      className="map-pin-editor"
      style={style}
      aria-label={editing ? t('Edit pin') : t('Add pin')}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          onCancel();
        }
      }}
    >
      <label className="field">
        <span className="field-label">{t('Page or label')}</span>
        <PageAutocomplete
          label={t('Page or label')}
          placeholder={t('Start typing a page title')}
          autoFocus
          value={text}
          onChange={setText}
          onPick={(entry) => setText(entry.title)}
          onEnter={submit}
          onEscape={onCancel}
        />
      </label>
      <p className="field-hint map-pin-editor-hint" role="status">
        {!trimmed
          ? t('Choose a page to link it, or type any label.')
          : resolved
            ? t('Links to the page {title}.', { title: resolved.title })
            : t('A label with no page behind it.')}
      </p>
      <div className="dialog-actions">
        {editing && (
          <button type="button" className="btn btn-danger" onClick={onDelete}>{t('Delete pin')}</button>
        )}
        <button type="button" className="btn" onClick={onCancel}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!trimmed}>
          {editing ? t('Save') : t('Add pin')}
        </button>
      </div>
    </form>
  );
}

// ---- The map --------------------------------------------------------------------

interface Props {
  map: extras.MapWithPins;
  /** A pin to bring into view when the map opens. */
  focusPinId?: string | null;
  onFocusHandled?: () => void;
}

export function MapCanvas({ map, focusPinId, onFocusHandled }: Props) {
  useLocale();
  const go = useNav((s) => s.go);
  const viewportBox = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<Viewport>({ k: 1, tx: 0, ty: 0 });
  /** Until the user moves the map, resizing the window keeps it fitted. */
  const untouched = useRef(true);

  const [url, setUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<ImageProblem | null>(null);
  const [imageSize, setImageSize] = useState<Size | null>(null);
  const [pins, setPins] = useState(map.pins);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [editorStyle, setEditorStyle] = useState<React.CSSProperties>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [showList, setShowList] = useState(true);

  useEffect(() => setPins(map.pins), [map.pins]);

  useEffect(() => {
    let live = true;
    setUrl(null);
    setImageSize(null);
    setImageError(null);
    if (!map.assetId) {
      setImageError({ kind: 'missing' });
      return undefined;
    }
    assetUrl(map.assetId).then(
      (found) => {
        if (live) setUrl(found);
      },
      (e) => {
        if (live) setImageError({ kind: 'unloadable', reason: errorMessage(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [map.assetId]);

  const viewSize = useCallback((): Size => {
    const box = viewportBox.current;
    return { width: box?.clientWidth ?? 0, height: box?.clientHeight ?? 0 };
  }, []);

  const apply = useCallback((next: Viewport) => {
    view.current = next;
    const el = stage.current;
    if (!el) return;
    el.style.transform = `translate(${next.tx}px, ${next.ty}px) scale(${next.k})`;
    el.style.setProperty('--map-scale', String(next.k));
  }, []);

  const fit = useCallback(() => {
    if (!imageSize) return;
    untouched.current = true;
    apply(fitViewport(imageSize, viewSize()));
  }, [imageSize, apply, viewSize]);

  useLayoutEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const box = viewportBox.current;
    if (!box) return undefined;
    const observer = new ResizeObserver(() => {
      if (!imageSize) return;
      if (untouched.current) fit();
      else apply(clampViewport(view.current, imageSize, viewSize()));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [imageSize, fit, apply, viewSize]);

  const moveTo = useCallback(
    (next: Viewport) => {
      untouched.current = false;
      apply(next);
    },
    [apply],
  );

  const zoomBy = useCallback(
    (factor: number, sx?: number, sy?: number) => {
      if (!imageSize) return;
      const size = viewSize();
      moveTo(zoomAt(view.current, factor, sx ?? size.width / 2, sy ?? size.height / 2, imageSize, size));
    },
    [imageSize, moveTo, viewSize],
  );

  // The wheel needs a listener that can cancel scrolling, which React's cannot.
  useEffect(() => {
    const box = viewportBox.current;
    if (!box) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED), e.clientX - rect.left, e.clientY - rect.top);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // ---- Pins --------------------------------------------------------------------

  const flashPin = useCallback((id: string) => {
    setFlash(id);
    window.setTimeout(() => setFlash((current) => (current === id ? null : current)), FLASH_MS);
  }, []);

  const centerOnPin = useCallback(
    (pin: extras.MapPin) => {
      if (!imageSize) return;
      moveTo(centerOnFraction(view.current, imageSize, viewSize(), pin.x, pin.y));
      flashPin(pin.id);
    },
    [imageSize, moveTo, viewSize, flashPin],
  );

  useEffect(() => {
    if (!focusPinId || !imageSize) return;
    const pin = pins.find((p) => p.id === focusPinId);
    if (pin) centerOnPin(pin);
    onFocusHandled?.();
  }, [focusPinId, imageSize, pins, centerOnPin, onFocusHandled]);

  const openEditor = useCallback(
    (target: EditorTarget) => {
      if (!imageSize) return;
      const point = fractionToScreen(view.current, imageSize, target.x, target.y);
      const size = viewSize();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const width = EDITOR_WIDTH_REM * rem;
      const left = Math.max(8, Math.min(point.x + 12, size.width - width - 8));
      const fromBottom = point.y > size.height * 0.6;
      setEditorStyle(
        fromBottom
          ? { left, bottom: Math.max(8, size.height - point.y + 12) }
          : { left, top: Math.max(8, point.y + 12) },
      );
      setEditor(target);
    },
    [imageSize, viewSize],
  );

  const closeEditor = useCallback(() => {
    setEditor(null);
    viewportBox.current?.focus({ preventScroll: true });
  }, []);

  const savePin = async (choice: { pageId: string; label: string }) => {
    if (!editor) return;
    const { pin, x, y } = editor;
    try {
      if (pin) {
        const saved = await extras.pinUpdate(pin.id, choice);
        setPins((list) => list.map((p) => (p.id === saved.id ? saved : p)));
      } else {
        const added = await extras.pinAdd({
          mapId: map.id,
          x,
          y,
          label: choice.label,
          ...(choice.pageId ? { pageId: choice.pageId } : {}),
        });
        setPins((list) => [...list, added]);
      }
      closeEditor();
    } catch (e) {
      toast(t('Could not save the pin: {reason}', { reason: errorMessage(e) }), 'error');
    }
  };

  const deletePin = async (pin: extras.MapPin) => {
    const yes = await confirm({
      title: t('Delete the pin for {name}?', { name: pinName(pin) }),
      message: t('Any page it links to stays as it is.'),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!yes) return;
    try {
      await extras.pinDelete(pin.id);
      setPins((list) => list.filter((p) => p.id !== pin.id));
      setEditor(null);
      // Undo puts the same pin back in the same place, with the same page or label.
      const dismiss = toast(t('Deleted the pin for {name}.', { name: pinName(pin) }), 'info', {
        label: t('Undo'),
        run: () => {
          dismiss();
          extras
            .pinAdd({
              mapId: pin.mapId,
              x: pin.x,
              y: pin.y,
              label: pin.label,
              ...(pin.pageId ? { pageId: pin.pageId } : {}),
            })
            .then((added) => setPins((list) => [...list, added]))
            .catch((e: unknown) => toast(t('Could not save the pin: {reason}', { reason: errorMessage(e) }), 'error'));
        },
      });
    } catch (e) {
      toast(t('Could not delete the pin: {reason}', { reason: errorMessage(e) }), 'error');
    }
  };

  const movePin = useCallback(async (pin: extras.MapPin, x: number, y: number) => {
    setPins((list) => list.map((p) => (p.id === pin.id ? { ...p, x, y } : p)));
    try {
      await extras.pinUpdate(pin.id, { x, y });
    } catch (e) {
      toast(t('Could not move the pin: {reason}', { reason: errorMessage(e) }), 'error');
      setPins((list) => list.map((p) => (p.id === pin.id ? { ...p, x: pin.x, y: pin.y } : p)));
    }
  }, []);

  const pinAction = (pin: extras.MapPin) => {
    if (pinOpensPage(pin) && pin.pageId) go({ view: 'page', id: pin.pageId });
    else openEditor({ pin, x: pin.x, y: pin.y });
  };

  // ---- Pointer on the map ------------------------------------------------------

  const press = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  const onMapPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = {
      x: e.clientX,
      y: e.clientY,
      tx: view.current.tx,
      ty: view.current.ty,
      moved: false,
    };
    e.currentTarget.classList.add('is-panning');
  };

  const onMapPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const started = press.current;
    if (!started || !imageSize) return;
    const dx = e.clientX - started.x;
    const dy = e.clientY - started.y;
    if (!started.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
    started.moved = true;
    moveTo(
      clampViewport({ k: view.current.k, tx: started.tx + dx, ty: started.ty + dy }, imageSize, viewSize()),
    );
  };

  const onMapPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const started = press.current;
    press.current = null;
    e.currentTarget.classList.remove('is-panning');
    if (!started || started.moved || !imageSize) return;
    if (editor) {
      // The first click away from an open form only closes it.
      setEditor(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const point = screenToFraction(view.current, imageSize, e.clientX - rect.left, e.clientY - rect.top);
    if (isOnImage(point)) openEditor({ pin: null, x: point.x, y: point.y });
  };

  // ---- Pointer and keys on a pin -----------------------------------------------

  const pinPress = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  /** The click that ends a drag must not also open the pin. */
  const swallowClick = useRef(false);
  /**
   * Holding an arrow key should not write to the project on every repeat. This also
   * writes before saving or closing, as editors do, so a last nudge cannot be lost.
   */
  const nudgeSaver = useDocSaver<{ id: string; x: number; y: number }>(({ id, x, y }) =>
    extras.pinUpdate(id, { x, y }),
  );
  const lastNudged = useRef<string | null>(null);

  const fractionFromClient = (clientX: number, clientY: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clampFraction((clientX - rect.left) / rect.width),
      y: clampFraction((clientY - rect.top) / rect.height),
    };
  };

  const pinHandlers = (pin: extras.MapPin) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      // Stops the map behind it from panning or starting a new pin.
      e.stopPropagation();
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      pinPress.current = { id: pin.id, x: e.clientX, y: e.clientY, moved: false };
      swallowClick.current = false;
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const started = pinPress.current;
      if (!started || started.id !== pin.id) return;
      if (!started.moved && Math.hypot(e.clientX - started.x, e.clientY - started.y) < CLICK_SLOP_PX) return;
      started.moved = true;
      const { x, y } = fractionFromClient(e.clientX, e.clientY);
      e.currentTarget.style.left = `${x * 100}%`;
      e.currentTarget.style.top = `${y * 100}%`;
      e.currentTarget.classList.add('is-dragging');
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      const started = pinPress.current;
      pinPress.current = null;
      if (!started || started.id !== pin.id || !started.moved) return;
      swallowClick.current = true;
      e.currentTarget.classList.remove('is-dragging');
      const { x, y } = fractionFromClient(e.clientX, e.clientY);
      void movePin(pin, x, y);
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLButtonElement>) => {
      pinPress.current = null;
      e.currentTarget.classList.remove('is-dragging');
      e.currentTarget.style.left = `${pin.x * 100}%`;
      e.currentTarget.style.top = `${pin.y * 100}%`;
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      pinAction(pin);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openEditor({ pin, x: pin.x, y: pin.y });
    },
    onFocus: () => {
      // Reached with Tab, a pin can be outside the view.
      if (!imageSize) return;
      const size = viewSize();
      const at = fractionToScreen(view.current, imageSize, pin.x, pin.y);
      if (at.x < 0 || at.y < 0 || at.x > size.width || at.y > size.height) {
        moveTo(centerOnFraction(view.current, imageSize, size, pin.x, pin.y));
      }
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      // Alt+Left is Back, and Ctrl+Backspace belongs to whatever is focused next.
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const step = e.shiftKey ? NUDGE_FAR : NUDGE;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = moves[e.key];
      if (move) {
        e.preventDefault();
        e.stopPropagation();
        const x = clampFraction(pin.x + move[0]);
        const y = clampFraction(pin.y + move[1]);
        setPins((list) => list.map((p) => (p.id === pin.id ? { ...p, x, y } : p)));
        // The saver holds one change, so another pin's has to go first.
        if (lastNudged.current !== pin.id) void nudgeSaver.flush();
        lastNudged.current = pin.id;
        nudgeSaver.schedule({ id: pin.id, x, y });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        void deletePin(pin);
      } else if (e.key === 'e' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        openEditor({ pin, x: pin.x, y: pin.y });
      }
    },
  });

  const addAtCenter = () => {
    if (!imageSize) return;
    const size = viewSize();
    const point = screenToFraction(view.current, imageSize, size.width / 2, size.height / 2);
    openEditor({ pin: null, x: clampFraction(point.x), y: clampFraction(point.y) });
  };

  const sortedPins = [...pins].sort((a, b) => pinName(a).localeCompare(pinName(b)));

  return (
    <div className="map-layout">
      <div className="map-frame">
        <div className="atlas-toolbar map-toolbar" role="toolbar" aria-label={t('Map tools')}>
          <button type="button" className="btn btn-sm" disabled={!imageSize} onClick={addAtCenter}>{t('Add pin')}</button>
          <span className="atlas-toolbar-spacer" />
          <label className="map-toggle">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
            {t('Labels')}
          </label>
          <label className="map-toggle">
            <input type="checkbox" checked={showList} onChange={(e) => setShowList(e.target.checked)} />
            {t('Pin list')}
          </label>
          <button type="button" className="btn btn-sm" aria-label={t('Zoom out')} onClick={() => zoomBy(1 / BUTTON_ZOOM_FACTOR)}>−</button>
          <button type="button" className="btn btn-sm" aria-label={t('Zoom in')} onClick={() => zoomBy(BUTTON_ZOOM_FACTOR)}>+</button>
          <button type="button" className="btn btn-sm" onClick={fit}>{t('Fit')}</button>
        </div>
        <div className="map-stage-frame">
          <div
            ref={viewportBox}
            className={`map-viewport${showLabels ? '' : ' hide-labels'}`}
            tabIndex={0}
            role="application"
            aria-label={t(
              'Map of {name}. Arrow keys move the map, plus and minus zoom, and 0 fits. Use Add pin to place a pin, and Tab to reach pins.',
              { name: map.title },
            )}
            data-testid="map-viewport"
            onPointerDown={onMapPointerDown}
            onPointerMove={onMapPointerMove}
            onPointerUp={onMapPointerUp}
            onPointerCancel={(e) => {
              press.current = null;
              e.currentTarget.classList.remove('is-panning');
            }}
            onKeyDown={(e) => {
              if (e.ctrlKey || e.altKey || e.metaKey || !imageSize) return;
              const pan = (dx: number, dy: number) =>
                moveTo(
                  clampViewport(
                    { k: view.current.k, tx: view.current.tx + dx, ty: view.current.ty + dy },
                    imageSize,
                    viewSize(),
                  ),
                );
              switch (e.key) {
                case 'ArrowLeft':
                  pan(KEY_PAN_PX, 0);
                  break;
                case 'ArrowRight':
                  pan(-KEY_PAN_PX, 0);
                  break;
                case 'ArrowUp':
                  pan(0, KEY_PAN_PX);
                  break;
                case 'ArrowDown':
                  pan(0, -KEY_PAN_PX);
                  break;
                case '+':
                case '=':
                  zoomBy(BUTTON_ZOOM_FACTOR);
                  break;
                case '-':
                case '_':
                  zoomBy(1 / BUTTON_ZOOM_FACTOR);
                  break;
                case '0':
                  fit();
                  break;
                default:
                  return;
              }
              e.preventDefault();
            }}
          >
            <div
              ref={stage}
              className="map-stage"
              style={imageSize ? { width: imageSize.width, height: imageSize.height } : undefined}
            >
              {url && (
                <img
                  className="map-image"
                  src={url}
                  alt=""
                  draggable={false}
                  // Hidden until it has been fitted, so it never flashes at full size.
                  style={{ visibility: imageSize ? 'visible' : 'hidden' }}
                  onLoad={(e) =>
                    setImageSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
                  }
                  onError={() => setImageError({ kind: 'broken' })}
                />
              )}
              {imageSize &&
                pins.map((pin) => (
                  <button
                    key={pin.id}
                    type="button"
                    className={`map-pin${pin.pageId && !pin.pageTitle ? ' is-orphan' : ''}${flash === pin.id ? ' is-flash' : ''}`}
                    style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                    aria-label={pinDescription(pin)}
                    title={pin.pageId && !pin.pageTitle ? t('The linked page is in the trash') : undefined}
                    data-pin={pin.id}
                    data-pin-name={pinName(pin)}
                    data-wiki-target={pinOpensPage(pin) ? pin.pageTitle ?? undefined : undefined}
                    {...pinHandlers(pin)}
                  >
                    <span className="map-pin-mark" aria-hidden="true" />
                    <span className="map-pin-label">{pinName(pin)}</span>
                  </button>
                ))}
              {imageSize && editor && !editor.pin && (
                <span
                  className="map-pin is-ghost"
                  aria-hidden="true"
                  style={{ left: `${editor.x * 100}%`, top: `${editor.y * 100}%` }}
                >
                  <span className="map-pin-mark" />
                </span>
              )}
            </div>
          </div>
          {editor && (
            <PinEditor
              key={editor.pin?.id ?? 'new'}
              target={editor}
              style={editorStyle}
              onSave={(choice) => void savePin(choice)}
              onDelete={() => editor.pin && void deletePin(editor.pin)}
              onCancel={closeEditor}
            />
          )}
          {imageError && (
            <div className="map-message" role="alert">{imageProblemText(imageError)}</div>
          )}
          {!imageError && imageSize && pins.length === 0 && !editor && (
            <div className="map-hint">{t('Click anywhere on the map to add a pin.')}</div>
          )}
        </div>
      </div>

      {showList && (
        <aside className="map-side" aria-labelledby="map-pins-title">
          <h2 id="map-pins-title" className="map-side-title">
            {pins.length > 0 ? t('Pins ({count})', { count: pins.length }) : t('Pins')}
          </h2>
          {pins.length === 0 ? (
            <p className="muted map-side-empty">
              {t('No pins yet. A pin marks a place on the map and can link to a page, or carry a label of its own.')}
            </p>
          ) : (
            <ul className="map-pin-list">
              {sortedPins.map((pin) => (
                <li key={pin.id} className="map-pin-row" data-pin-row={pinName(pin)}>
                  {pin.pageType ? <TypeMark pageType={pin.pageType} /> : <span className="map-pin-row-dot" aria-hidden="true" />}
                  <button
                    type="button"
                    className="link-button map-pin-row-name truncate"
                    title={t('Show on the map')}
                    aria-label={t('Show {name} on the map', { name: pinName(pin) })}
                    onClick={() => centerOnPin(pin)}
                  >
                    {pinName(pin)}
                  </button>
                  {pinOpensPage(pin) && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={t('Open the page {name}', { name: pinName(pin) })}
                      onClick={() => pin.pageId && go({ view: 'page', id: pin.pageId })}
                    >
                      {t('Open')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('Edit the pin {name}', { name: pinName(pin) })}
                    onClick={() => {
                      centerOnPin(pin);
                      openEditor({ pin, x: pin.x, y: pin.y });
                    }}
                  >
                    {t('Edit')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('Delete the pin {name}', { name: pinName(pin) })}
                    onClick={() => void deletePin(pin)}
                  >
                    {t('Delete')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}
