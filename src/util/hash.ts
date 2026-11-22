import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * SHA-256 is used for EVERY digest that influences cache correctness
 * (blob identity, input digests, cache keys). Cheap size/mtime/inode
 * comparisons are only ever used as a *hint* to skip re-hashing a file
 * and are never trusted on their own for recently modified files.
 */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmac256(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonical(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export const DIGEST_RE = /^[0-9a-f]{64}$/;

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
