/**
 * Reads a project image's bytes for sending to a vision model. This is the one place
 * the AI module touches asset storage, so a change to that storage changes only this.
 */

import { assetInfo, readAssetBase64 } from '../lib/assets';
import { RpcError } from '../lib/rpc';

export interface AssetData {
  name: string;
  mime: string;
  base64: string;
  width: number | null;
  height: number | null;
}

export async function readAsset(id: string): Promise<AssetData> {
  const info = await assetInfo(id);
  // A vision model reads pictures. A video would only fill memory on its way to a refusal.
  if (info.kind !== 'image') throw new RpcError('UNSUPPORTED_MEDIA', `${info.name} is a video, and only pictures can be read.`);
  const { name, mime, width, height } = info;
  return { name, mime, width, height, base64: await readAssetBase64(id) };
}
