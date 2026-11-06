import { t } from '../lib/i18n';

/** A byte count for people to read, for example "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return t('{size} bytes', { size: bytes });
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < 3) {
    value /= 1024;
    unit += 1;
  }
  const size = value >= 100 ? Math.round(value) : value.toFixed(1);
  if (unit === 0) return t('{size} KB', { size });
  if (unit === 1) return t('{size} MB', { size });
  if (unit === 2) return t('{size} GB', { size });
  return t('{size} TB', { size });
}
