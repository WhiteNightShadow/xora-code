import { chmod, mkdir, open, readFile, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeEvent, SessionRecord } from "./dto.js";
import { SecretRedactor } from "./redaction.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface JsonlSessionStoreOptions {
  /** fsync after each event. Enabled by default for crash-safe user sessions. */
  durable?: boolean;
  redactor?: SecretRedactor;
  now?: () => Date;
}

export interface ReadSessionOptions {
  afterSequence?: number;
}

interface ScanResult<TEvent> {
  records: SessionRecord<TEvent>[];
  completeBytes: number;
  hasPartialTail: boolean;
}

export class SessionStoreCorruptionError extends Error {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, message: string) {
    super(`${path}:${line}: ${message}`);
    this.name = "SessionStoreCorruptionError";
    this.path = path;
    this.line = line;
  }
}

/**
 * Append-only JSONL store. Calls are serialized per session inside this
 * process; incomplete crash tails are ignored on read and removed before the
 * next append.
 */
export class JsonlSessionStore<TEvent = RuntimeEvent> {
  readonly #root: string;
  readonly #durable: boolean;
  readonly #redactor: SecretRedactor;
  readonly #now: () => Date;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #nextSequence = new Map<string, number>();

  constructor(root: string, options: JsonlSessionStoreOptions = {}) {
    if (!root) throw new Error("Session store root must be non-empty.");
    this.#root = resolve(root);
    this.#durable = options.durable ?? true;
    this.#redactor = options.redactor ?? new SecretRedactor();
    this.#now = options.now ?? (() => new Date());
  }

  get root(): string {
    return this.#root;
  }

  async append(sessionId: string, event: TEvent): Promise<SessionRecord<TEvent>> {
    this.#assertSessionId(sessionId);
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const queueTail = new Promise<void>((resolveTail) => {
      resolveQueue = resolveTail;
    });
    this.#queues.set(sessionId, queueTail);

    await previous;
    try {
      return await this.#appendUnlocked(sessionId, event);
    } finally {
      resolveQueue();
      if (this.#queues.get(sessionId) === queueTail) this.#queues.delete(sessionId);
    }
  }

  async read(
    sessionId: string,
    options: ReadSessionOptions = {},
  ): Promise<SessionRecord<TEvent>[]> {
    this.#assertSessionId(sessionId);
    await (this.#queues.get(sessionId) ?? Promise.resolve());
    const result = await this.#scan(sessionId);
    const after = options.afterSequence ?? 0;
    return result.records.filter((record) => record.sequence > after);
  }

  async close(): Promise<void> {
    await Promise.all(this.#queues.values());
  }

  async #appendUnlocked(sessionId: string, event: TEvent): Promise<SessionRecord<TEvent>> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const path = this.#path(sessionId);

    let sequence = this.#nextSequence.get(sessionId);
    if (sequence === undefined) {
      const scan = await this.#scan(sessionId);
      if (scan.hasPartialTail) await truncate(path, scan.completeBytes);
      sequence = (scan.records.at(-1)?.sequence ?? 0) + 1;
    }

    const record: SessionRecord<TEvent> = {
      schemaVersion: 1,
      sessionId,
      sequence,
      timestamp: this.#now().toISOString(),
      event: this.#redactor.redactValue(event),
    };
    const line = `${JSON.stringify(record)}\n`;
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(line, { encoding: "utf8" });
      if (this.#durable) await handle.sync();
    } finally {
      await handle.close();
    }
    // Existing files may predate the hardened mode.
    await chmod(path, 0o600);
    this.#nextSequence.set(sessionId, sequence + 1);
    return record;
  }

  async #scan(sessionId: string): Promise<ScanResult<TEvent>> {
    const path = this.#path(sessionId);
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { records: [], completeBytes: 0, hasPartialTail: false };
      }
      throw error;
    }

    const lastNewline = contents.lastIndexOf(0x0a);
    const completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
    const hasPartialTail = completeBytes !== contents.length;
    const completeText = contents.subarray(0, completeBytes).toString("utf8");
    const lines = completeText.split("\n");
    lines.pop();

    const records: SessionRecord<TEvent>[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.length === 0) {
        throw new SessionStoreCorruptionError(path, index + 1, "blank JSONL record");
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch {
        throw new SessionStoreCorruptionError(path, index + 1, "invalid JSON");
      }
      const record = candidate as Partial<SessionRecord<TEvent>>;
      const expectedSequence = records.length + 1;
      if (
        record.schemaVersion !== 1 ||
        record.sessionId !== sessionId ||
        record.sequence !== expectedSequence ||
        typeof record.timestamp !== "string" ||
        !("event" in record)
      ) {
        throw new SessionStoreCorruptionError(
          path,
          index + 1,
          `invalid envelope or sequence (expected ${expectedSequence})`,
        );
      }
      records.push(record as SessionRecord<TEvent>);
    }
    return { records, completeBytes, hasPartialTail };
  }

  #path(sessionId: string): string {
    return join(this.#root, `${sessionId}.jsonl`);
  }

  #assertSessionId(sessionId: string): void {
    if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === "." || sessionId === "..") {
      throw new Error(`Unsafe session id: ${JSON.stringify(sessionId)}`);
    }
  }
}
