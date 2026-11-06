/**
 * Showing project images to vision models.
 *
 *   describeImage(assetId, { knownAs: { caption, description } })
 *
 * returns a description of the picture, from a profile that can read images. This is what
 * a "Describe with AI" button calls. Nothing is stored: the caller decides what to do with
 * the text, such as offering it for the figure's description.
 */

import { AiError, allProfiles, complete, profileForTask, providerLabel, type AiResult } from './client';
import { readAsset, type AssetData } from './assets';
import * as api from './api';
import { canSendTo } from './limits/localOnly';
import type { AiProfile } from '../lib/settings';
import type { ImageBlock } from './types';
import { t } from '../lib/i18n';

export interface DescribeImageOptions {
  /** Which profile to use. By default the chat profile, or a local one that can read images. */
  profileId?: string;
  /** What to ask, replacing the default request for a description. */
  prompt?: string;
  /** What the writer has said about it, so the description can build on that. */
  knownAs?: { caption?: string; description?: string; pageTitle?: string };
  /**
   * The picture is on a page or scene marked local only, so only a local profile may see it.
   * A cloud profile is then never chosen, even one named by `profileId`.
   */
  localOnly?: boolean;
  /** Output limit. Thinking counts against it. */
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with the text so far, as it arrives. */
  onText?: (soFar: string) => void;
}

/**
 * Whether a profile can be sent images: its setting if it has one, otherwise yes for cloud
 * providers, and for a local server whatever its `/props` says, or no if it does not say.
 */
export async function profileSupportsImages(profileId: string): Promise<boolean> {
  return (await api.provider.imageSupport(profileId)).supported;
}

const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Providers limit images at about 5 MB. Base64 is a third larger than the bytes. */
const MAX_BASE64_CHARS = 5 * 1024 * 1024;
const MAX_EDGE = 2048;

async function shrink(asset: AssetData): Promise<{ mime: string; base64: string }> {
  const bytes = Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: asset.mime }));
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new AiError('INTERNAL', t('Could not prepare that image.'));
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  return { mime: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

/**
 * An asset as an image block a provider will accept. A large image or an unusual format
 * is converted. The stored asset is not changed.
 */
export async function assetToImageBlock(assetId: string): Promise<ImageBlock> {
  const asset = await readAsset(assetId);
  const tooLarge = asset.base64.length > MAX_BASE64_CHARS || (asset.width ?? 0) > MAX_EDGE || (asset.height ?? 0) > MAX_EDGE;
  if (SENDABLE.has(asset.mime) && !tooLarge) {
    return { type: 'image', mime: asset.mime, base64: asset.base64 };
  }
  const { mime, base64 } = await shrink(asset);
  return { type: 'image', mime, base64 };
}

async function chooseProfile(options: DescribeImageOptions): Promise<AiProfile> {
  const wanted = profileForTask('chat', options.profileId);
  const allowed = canSendTo(wanted, { localOnly: options.localOnly });
  if (allowed && (await profileSupportsImages(wanted.id))) return wanted;
  if (!options.profileId || !allowed) {
    // A picture should not go to a cloud provider just because the usual profile cannot
    // read it, so only local ones are tried in its place.
    for (const profile of allProfiles()) {
      if (profile.id !== wanted.id && !profile.isCloud && (await profileSupportsImages(profile.id))) return profile;
    }
  }
  if (!allowed) {
    throw new AiError(
      'LOCAL_ONLY',
      t('This picture is on a page or scene marked local only, so it can only go to a local profile that can read images. Add one in Settings > AI, or turn on "Can read images" for one.'),
    );
  }
  throw new AiError(
    'IMAGES_NOT_SUPPORTED',
    t('{profile} cannot read images. Choose another profile, or turn on "Can read images" for it in Settings > AI.', {
      profile: wanted.name || providerLabel(wanted),
    }),
  );
}

function describePrompt(options: DescribeImageOptions): string {
  const known = options.knownAs;
  const parts = [
    options.prompt ??
      'Describe this picture for a writer keeping notes on their world: who or what is shown, the setting, and any details someone might need later. Reply with only the description, in two or three sentences.',
  ];
  if (known?.pageTitle) parts.push(`It appears on the page "${known.pageTitle}".`);
  if (known?.caption) parts.push(`The writer's label for it: ${known.caption}`);
  if (known?.description) parts.push(`The writer's existing notes on it: ${known.description}`);
  return parts.join('\n\n');
}

/**
 * Asks a vision model what a project image shows. Rejects with an `AiError`, using the code
 * `IMAGES_NOT_SUPPORTED` if no suitable profile can read images, or `LOCAL_ONLY` if the
 * picture is local only and no local profile can read it. A cloud provider asks for
 * permission first, and spending limits apply, as with any other request.
 */
export async function describeImage(assetId: string, options: DescribeImageOptions = {}): Promise<string> {
  const profile = await chooseProfile(options);
  const image = await assetToImageBlock(assetId);
  let soFar = '';
  const result: AiResult = await complete(
    {
      task: 'chat',
      profileId: profile.id,
      maxTokens: options.maxTokens,
      signal: options.signal,
      messages: [{ role: 'user', content: [image, { type: 'text', text: describePrompt(options) }] }],
    },
    {
      onText: (text) => {
        soFar += text;
        options.onText?.(soFar);
      },
    },
  );
  return result.text.trim();
}
