/** Small editor behaviors for writing scenes: end-of-scene keys and typewriter scrolling. */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface SceneKeyOptions {
  /** Ctrl+Enter at the very end of the scene. */
  onEndOfScene: () => void;
  /** The up arrow at the very start of the scene. */
  onLeaveTop: () => void;
}

const sceneKeysKey = new PluginKey('sceneKeys');

/**
 * Runs ahead of the default bindings, where Ctrl+Enter inserts a line break, and steps
 * aside everywhere except the very end of the scene. A key held down makes one scene, not
 * one for every repeat: each new scene is empty, so its end is right there for the next.
 */
export function sceneKeys(options: SceneKeyOptions) {
  return Extension.create({
    name: 'sceneKeys',
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: sceneKeysKey,
          props: {
            handleKeyDown(view, event) {
              const { selection, doc } = view.state;
              if (!selection.empty || event.altKey || event.shiftKey) return false;
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                if (selection.head !== Selection.atEnd(doc).head) return false;
                if (!event.repeat) options.onEndOfScene();
                return true;
              }
              if (event.key === 'ArrowUp' && !event.ctrlKey && !event.metaKey) {
                if (selection.head !== Selection.atStart(doc).head) return false;
                options.onLeaveTop();
                return true;
              }
              return false;
            },
          },
        }),
      ];
    },
  });
}

const scrollRoomKey = new PluginKey('scrollRoom');

/**
 * Keeps the caret clear of the sticky formatting bar when the editor scrolls to it. The
 * bar's height follows the interface size, so this is worked out when a scene opens.
 */
export function scrollRoom() {
  return Extension.create({
    name: 'scrollRoom',
    addProseMirrorPlugins() {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      return [
        new Plugin({
          key: scrollRoomKey,
          props: {
            scrollMargin: { top: Math.round(4 * rem), bottom: Math.round(3 * rem), left: 5, right: 5 },
            scrollThreshold: { top: Math.round(4 * rem), bottom: Math.round(3 * rem), left: 0, right: 0 },
          },
        }),
      ];
    },
  });
}

/** How long after a key press a change still counts as coming from that key. */
const KEY_WINDOW_MS = 200;

const typewriterKey = new PluginKey('typewriterScroll');

/**
 * Keeps the line being written in the middle of the scroll area. It reacts only to the
 * keyboard, and only when the caret is a plain cursor. Scrolling by hand fires nothing,
 * so the page stays put until the next key press, and a click or drag selection never
 * moves the page under the pointer.
 */
export function typewriterScroll(isOn: () => boolean) {
  return Extension.create({
    name: 'typewriterScroll',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: typewriterKey,
          view(view: EditorView) {
            let lastKeyAt = Number.NEGATIVE_INFINITY;
            let pointerDown = false;
            let frame = 0;
            const onKey = () => {
              lastKeyAt = performance.now();
            };
            const onPointerDown = () => {
              pointerDown = true;
              // Whatever changes next comes from the pointer, however soon after a key.
              lastKeyAt = Number.NEGATIVE_INFINITY;
            };
            const onPointerUp = () => {
              pointerDown = false;
            };
            view.dom.addEventListener('keydown', onKey, true);
            view.dom.addEventListener('pointerdown', onPointerDown, true);
            window.addEventListener('pointerup', onPointerUp, true);

            const center = () => {
              frame = 0;
              if (view.isDestroyed) return;
              const scroller = view.dom.closest('.write-scroll');
              if (!scroller) return;
              const { head, empty } = view.state.selection;
              if (!empty) return;
              const caret = view.coordsAtPos(head);
              const box = scroller.getBoundingClientRect();
              const offset = (caret.top + caret.bottom) / 2 - (box.top + box.height / 2);
              if (Math.abs(offset) > 1) scroller.scrollTop += offset;
            };

            return {
              update(updated, previous) {
                if (!isOn() || pointerDown || updated.composing) return;
                if (updated.state.doc === previous.doc && updated.state.selection.eq(previous.selection)) return;
                if (!updated.state.selection.empty) return;
                if (performance.now() - lastKeyAt > KEY_WINDOW_MS) return;
                // Runs just before the frame is drawn, when the layout is needed anyway.
                if (!frame) frame = requestAnimationFrame(center);
              },
              destroy() {
                cancelAnimationFrame(frame);
                view.dom.removeEventListener('keydown', onKey, true);
                view.dom.removeEventListener('pointerdown', onPointerDown, true);
                window.removeEventListener('pointerup', onPointerUp, true);
              },
            };
          },
        }),
      ];
    },
  });
}
