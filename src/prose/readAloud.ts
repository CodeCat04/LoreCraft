/**
 * Reading aloud through the system's speech voices. It says one sentence at a time, which
 * shows exactly where it has got to, and avoids browsers cutting off long utterances.
 * The text is read from the editor as each sentence comes up, so edits are followed.
 */

import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { create } from 'zustand';

import { segmentsFromDoc, sentenceRanges } from './analyze';
import { setReadingRange, type ProseRange } from './highlights';
import { scrollToPos } from '../editor/comments/extension';
import type { PmNode } from '../lib/types';

export interface VoiceChoice {
  uri: string;
  name: string;
  lang: string;
}

interface ReadAloudState {
  /** The browser has speech at all. */
  supported: boolean;
  voices: VoiceChoice[];
  /** Voices can arrive late, so an empty list means nothing until this is set. */
  voicesKnown: boolean;
  voiceUri: string | null;
  rate: number;
  status: 'idle' | 'speaking' | 'paused';
  /** The speech engine's error code, put into words where it is shown. */
  problem: string | null;
}

const PREFS_KEY = 'prose.speech';
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
/** How long to wait for voices before saying there are none. */
const VOICES_WAIT_MS = 3000;

function loadPrefs(): { voiceUri: string | null; rate: number } {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { voiceUri?: string; rate?: number };
    return {
      voiceUri: stored.voiceUri ?? null,
      rate: stored.rate && RATES.includes(stored.rate) ? stored.rate : 1,
    };
  } catch {
    return { voiceUri: null, rate: 1 };
  }
}

function savePrefs() {
  const { voiceUri, rate } = useReadAloud.getState();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ voiceUri, rate }));
  } catch {
    // It only means the choice is not remembered next time.
  }
}

export const useReadAloud = create<ReadAloudState>(() => ({
  supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
  voices: [],
  voicesKnown: false,
  ...loadPrefs(),
  status: 'idle',
  problem: null,
}));

let watchingVoices = false;

/** Starts watching for voices. Safe to call more than once. */
export function watchVoices() {
  if (watchingVoices || !useReadAloud.getState().supported) {
    if (!useReadAloud.getState().supported) useReadAloud.setState({ voicesKnown: true });
    return;
  }
  watchingVoices = true;
  const read = () => {
    const voices = window.speechSynthesis.getVoices().map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang }));
    useReadAloud.setState(voices.length > 0 ? { voices, voicesKnown: true } : { voices });
  };
  read();
  window.speechSynthesis.addEventListener('voiceschanged', read);
  window.setTimeout(() => useReadAloud.setState({ voicesKnown: true }), VOICES_WAIT_MS);
}

export function setVoice(uri: string) {
  useReadAloud.setState({ voiceUri: uri });
  savePrefs();
}

/** Takes effect from the next sentence. */
export function setRate(rate: number) {
  useReadAloud.setState({ rate });
  savePrefs();
}

// ---- One reading ----------------------------------------------------------------

interface Reading {
  editor: Editor;
  ranges: ProseRange[];
  index: number;
  /** Held on to, because a browser can lose an utterance's events once nothing refers to it. */
  utterance: SpeechSynthesisUtterance | null;
  onTransaction: (props: { transaction: Transaction }) => void;
  onDestroy: () => void;
}

let reading: Reading | null = null;

function finish() {
  const current = reading;
  reading = null;
  if (current) {
    current.editor.off('transaction', current.onTransaction);
    current.editor.off('destroy', current.onDestroy);
    if (!current.editor.isDestroyed) setReadingRange(current.editor, null);
  }
  useReadAloud.setState({ status: 'idle' });
}

/** The sentences from the cursor, or those inside the selection, in document positions. */
export function rangesToRead(doc: PmNode, from: number, to: number, hasSelection: boolean): ProseRange[] {
  const out: ProseRange[] = [];
  for (const range of sentenceRanges(segmentsFromDoc(doc))) {
    if (range.to <= from || range.from >= to) continue;
    if (hasSelection) out.push({ from: Math.max(range.from, from), to: Math.min(range.to, to) });
    // A cursor in the middle of a sentence starts it from the top.
    else out.push(range);
  }
  return out;
}

function chosenVoice(): SpeechSynthesisVoice | null {
  const { voiceUri } = useReadAloud.getState();
  return window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceUri) ?? null;
}

function speakNext(session: Reading) {
  if (reading !== session || session.editor.isDestroyed) return;
  while (session.index < session.ranges.length) {
    const range = session.ranges[session.index];
    const text = range.from < range.to ? session.editor.state.doc.textBetween(range.from, range.to, ' ', ' ').trim() : '';
    if (text) {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = chosenVoice();
      if (voice) utterance.voice = voice;
      utterance.rate = useReadAloud.getState().rate;
      utterance.onstart = () => {
        if (reading !== session) return;
        setReadingRange(session.editor, session.ranges[session.index]);
        scrollToPos(session.editor, range.from);
      };
      utterance.onend = () => {
        if (reading !== session) return;
        session.index += 1;
        speakNext(session);
      };
      utterance.onerror = (event) => {
        if (reading !== session) return;
        // Stopping a voice reports itself as an error too.
        if (event.error !== 'canceled' && event.error !== 'interrupted') {
          useReadAloud.setState({ problem: event.error });
        }
        finish();
      };
      session.utterance = utterance;
      window.speechSynthesis.speak(utterance);
      return;
    }
    session.index += 1;
  }
  finish();
}

/** Reads the selection, or the document from the cursor. False if there is nothing to read. */
export function startReading(editor: Editor): boolean {
  const { supported } = useReadAloud.getState();
  if (!supported) return false;
  stopReading();
  const { selection, doc } = editor.state;
  const ranges = selection.empty
    ? rangesToRead(editor.getJSON() as PmNode, selection.from, doc.content.size + 1, false)
    : rangesToRead(editor.getJSON() as PmNode, selection.from, selection.to, true);
  if (ranges.length === 0) return false;
  const session: Reading = {
    editor,
    ranges,
    index: 0,
    utterance: null,
    onTransaction: ({ transaction }) => {
      if (!transaction.docChanged) return;
      session.ranges = session.ranges.map((range) => ({
        from: transaction.mapping.map(range.from, 1),
        to: transaction.mapping.map(range.to, -1),
      }));
    },
    onDestroy: () => stopReading(),
  };
  reading = session;
  editor.on('transaction', session.onTransaction);
  editor.on('destroy', session.onDestroy);
  useReadAloud.setState({ status: 'speaking', problem: null });
  speakNext(session);
  return true;
}

export function pauseReading() {
  if (!reading) return;
  window.speechSynthesis.pause();
  useReadAloud.setState({ status: 'paused' });
}

export function resumeReading() {
  if (!reading) return;
  window.speechSynthesis.resume();
  useReadAloud.setState({ status: 'speaking' });
}

export function stopReading() {
  if (!useReadAloud.getState().supported) return;
  const wasReading = reading !== null;
  // The session goes first, so the cancel's events have nobody left to tell.
  const current = reading;
  reading = null;
  if (current) {
    current.editor.off('transaction', current.onTransaction);
    current.editor.off('destroy', current.onDestroy);
    if (!current.editor.isDestroyed) setReadingRange(current.editor, null);
  }
  if (wasReading) {
    // A voice stopped while paused can otherwise stay stuck and refuse the next reading.
    window.speechSynthesis.resume();
    window.speechSynthesis.cancel();
  }
  useReadAloud.setState({ status: 'idle' });
}
