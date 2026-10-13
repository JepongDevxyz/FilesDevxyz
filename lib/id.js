import { randomBytes } from 'node:crypto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;

// 8-char short id from crypto-random bytes. 62^8 ≈ 2.18e14 possibilities,
// so collisions are practically impossible (birthday bound ≈ 15M ids for 50%).
export function genId() {
  const bytes = randomBytes(ID_LENGTH);
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += CHARSET[bytes[i] % CHARSET.length];
  }
  return id;
}

// Make a filename safe for use inside an R2 key: no path separators,
// no leading dots, bounded length.
export function sanitizeFilename(name) {
  let clean = String(name || '')
    .replace(/[/\\]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!clean) clean = 'file';
  if (clean.length > 200) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
    clean = clean.slice(0, 200 - ext.length) + ext;
  }
  return clean;
}
