/**
 * What is known about the documents open on screen, across panes and tabs.
 *
 * Claims keep two views of one document from overwriting each other. Whoever edits a document
 * claims it, and only the first in line may edit. The others show a read-only copy until the
 * first lets go, or until the writer asks to edit there instead.
 *
 * Places are where the writer was in a document. They outlive the editor, so that coming back
 * to a tab, or to the app the next day, finds the same spot.
 */

import { useLayoutEffect, useState } from 'react';
import { create } from 'zustand';

interface ClaimStore {
  /** Document key to everyone holding or waiting for it, first in line first. */
  lines: Record<string, number[]>;
}

const useClaims = create<ClaimStore>(() => ({ lines: {} }));

let nextOwner = 0;

function join(key: string, owner: number) {
  useClaims.setState((s) => {
    const line = s.lines[key] ?? [];
    return line.includes(owner) ? s : { lines: { ...s.lines, [key]: [...line, owner] } };
  });
}

function leave(key: string, owner: number) {
  useClaims.setState((s) => {
    const line = s.lines[key] ?? [];
    if (!line.includes(owner)) return s;
    const rest = line.filter((o) => o !== owner);
    const lines = { ...s.lines };
    if (rest.length > 0) lines[key] = rest;
    else delete lines[key];
    return { lines };
  });
}

export type ClaimState = 'free' | 'mine' | 'blocked';

export interface DocClaim {
  state: ClaimState;
  /** Someone else may edit this document, so what this view shows can go out of date. */
  watchOthers: boolean;
  /** Moves this view to the front of the line, so it is the one that may edit. */
  takeOver: () => void;
}

/**
 * Joins the line for a document while `wanted`. Read-only views pass false: they never block
 * anyone, but they still learn whether someone else is editing.
 */
export function useDocClaim(key: string, wanted: boolean): DocClaim {
  const [owner] = useState(() => {
    nextOwner += 1;
    return nextOwner;
  });
  // In a layout effect, so that a view never paints as blocked just because it has not asked.
  useLayoutEffect(() => {
    if (wanted) join(key, owner);
    else leave(key, owner);
  }, [key, owner, wanted]);
  useLayoutEffect(() => () => leave(key, owner), [key, owner]);
  const first = useClaims((s) => s.lines[key]?.[0] ?? null);
  const joined = useClaims((s) => s.lines[key]?.includes(owner) ?? false);
  let state: ClaimState = 'free';
  if (wanted && first === owner) state = 'mine';
  else if (wanted && first !== null) state = 'blocked';
  // Not in line yet: the first render, before the effect above has run.
  else if (wanted && !joined) state = 'mine';
  return {
    state,
    watchOthers: first !== null && first !== owner,
    takeOver: () => {
      useClaims.setState((s) => {
        const line = s.lines[key] ?? [];
        return { lines: { ...s.lines, [key]: [owner, ...line.filter((o) => o !== owner)] } };
      });
    },
  };
}

/** True if some view has a claim on this document, meaning it is being edited there. */
export function isDocClaimed(key: string): boolean {
  return (useClaims.getState().lines[key]?.length ?? 0) > 0;
}

export function useIsDocClaimed(key: string | null): boolean {
  return useClaims((s) => (key !== null ? (s.lines[key]?.length ?? 0) > 0 : false));
}

// ---- Places ---------------------------------------------------------------------------------

export interface DocPlace {
  anchor: number;
  head: number;
  /** Negative means no position is known yet, so scroll to the cursor. */
  scrollTop: number;
}

const places = new Map<string, DocPlace>();
/** How far each tab's pane is scrolled, for the screens that use the pane's own scrolling. */
const tabScroll = new Map<string, number>();
const placeListeners = new Set<() => void>();

function placesChanged() {
  placeListeners.forEach((listener) => listener());
}

/** For saving. Called whenever a place changes, which can be many times a second. */
export function subscribePlaces(listener: () => void): () => void {
  placeListeners.add(listener);
  return () => placeListeners.delete(listener);
}

export function docPlace(key: string): DocPlace | undefined {
  return places.get(key);
}

export function setDocPlace(key: string, place: DocPlace) {
  places.set(key, place);
  placesChanged();
}

export function rememberCursorAt(key: string, anchor: number, head: number) {
  const place = places.get(key);
  if (place) {
    place.anchor = anchor;
    place.head = head;
  } else {
    places.set(key, { anchor, head, scrollTop: 0 });
  }
  placesChanged();
}

export function rememberScrollAt(key: string, scrollTop: number) {
  const place = places.get(key);
  if (place) place.scrollTop = scrollTop;
  else places.set(key, { anchor: 0, head: 0, scrollTop });
  placesChanged();
}

export function tabScrollOf(tabId: string): number {
  return tabScroll.get(tabId) ?? 0;
}

export function rememberTabScroll(tabId: string, scrollTop: number) {
  tabScroll.set(tabId, scrollTop);
  placesChanged();
}

/** Every place known, for saving. */
export function allPlaces(): Record<string, DocPlace> {
  return Object.fromEntries(places);
}

/** Forgets everything, and starts again from what was saved, if anything. */
export function resetPlaces(saved?: unknown) {
  places.clear();
  tabScroll.clear();
  if (typeof saved !== 'object' || saved === null) return;
  for (const [key, value] of Object.entries(saved)) {
    const { anchor, head, scrollTop } = (value ?? {}) as Partial<DocPlace>;
    if (typeof anchor === 'number' && typeof head === 'number' && typeof scrollTop === 'number') {
      places.set(key, { anchor, head, scrollTop });
    }
  }
}
