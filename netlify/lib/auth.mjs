import crypto from 'node:crypto';
import { ApiError, getJSON, create, update, remove, now } from './db.mjs';

// Default owner key (hashed, never stored in plain text).
// The owner can change it from Settings; the new hash is then kept in the database.
export const DEFAULT_ADMIN = {
  salt: 'ca8c6f9ab08d4b4267cf2e1c4a0231e4',
  hash: '65b47592386859e190fcadcf500825fa6f7c86314a5e44404bbcfccddfa17998',
};

// Short stable fingerprint of a key. Used as the lookup name, so keys with any characters are safe.
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomId = () => 'a' + crypto.randomBytes(4).toString('hex');

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

export function checkPassword(password, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(String(password), salt, 32).toString('hex'));
  const b = Buffer.from(String(hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- signed session tokens (stateless) ---------------------------------

let secretCache = null;
async function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (secretCache) return secretCache;
  let rec = await getJSON('secret');
  if (!rec) {
    await create('secret', { v: crypto.randomBytes(32).toString('hex') });
    rec = await getJSON('secret');
  }
  secretCache = rec.v;
  return secretCache;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export async function signToken(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export async function readToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < now()) return null;
    return p;
  } catch {
    return null;
  }
}

// ---- brute-force protection ----------------------------------------------

const rlKey = (kind, ip) => `rl/${kind}/${String(ip).replace(/[^0-9a-zA-Z:.]/g, '_').slice(0, 60)}`;

export async function rlCheck(kind, ip) {
  const rec = await getJSON(rlKey(kind, ip));
  if (rec && rec.until > now()) {
    const mins = Math.max(1, Math.ceil((rec.until - now()) / 60000));
    throw new ApiError(429, `Too many attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
}

export async function rlFail(kind, ip, max, windowMs) {
  const t = now();
  await update(rlKey(kind, ip), { n: 0, first: t, until: 0 }, (r) => {
    if (t - r.first > windowMs) {
      r.n = 0;
      r.first = t;
      r.until = 0;
    }
    r.n += 1;
    if (r.n >= max) r.until = t + windowMs;
  });
}

export async function rlClear(kind, ip) {
  try {
    await remove(rlKey(kind, ip));
  } catch {
    /* nothing to clear */
  }
}
