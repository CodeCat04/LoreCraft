import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const convertFileSrc = vi.fn((id: string, scheme: string) => `http://${scheme}.localhost/${id}`);
vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc }));

const { assetUrl, assetUrlNow, noteAssetChanged, onAssetChanged, readAssetBase64, readAssetBytes, readAssetChunks, readAssetRange } = await import('./assets');

/** Answers `media_read` from these bytes, as the native side does. */
function serve(bytes: Uint8Array) {
  invoke.mockImplementation(async (command: string, args: { offset: number; length: number }) => {
    expect(command).toBe('media_read');
    return bytes.slice(args.offset, args.offset + args.length).buffer;
  });
}

const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

describe('assetUrl', () => {
  it('names the asset on its own scheme', async () => {
    await expect(assetUrl('abc')).resolves.toBe('http://lbasset.localhost/abc');
    expect(convertFileSrc).toHaveBeenCalledWith('abc', 'lbasset');
  });
});

describe('replacing an asset', () => {
  it('gives it a new address and tells whoever shows it', () => {
    const seen: string[] = [];
    const stop = onAssetChanged((id) => seen.push(id));
    expect(assetUrlNow('swap')).toBe('http://lbasset.localhost/swap');
    noteAssetChanged('swap');
    expect(assetUrlNow('swap')).toBe('http://lbasset.localhost/swap?v=1');
    noteAssetChanged('swap');
    expect(assetUrlNow('swap')).toBe('http://lbasset.localhost/swap?v=2');
    expect(assetUrlNow('other')).toBe('http://lbasset.localhost/other');
    stop();
    noteAssetChanged('swap');
    expect(seen).toEqual(['swap', 'swap']);
  });
});

describe('reading an asset', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('returns raw bytes for a range', async () => {
    serve(bytes(100));
    expect(await readAssetRange('id', 10, 5)).toEqual(bytes(100).slice(10, 15));
    expect(invoke).toHaveBeenCalledWith('media_read', { id: 'id', offset: 10, length: 5 });
  });

  it('reads in pieces until nothing is left, and never all at once', async () => {
    const source = bytes(1000);
    serve(source);
    const seen: number[] = [];
    const out: number[] = [];
    for await (const piece of readAssetChunks('id', 300)) {
      seen.push(piece.length);
      out.push(...piece);
    }
    expect(seen).toEqual([300, 300, 300, 100]);
    expect(Uint8Array.from(out)).toEqual(source);
    // The last call, past the end, is how it knows it is finished.
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it('reads nothing from an empty asset', async () => {
    serve(new Uint8Array());
    const pieces = [];
    for await (const piece of readAssetChunks('id')) pieces.push(piece);
    expect(pieces).toEqual([]);
  });

  it('gathers small assets into one array', async () => {
    const source = bytes(10_000);
    serve(source);
    expect(await readAssetBytes('id')).toEqual(source);
  });

  it('joins pieces into one valid base64 string, past where any one piece ends', async () => {
    const source = bytes(3 * 1024 * 1024 + 1000);
    serve(source);
    const decoded = Uint8Array.from(atob(await readAssetBase64('id')), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(source);
  });

  it('passes on what went wrong, by its code', async () => {
    invoke.mockRejectedValue({ code: 'FILE_MISSING', message: 'clip.mp4 cannot be found.' });
    await expect(readAssetRange('id', 0, 1)).rejects.toMatchObject({
      name: 'RpcError',
      code: 'FILE_MISSING',
      message: 'clip.mp4 cannot be found.',
    });
  });
});
