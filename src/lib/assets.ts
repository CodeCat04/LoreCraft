/**
 * Project pictures and videos. Bytes are stored in chunks by the native side and reach the
 * web view through the `lbasset` scheme, so nothing large crosses the RPC as base64. See
 * docs/ARCHITECTURE.md, "Media".
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';

import { hashFile } from '../media/hash';
import { measureFile, measureUrl, type Measure } from '../media/measure';
import { FIGURE_KINDS, refusalFor, sniffMedia, SNIFF_BYTES, type MediaKind } from '../media/sniff';
import { RpcError, rpc } from './rpc';

const SCHEME = 'lbasset';

/** What the native side knows about an asset. */
export interface AssetInfo {
  id: string;
  name: string;
  mime: string;
  kind: MediaKind;
  size: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  /** Streamed from a file on disk rather than stored in the project. */
  linked: boolean;
  path: string | null;
  /** A linked file that cannot be reached right now. */
  missing: boolean;
  createdAt: string;
  /** Set in the media library, to start off any new figure of this asset. */
  label: string;
  description: string;
}

export interface UploadedAsset extends AssetInfo {
  /** The project already held these exact bytes, so this is the earlier asset. */
  deduped: boolean;
}

export interface UploadOptions {
  /** Called with 0 to 1 as chunks are stored, and with `verifying` once they all are. */
  onProgress?: (fraction: number, phase: 'uploading' | 'verifying') => void;
  signal?: AbortSignal;
  /** What may be stored. Pages take pictures and videos, which is the default. */
  kinds?: readonly MediaKind[];
}

function asRpcError(e: unknown): unknown {
  const err = e as { code?: string; message?: string };
  return typeof err === 'object' && err?.code ? new RpcError(err.code, err.message ?? 'Something went wrong.') : e;
}

/**
 * How many times each asset has had its bytes replaced in this session. Replacing keeps the
 * id, so the count goes into the URL: the web view caches pictures by address and would
 * otherwise keep showing the old one.
 */
const revisions = new Map<string, number>();
const changeListeners = new Set<(id: string) => void>();

/** A displayable URL for an asset. It changes when the asset's bytes are replaced. */
export function assetUrlNow(id: string): string {
  const url = convertFileSrc(id, SCHEME);
  const revision = revisions.get(id);
  return revision ? `${url}?v=${revision}` : url;
}

/** Says an asset now holds other bytes, so everything showing it fetches them again. */
export function noteAssetChanged(id: string) {
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
  for (const listener of [...changeListeners]) listener(id);
}

/** Calls `listener` with an id whenever that asset's bytes change. Returns a way to stop. */
export function onAssetChanged(listener: (id: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** The same, for callers written when finding one took time. */
export function assetUrl(id: string): Promise<string> {
  return Promise.resolve(assetUrlNow(id));
}

/** Kept for callers from when URLs were blobs. A URL now holds nothing that needs releasing. */
export function clearAssetCache() {}

export function assetInfo(id: string): Promise<AssetInfo> {
  return rpc<AssetInfo>('media.get', { id });
}

async function withUpload<T>(
  begin: () => Promise<{ id: string; chunkSize: number }>,
  options: UploadOptions,
  run: (id: string, chunkSize: number, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted();
  const { id, chunkSize } = await begin();
  try {
    return await run(id, chunkSize, options.signal);
  } catch (e) {
    // The native side may already have dropped it, which is fine.
    await rpc('media.uploadCancel', { id }).catch(() => {});
    throw e;
  }
}

/**
 * Stores a file in the project, chunk by chunk, and returns the asset. Throws if the file
 * is not an allowed type or does not arrive intact. If the project already has the same
 * bytes, returns that asset instead of storing them twice.
 */
export async function uploadAsset(file: File, options: UploadOptions = {}): Promise<UploadedAsset> {
  const head = await file
    .slice(0, SNIFF_BYTES)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer))
    .catch(() => {
      throw new RpcError('IO', `${file.name} could not be read. It may be a folder, or in use by another program.`);
    });
  const refusal = refusalFor(file.name, file.type, head, options.kinds ?? FIGURE_KINDS);
  const found = sniffMedia(head);
  if (refusal || !found) throw new RpcError('UNSUPPORTED_MEDIA', refusal ?? `${file.name} is not supported.`);
  const measured: Measure = await measureFile(file, found.kind);

  const hash = hashFile(file);
  try {
    return await withUpload(
      () => rpc('media.uploadBegin', { name: file.name, mime: file.type, size: file.size }),
      options,
      async (id, chunkSize, signal) => {
        let index = 0;
        for (let offset = 0; offset < file.size; offset += chunkSize, index += 1) {
          signal?.throwIfAborted();
          const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer();
          try {
            await invoke('media_upload_chunk', bytes, {
              headers: { 'x-asset-id': id, 'x-chunk-index': String(index) },
            });
          } catch (e) {
            throw asRpcError(e);
          }
          options.onProgress?.(Math.min(1, (offset + chunkSize) / file.size), 'uploading');
        }
        options.onProgress?.(1, 'verifying');
        const sha256 = await hash.done;
        signal?.throwIfAborted();
        return rpc<UploadedAsset>('media.uploadFinish', { id, sha256, ...measured });
      },
    );
  } finally {
    hash.cancel();
  }
}

/** The same as `uploadAsset`, for a file chosen in a dialog. The bytes never enter the web view. */
export async function uploadPath(path: string, options: UploadOptions = {}): Promise<UploadedAsset> {
  const inspected = await rpc<{ name: string; size: number; mime: string; kind: MediaKind }>(
    'media.inspectPath',
    { path },
  );
  if (!(options.kinds ?? FIGURE_KINDS).includes(inspected.kind)) {
    throw new RpcError('UNSUPPORTED_MEDIA', refusalFor(inspected.name, inspected.mime, new Uint8Array(), options.kinds ?? FIGURE_KINDS) ?? `${inspected.name} is not supported.`);
  }
  const asset = await withUpload(
    () => rpc('media.uploadBegin', { name: inspected.name, mime: inspected.mime, size: inspected.size }),
    options,
    async (id, chunkSize, signal) => {
      const count = Math.ceil(inspected.size / chunkSize);
      for (let index = 0; index < count; index += 1) {
        signal?.throwIfAborted();
        await rpc('media.uploadChunkFromPath', { id, index, path });
        options.onProgress?.((index + 1) / count, 'uploading');
      }
      options.onProgress?.(1, 'verifying');
      return rpc<UploadedAsset>('media.uploadFinish', { id, sourcePath: path });
    },
  );
  return fillMeasure(asset);
}

/** Links a video where it is on disk, so the project stays small. The path comes from a dialog. */
export async function linkVideo(path: string): Promise<AssetInfo> {
  return fillMeasure(await rpc<AssetInfo>('media.link', { path }));
}

/** Points a linked video at a new file. The path comes from a dialog. */
export function relinkVideo(id: string, path: string): Promise<AssetInfo> {
  return rpc<AssetInfo>('media.relink', { id, path });
}

/** Without a `File` in hand, size and length have to come from the stored copy. */
async function fillMeasure<T extends AssetInfo>(asset: T): Promise<T> {
  if (asset.width || asset.duration) return asset;
  const measured = await measureUrl(await assetUrl(asset.id), asset.kind);
  if (measured.width === undefined && measured.duration === undefined) return asset;
  await rpc('media.setMeasure', { id: asset.id, ...measured }).catch(() => {});
  return {
    ...asset,
    width: measured.width ?? asset.width,
    height: measured.height ?? asset.height,
    duration: measured.duration ?? asset.duration,
  };
}

/** Stores a picture or video in the project and returns its id. */
export async function addAsset(file: File): Promise<string> {
  return (await uploadAsset(file)).id;
}

const READ_PIECE_BYTES = 4 * 1024 * 1024;

/** Reads up to `length` bytes of an asset as raw bytes, with no base64 on the way. */
export async function readAssetRange(id: string, offset: number, length: number): Promise<Uint8Array> {
  try {
    return new Uint8Array(await invoke<ArrayBuffer>('media_read', { id, offset, length }));
  } catch (e) {
    throw asRpcError(e);
  }
}

/**
 * Reads an asset's bytes piece by piece, for exporters. Write each piece out as it comes,
 * so a large video is never in memory all at once. Works for linked files too, and throws
 * an `RpcError` with code `FILE_MISSING` if one cannot be found. Use `assetInfo` for its
 * name and type.
 *
 *     for await (const piece of readAssetChunks(id)) zip.push(piece);
 */
export async function* readAssetChunks(
  id: string,
  pieceBytes = READ_PIECE_BYTES,
): AsyncGenerator<Uint8Array, void, void> {
  let offset = 0;
  for (;;) {
    const piece = await readAssetRange(id, offset, pieceBytes);
    if (piece.length === 0) return;
    yield piece;
    offset += piece.length;
  }
}

/** Whole base64 groups, so that pieces join up into one valid string. */
const BASE64_PIECE_BYTES = 3 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  const batches: string[] = [];
  for (let at = 0; at < bytes.length; at += 0x8000) {
    batches.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)));
  }
  return btoa(batches.join(''));
}

/** A whole asset as base64. For pictures and other small files only. */
export async function readAssetBase64(id: string): Promise<string> {
  const pieces: string[] = [];
  for await (const piece of readAssetChunks(id, BASE64_PIECE_BYTES)) pieces.push(bytesToBase64(piece));
  return pieces.join('');
}

/** Reads a whole asset into memory. For pictures and other small files only. */
export async function readAssetBytes(id: string): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  let total = 0;
  for await (const piece of readAssetChunks(id)) {
    pieces.push(piece);
    total += piece.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
