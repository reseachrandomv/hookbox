/**
 * In-memory ring buffer of captured requests with optional SQLite persistence.
 *
 * Persistence tries the built-in `node:sqlite` module first (Node 22.5+), then
 * the optional `better-sqlite3` dependency. If neither can be loaded, HookBox
 * keeps running in memory-only mode and reports why.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CapturedRequest } from './types.js';

interface SqlStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface PersistenceInfo {
  enabled: boolean;
  driver: 'node:sqlite' | 'better-sqlite3' | null;
  file: string | null;
  error: string | null;
}

const require = createRequire(import.meta.url);

function loadNodeSqlite(file: string): SqlDatabase | null {
  // Silence the one-time ExperimentalWarning that some Node versions emit for node:sqlite.
  const originalEmit = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const msg = typeof warning === 'string' ? warning : warning.message;
      if (/sqlite/i.test(msg)) return;
      return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    const mod = require('node:sqlite') as { DatabaseSync: new (path: string) => SqlDatabase };
    return new mod.DatabaseSync(file);
  } catch {
    return null;
  } finally {
    process.emitWarning = originalEmit;
  }
}

function loadBetterSqlite(file: string): SqlDatabase | null {
  try {
    const Ctor = require('better-sqlite3') as new (path: string) => SqlDatabase;
    return new Ctor(file);
  } catch {
    return null;
  }
}

export class RequestStore {
  private items: CapturedRequest[] = [];
  private byId = new Map<string, CapturedRequest>();
  private db: SqlDatabase | null = null;
  private seq = 0;
  readonly persistence: PersistenceInfo = { enabled: false, driver: null, file: null, error: null };

  constructor(public readonly maxHistory: number, dbFile?: string) {
    if (!Number.isInteger(maxHistory) || maxHistory < 1) {
      throw new Error(`maxHistory must be a positive integer, got ${maxHistory}`);
    }
    if (dbFile) this.openDatabase(dbFile);
  }

  private openDatabase(dbFile: string): void {
    const file = resolve(dbFile);
    this.persistence.file = file;
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch (err) {
      this.persistence.error = `cannot create directory for ${file}: ${(err as Error).message}`;
      return;
    }
    let driver: PersistenceInfo['driver'] = 'node:sqlite';
    let db = loadNodeSqlite(file);
    if (!db) {
      driver = 'better-sqlite3';
      db = loadBetterSqlite(file);
    }
    if (!db) {
      this.persistence.error =
        'SQLite is unavailable (node:sqlite needs Node 22.5+, and the optional better-sqlite3 package is not installed). Running in memory only.';
      return;
    }
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS requests_seq ON requests(seq);
      `);
      const rows = db
        .prepare('SELECT data FROM requests ORDER BY seq DESC LIMIT ?')
        .all(this.maxHistory) as Array<{ data: string }>;
      const loaded = rows
        .map((r) => {
          try {
            return JSON.parse(r.data) as CapturedRequest;
          } catch {
            return null;
          }
        })
        .filter((r): r is CapturedRequest => r !== null)
        .reverse();
      this.items = loaded;
      for (const item of loaded) this.byId.set(item.id, item);
      this.seq = loaded.reduce((max, r) => Math.max(max, r.seq), 0);
      // Drop rows beyond the history window left over from earlier runs.
      db.prepare('DELETE FROM requests WHERE seq <= ?').run(this.oldestSeq() - 1);
      this.db = db;
      this.persistence.enabled = true;
      this.persistence.driver = driver;
    } catch (err) {
      this.persistence.error = `SQLite error: ${(err as Error).message}. Running in memory only.`;
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  }

  private oldestSeq(): number {
    return this.items.length ? this.items[0].seq : this.seq + 1;
  }

  private persist(item: CapturedRequest): void {
    if (!this.db) return;
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO requests (id, seq, data) VALUES (?, ?, ?)')
        .run(item.id, item.seq, JSON.stringify(item));
    } catch (err) {
      this.persistence.error = `SQLite write failed: ${(err as Error).message}`;
    }
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Adds a request and returns the ids that were evicted by the ring buffer. */
  add(item: CapturedRequest): string[] {
    this.items.push(item);
    this.byId.set(item.id, item);
    this.persist(item);
    const evicted: string[] = [];
    while (this.items.length > this.maxHistory) {
      const old = this.items.shift();
      if (!old) break;
      this.byId.delete(old.id);
      evicted.push(old.id);
    }
    if (evicted.length && this.db) {
      try {
        const del = this.db.prepare('DELETE FROM requests WHERE id = ?');
        for (const id of evicted) del.run(id);
      } catch (err) {
        this.persistence.error = `SQLite delete failed: ${(err as Error).message}`;
      }
    }
    return evicted;
  }

  /** Re-saves a request after it was mutated (replay, forward, verification). */
  update(item: CapturedRequest): void {
    if (this.byId.has(item.id)) this.persist(item);
  }

  get(id: string): CapturedRequest | undefined {
    return this.byId.get(id);
  }

  /** Newest first. */
  list(): CapturedRequest[] {
    return [...this.items].reverse();
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.byId.clear();
    if (this.db) {
      try {
        this.db.exec('DELETE FROM requests');
      } catch (err) {
        this.persistence.error = `SQLite clear failed: ${(err as Error).message}`;
      }
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }
}
