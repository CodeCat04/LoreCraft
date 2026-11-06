/**
 * Adding media to a document. While a file uploads, a placeholder shows its progress where
 * the figure will go. It is only a decoration, so it can never reach the stored document,
 * and the writer can keep typing around it. The figure itself goes in at the end.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import * as api from '../../lib/api';
import { linkVideo, uploadAsset, uploadPath, type AssetInfo, type UploadOptions } from '../../lib/assets';
import { errorMessage } from '../../lib/rpc';
import { VIDEO_FILTERS } from '../../media/filters';
import { formatBytes } from '../../media/format';
import { mightBeMedia, sniffMedia, SNIFF_BYTES, SUPPORTED_TEXT } from '../../media/sniff';
import { choose } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { t } from '../../lib/i18n';
import { createFigure, insertFigureTr, nearestFigurePos, type NewFigure } from './commands';

/** Over this, a dropped video asks before making the project and every save that much larger. */
export const LARGE_VIDEO_BYTES = 500 * 1024 * 1024;

type Source =
  | { type: 'file'; file: File }
  | { type: 'path'; path: string }
  | { type: 'link'; path: string };

interface Job {
  id: number;
  name: string;
  source: Source;
  abort: AbortController;
  dom: HTMLElement;
  setProgress: (fraction: number) => void;
  setStatus: (text: string) => void;
}

type PlaceholderAction = { add: { id: number; pos: number; dom: HTMLElement }[] } | { remove: number };

const key = new PluginKey<DecorationSet>('figureUploads');

let nextJobId = 1;
const jobsByView = new WeakMap<EditorView, Set<Job>>();

function jobsOf(view: EditorView): Set<Job> {
  let jobs = jobsByView.get(view);
  if (!jobs) {
    jobs = new Set();
    jobsByView.set(view, jobs);
  }
  return jobs;
}

export function uploadsPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, previous) {
        let set = previous.map(tr.mapping, tr.doc);
        const action = tr.getMeta(key) as PlaceholderAction | undefined;
        if (action && 'add' in action) {
          set = set.add(
            tr.doc,
            action.add.map(({ id, pos, dom }) =>
              // Side 1 keeps later files after the figures of earlier ones at the same place.
              Decoration.widget(pos, dom, { id, side: 1, ignoreSelection: true, stopEvent: () => true }),
            ),
          );
        } else if (action) {
          set = set.remove(set.find(undefined, undefined, (spec) => spec.id === action.remove));
        }
        return set;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
    view: (view) => ({
      // A closed page has nowhere to put the figure, so its uploads stop.
      destroy() {
        const jobs = [...jobsOf(view)];
        jobs.forEach((job) => job.abort.abort());
        if (jobs.length > 0) {
          const names = jobs.map((job) => job.name).join(', ');
          toast(t('Stopped adding {names}, because its page was closed.', { names }), 'info');
        }
      },
    }),
  });
}

function placeholderDom(job: Pick<Job, 'name' | 'abort'>) {
  const dom = document.createElement('div');
  dom.className = 'figure figure-upload';
  dom.dataset.align = 'right';
  dom.contentEditable = 'false';

  const name = document.createElement('div');
  name.className = 'figure-upload-name';
  name.textContent = job.name;
  name.title = job.name;

  const bar = document.createElement('div');
  bar.className = 'figure-upload-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', t('Adding {name}', { name: job.name }));
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  const fill = document.createElement('span');
  bar.append(fill);

  const row = document.createElement('div');
  row.className = 'figure-upload-row';
  const status = document.createElement('span');
  status.className = 'figure-upload-status';
  status.textContent = t('Waiting…');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'link-button figure-upload-cancel';
  cancel.textContent = t('Cancel');
  cancel.addEventListener('click', () => job.abort.abort());
  row.append(status, cancel);

  dom.append(name, bar, row);
  return {
    dom,
    setProgress: (fraction: number) => {
      const percent = Math.round(fraction * 100);
      fill.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
    },
    setStatus: (text: string) => {
      status.textContent = text;
    },
  };
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function figureFor(asset: AssetInfo): NewFigure {
  if (asset.kind === 'image') {
    return {
      kind: 'picture',
      media: {
        type: 'image',
        attrs: { assetId: asset.id, width: asset.width, height: asset.height },
      },
    };
  }
  return { kind: 'video', media: { type: 'video', attrs: { assetId: asset.id } } };
}

function askAboutLargeVideo(file: File): Promise<'embed' | 'link' | 'cancel'> {
  return choose({
    title: t('{name} is {size}', { name: file.name, size: formatBytes(file.size) }),
    message: t(
      'Embedding it makes the project file and every save that much larger. Linking keeps the project small, but a linked file will not travel with the project. To link, you will be asked to find the file, because a drop does not say where it is.',
    ),
    dismissValue: 'cancel' as const,
    choices: [
      { label: t('Cancel'), value: 'cancel' as const },
      { label: t('Link to the file…'), value: 'link' as const },
      { label: t('Embed anyway'), value: 'embed' as const, tone: 'primary' as const },
    ],
  });
}

async function linkAndWarn(path: string): Promise<AssetInfo> {
  const asset = await linkVideo(path);
  toast(t('Linked to {name}. It stays where it is, so it will not travel with the project.', { name: asset.name }), 'info');
  return asset;
}

/** Gets the job's media into the project. Null if the writer changed their mind. */
async function assetForJob(job: Job): Promise<AssetInfo | null> {
  const options: UploadOptions = {
    signal: job.abort.signal,
    onProgress: (fraction, phase) => {
      job.setProgress(fraction);
      job.setStatus(phase === 'verifying' ? t('Checking…') : t('Adding, {percent}%', { percent: Math.round(fraction * 100) }));
    },
  };
  const { source } = job;
  if (source.type === 'link') return linkAndWarn(source.path);
  if (source.type === 'path') return uploadPath(source.path, options);

  const { file } = source;
  if (file.size > LARGE_VIDEO_BYTES) {
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    if (sniffMedia(head)?.kind === 'video') {
      job.setStatus(t('Waiting for your answer…'));
      const answer = await askAboutLargeVideo(file);
      if (answer === 'cancel') return null;
      if (answer === 'link') {
        const picked = await api.files.pickOpen({
          title: t('Find {name}', { name: file.name }),
          defaultName: file.name,
          filters: VIDEO_FILTERS,
        });
        return picked.length > 0 ? linkAndWarn(picked[0]) : null;
      }
    }
  }
  return uploadAsset(file, options);
}

function removePlaceholder(view: EditorView, job: Job) {
  jobsOf(view).delete(job);
  if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { remove: job.id } satisfies PlaceholderAction));
}

function placeFigure(view: EditorView, job: Job, spec: NewFigure, focusLabel: boolean) {
  jobsOf(view).delete(job);
  if (view.isDestroyed) return;
  const { state } = view;
  const found = key.getState(state)?.find(undefined, undefined, (s) => s.id === job.id) ?? [];
  // The placeholder goes if the text around it is deleted. The figure still has to land.
  const at = nearestFigurePos(state.doc, found[0]?.from ?? state.selection.from);
  const tr = insertFigureTr(state.tr, at, createFigure(state.schema, spec), focusLabel);
  view.dispatch(tr.setMeta(key, { remove: job.id } satisfies PlaceholderAction));
  if (focusLabel) view.focus();
}

/** One at a time, in the order they arrived, so figures land in order and writes stay short. */
let queue: Promise<unknown> = Promise.resolve();

function runJob(view: EditorView, job: Job, shouldFocusLabel: () => boolean) {
  queue = queue
    .then(async () => {
      try {
        job.abort.signal.throwIfAborted();
        job.setStatus(t('Adding…'));
        const asset = await assetForJob(job);
        if (asset) placeFigure(view, job, figureFor(asset), shouldFocusLabel());
        else removePlaceholder(view, job);
      } catch (e) {
        removePlaceholder(view, job);
        if (!isAbort(e)) toast(t('Could not add {name}: {error}', { name: job.name, error: errorMessage(e) }), 'error');
      }
    })
    // Whatever happened to this one, the next still runs.
    .catch(() => {});
}

function nameOf(source: Source): string {
  if (source.type === 'file') return source.file.name || t('Pasted picture');
  return source.path.split(/[\\/]/).pop() ?? source.path;
}

function addSources(view: EditorView, sources: Source[], pos: number) {
  if (sources.length === 0) return;
  const { state } = view;
  const at = nearestFigurePos(state.doc, pos);
  const jobs = sources.map((source): Job => {
    const abort = new AbortController();
    const name = nameOf(source);
    const { dom, setProgress, setStatus } = placeholderDom({ name, abort });
    return { id: nextJobId++, name, source, abort, dom, setProgress, setStatus };
  });
  jobs.forEach((job) => jobsOf(view).add(job));
  view.dispatch(
    state.tr.setMeta(key, {
      add: jobs.map((job) => ({ id: job.id, pos: at, dom: job.dom })),
    } satisfies PlaceholderAction),
  );

  // Labeling comes right after adding, unless the writer has since moved on to something
  // else. A long upload must not pull the cursor out of what they are typing.
  const startDoc = view.state.doc;
  const startSelection = view.state.selection;
  let offered = false;
  const shouldFocusLabel = () => {
    if (offered) return false;
    offered = true;
    const active = document.activeElement;
    const typingElsewhere = active !== view.dom && !!active?.matches('input, textarea, select, [contenteditable="true"]');
    return !typingElsewhere && view.state.doc.eq(startDoc) && view.state.selection.eq(startSelection);
  };
  jobs.forEach((job) => runJob(view, job, shouldFocusLabel));
}

/** Adds dropped or pasted files at the nearest place to `pos`. Anything we refuse is explained. */
export function addFiles(view: EditorView, files: File[], pos: number) {
  const accepted = files.filter((file) => {
    if (mightBeMedia(file)) return true;
    toast(`${t('{name} cannot be embedded.', { name: file.name })} ${SUPPORTED_TEXT}`, 'error');
    return false;
  });
  addSources(view, accepted.map((file) => ({ type: 'file', file })), pos);
}

/** Embeds files chosen in a dialog. */
export function addPaths(view: EditorView, paths: string[], pos: number) {
  addSources(view, paths.map((path) => ({ type: 'path', path })), pos);
}

/** Links a video chosen in a dialog, where it is. */
export function addLinkedVideo(view: EditorView, path: string, pos: number) {
  addSources(view, [{ type: 'link', path }], pos);
}

/** Adds a figure of something already stored, so nothing is stored twice. */
export function addExistingMedia(view: EditorView, asset: AssetInfo, pos: number) {
  const { state } = view;
  const at = nearestFigurePos(state.doc, pos);
  const figure = createFigure(state.schema, {
    ...figureFor(asset),
    caption: asset.label || undefined,
    description: asset.description || undefined,
  });
  view.dispatch(insertFigureTr(state.tr, at, figure, true));
  view.focus();
}

/** Adds a reference to a video on the web. Nothing is loaded from it. */
export function addVideoLink(view: EditorView, url: string, pos: number) {
  const { state } = view;
  const at = nearestFigurePos(state.doc, pos);
  const figure = createFigure(state.schema, {
    kind: 'video',
    media: { type: 'video', attrs: { url } },
  });
  view.dispatch(insertFigureTr(state.tr, at, figure, true));
  view.focus();
}
