/**
 * Recognizes web addresses of videos. A recognized address becomes a reference card that
 * opens in the browser. Nothing here or there ever loads it: no player, no thumbnail.
 */

export interface VideoLink {
  url: string;
  /** For example "YouTube", or null for a plain link to a video file. */
  site: string | null;
}

const VIDEO_FILE = /\.(mp4|m4v|webm|mov|ogv|mkv|avi|wmv|flv|m3u8|mpd)$/i;

function isDigits(text: string | undefined): boolean {
  return !!text && /^\d+$/.test(text);
}

/** Each known site, with whether a given path on it is a video rather than a channel or a search. */
const SITES: { name: string; hosts: string[]; isVideo: (url: URL, parts: string[]) => boolean }[] = [
  {
    name: 'YouTube',
    hosts: ['youtube.com', 'youtube-nocookie.com'],
    isVideo: (url, parts) =>
      (parts[0] === 'watch' && url.searchParams.has('v')) ||
      (['shorts', 'live', 'embed', 'v', 'e'].includes(parts[0]) && !!parts[1]),
  },
  { name: 'YouTube', hosts: ['youtu.be'], isVideo: (_url, parts) => !!parts[0] },
  {
    name: 'Vimeo',
    hosts: ['vimeo.com'],
    isVideo: (_url, parts) =>
      isDigits(parts[0]) || parts.some((part, i) => i > 0 && isDigits(part) && ['channels', 'groups', 'album', 'showcase', 'video'].includes(parts[0])),
  },
  { name: 'Dailymotion', hosts: ['dailymotion.com'], isVideo: (_url, parts) => parts[0] === 'video' && !!parts[1] },
  { name: 'Dailymotion', hosts: ['dai.ly'], isVideo: (_url, parts) => !!parts[0] },
  { name: 'Twitch', hosts: ['twitch.tv'], isVideo: (_url, parts) => parts.includes('videos') || parts.includes('clip') || parts[0] === 'videos' },
  { name: 'Twitch', hosts: ['clips.twitch.tv'], isVideo: (_url, parts) => !!parts[0] },
  { name: 'TikTok', hosts: ['tiktok.com'], isVideo: (_url, parts) => parts[1] === 'video' && !!parts[2] },
  { name: 'Rumble', hosts: ['rumble.com'], isVideo: (_url, parts) => /^v[a-z0-9]+/i.test(parts[0] ?? '') },
  { name: 'Bilibili', hosts: ['bilibili.com'], isVideo: (_url, parts) => parts[0] === 'video' && !!parts[1] },
  { name: 'Streamable', hosts: ['streamable.com'], isVideo: (_url, parts) => !!parts[0] },
  { name: 'Loom', hosts: ['loom.com'], isVideo: (_url, parts) => parts[0] === 'share' && !!parts[1] },
];

function hostMatches(host: string, known: string): boolean {
  return host === known || host.endsWith(`.${known}`);
}

/** Reads text as one web address. Null for anything else, including other schemes. */
export function parseWebUrl(text: string): URL | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A password in an address is no place to keep one, and it would be stored and shown.
  if (url.username || url.password) return null;
  return url.hostname ? url : null;
}

/** The site a video address belongs to, if we know it. */
export function videoSiteName(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  return SITES.find((site) => site.hosts.some((known) => hostMatches(host, known)))?.name ?? null;
}

/** Null unless the text is one web address recognized as a video. */
export function recognizeVideoUrl(text: string): VideoLink | null {
  const url = parseWebUrl(text);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  for (const site of SITES) {
    if (site.hosts.some((known) => hostMatches(host, known))) {
      return site.isVideo(url, parts) ? { url: url.href, site: site.name } : null;
    }
  }
  return VIDEO_FILE.test(url.pathname) ? { url: url.href, site: null } : null;
}

/** The address a drag or a clipboard carries, if it carries exactly one. */
export function singleUrlFrom(data: { getData: (type: string) => string }): string | null {
  const list = data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (list.length === 1) return list[0];
  if (list.length > 1) return null;
  const plain = data.getData('text/plain').trim();
  return plain && !/\s/.test(plain) ? plain : null;
}
