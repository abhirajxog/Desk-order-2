// Thin storage layer on top of Netlify Blobs.
// Every write that can race uses optimistic concurrency (ETag compare-and-set)
// so two workers can never claim the same order or double-credit a balance.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let factory = async () => {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'panel', consistency: 'strong' });
};
let _store = null;

// Tests plug in an in-memory store here. Production never calls this.
export function setStoreFactory(f) {
  factory = f;
  _store = null;
}

// Never keep the store between requests: Netlify hands each request a short-lived Blobs token,
// and a stored store would keep using an expired one ("Token expired").
async function S() {
  return factory();
}

let clock = () => Date.now();
export const now = () => clock();
export function setClock(f) {
  clock = f;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJSON(key) {
  const s = await S();
  const r = await s.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  return r ? r.data : null;
}

// Create a key only if it does not exist yet. Returns true when created.
export async function create(key, value) {
  const s = await S();
  const r = await s.setJSON(key, value, { onlyIfNew: true });
  return !(r && r.modified === false);
}

export async function remove(key) {
  const s = await S();
  await s.delete(key);
}

export async function listKeys(prefix) {
  const s = await S();
  const r = await s.list({ prefix });
  return (r.blobs || []).map((b) => b.key);
}

// Read-modify-write with retry. `fn` receives a mutable copy of the current
// value (or a copy of `init` when the key is missing). Throw from `fn` to abort
// without writing. Whatever `fn` returns is returned once the write succeeded.
export async function update(key, init, fn) {
  const s = await S();
  for (let attempt = 0; attempt < 14; attempt++) {
    const cur = await s.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const data = cur ? cur.data : JSON.parse(JSON.stringify(init));
    const before = JSON.stringify(data);
    const result = await fn(data);
    if (cur && JSON.stringify(data) === before) return result;
    const r = await s.setJSON(key, data, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (!(r && r.modified === false)) return result;
    await sleep(15 + Math.random() * 60 * (attempt + 1));
  }
  throw new ApiError(503, 'The server is busy. Please try again in a moment.');
}
