import { createRequire } from 'node:module';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Bumped on ANY incompatible change to messages, op semantics or the engine contract. */
export const PROTO = 1;
export const VERSION: string = (createRequire(import.meta.url)('../../../package.json') as { version: string }).version;

export const MAX_REQUEST_CHARS = 1024 * 1024;
export const MAX_ENV_CHARS = 256 * 1024;
/** Responses carry task logs (each already capped by the engine); the client allows a lot more. */
export const MAX_MESSAGE_CHARS = 128 * 1024 * 1024;
export const AUTH_TIMEOUT_MS = 5000;
export const MAX_CONNECTIONS = 32;
export const MAX_UNAUTHENTICATED = 8;

/**
 * The complete, closed set of operations. Nothing in a request is ever evaluated, spawned or
 * used as a path/command: `run` names tasks that must already exist in buildrush.json.
 */
export const OPS = ['ping', 'status', 'run', 'analyze', 'cacheStats', 'stop'] as const;
export type Op = (typeof OPS)[number];
/** Served even when versions differ, so a client can always ask an old daemon to exit. */
export const VERSION_AGNOSTIC_OPS: readonly Op[] = ['ping', 'status', 'stop'];

export interface Request {
  proto: number;
  /** Client's BuildRush version. */
  client: string;
  token: string;
  op: Op;
  args?: Record<string, unknown>;
}

export type Message =
  | { type: 'queued'; ahead: number }
  | { type: 'begin'; project: string; tasks: number }
  | { type: 'task'; report: unknown }
  | { type: 'result'; data: unknown }
  | { type: 'error'; code: ErrorCode; message: string; proto?: number; version?: string };

export type ErrorCode = 'bad_request' | 'version_mismatch' | 'stale_daemon' | 'wrong_root' | 'failed' | 'shutting_down';

/** Constant-time token check (hashing first makes the compared buffers equal-length). */
export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Splits a utf8 stream into lines, refusing to buffer more than `max` characters per line. */
export class LineReader {
  private buf = '';
  private dead = false;
  constructor(
    private readonly max: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: string): void {
    if (this.dead) return;
    this.buf += chunk;
    let i: number;
    while (!this.dead && (i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length > this.max) return this.overflow();
      if (line.length > 0) this.onLine(line);
    }
    if (!this.dead && this.buf.length > this.max) this.overflow();
  }

  private overflow(): void {
    this.dead = true;
    this.buf = '';
    this.onOverflow();
  }
}
