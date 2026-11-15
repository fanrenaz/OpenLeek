import { createConnection as createNetConnection, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

export interface RedisStreamsClientOptions {
  /** A redis:// or rediss:// URL, optionally including ACL credentials and DB number. */
  url: string;
  /** Fails a new TCP/TLS connection if it is not established within this interval. */
  connectTimeoutMs?: number;
}

export interface RedisStreamEntry {
  streamKey: string;
  streamId: string;
  fields: Record<string, string>;
}

export interface RedisStreamRead {
  streamKey: string;
  /** Redis stream cursor. Defaults to `>` for new messages. */
  id?: string;
}

export interface RedisXReadGroupOptions {
  group: string;
  consumer: string;
  /** Convenience form for reading one stream. Mutually exclusive with `streams`. */
  streamKey?: string;
  /** Cursor used with `streamKey`; defaults to `>`. */
  id?: string;
  /** Multi-stream form. Mutually exclusive with `streamKey`. */
  streams?: readonly RedisStreamRead[];
  /** Maximum entries Redis should return. */
  count?: number;
  /** Maximum time Redis should wait for an entry. Omit for non-blocking reads. */
  blockMs?: number;
}

export interface RedisPendingSummary {
  count: number;
  smallestId?: string;
  greatestId?: string;
}

export interface RedisAutoClaimResult {
  nextStartId: string;
  entries: RedisStreamEntry[];
  deletedIds: string[];
}

export class RedisServerError extends Error {
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = "RedisServerError";
    this.code = message.split(" ", 1)[0] ?? "ERR";
  }
}

type RedisSocket = Socket | TLSSocket;
type RespValue = string | number | null | RedisServerError | RespValue[];

interface ParsedResp {
  value: RespValue;
  nextOffset: number;
}

interface PendingCommand {
  resolve: (value: RespValue) => void;
  reject: (reason: Error) => void;
}

interface ParsedRedisUrl {
  host: string;
  port: number;
  tls: boolean;
  username: string | undefined;
  password: string | undefined;
  database: number | undefined;
}

/**
 * A deliberately small RESP2 client for Redis Streams.
 *
 * The client serializes commands on one connection, which makes response
 * ordering explicit and is well suited to a stream-worker command loop.
 * It does not reconnect automatically: callers own the lifecycle and should
 * call `connect()` again after an I/O failure if they want to resume work.
 */
export class RedisStreamsClient {
  readonly #options: Required<Pick<RedisStreamsClientOptions, "connectTimeoutMs">> & RedisStreamsClientOptions;
  readonly #config: ParsedRedisUrl;
  #socket: RedisSocket | undefined;
  #connectPromise: Promise<void> | undefined;
  #connectReject: ((reason: Error) => void) | undefined;
  #received = Buffer.alloc(0);
  #pending: PendingCommand[] = [];

  constructor(options: RedisStreamsClientOptions) {
    this.#options = { connectTimeoutMs: 5_000, ...options };
    this.#config = parseRedisUrl(options.url);
  }

  async connect(): Promise<void> {
    if (this.#socket !== undefined) {
      return;
    }
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }

    this.#connectPromise = new Promise<void>((resolve, reject) => {
      this.#connectReject = reject;
      const socket = this.#config.tls
        ? connectTls({ host: this.#config.host, port: this.#config.port, servername: this.#config.host })
        : createNetConnection({ host: this.#config.host, port: this.#config.port });
      let established = false;

      const timeout = setTimeout(() => {
        socket.destroy(new Error(`Timed out connecting to Redis at ${this.#config.host}:${this.#config.port}`));
      }, this.#options.connectTimeoutMs);

      socket.on("data", (chunk: Buffer) => this.#onData(chunk));
      socket.on("error", (error: Error) => this.#onFailure(error));
      socket.on("close", () => {
        if (!established) {
          this.#onFailure(new Error("Redis connection closed before it was established"));
        } else if (this.#socket === socket) {
          this.#onFailure(new Error("Redis connection closed"));
        }
      });

      socket.once("connect", async () => {
        established = true;
        clearTimeout(timeout);
        this.#socket = socket;
        try {
          await this.#authenticateAndSelectDatabase();
          this.#connectPromise = undefined;
          this.#connectReject = undefined;
          resolve();
        } catch (error) {
          const connectionError = asError(error);
          socket.destroy(connectionError);
          this.#onFailure(connectionError);
        }
      });
    });

    return this.#connectPromise;
  }

  /** Closes the current socket and rejects any requests that have not completed. */
  async close(): Promise<void> {
    const closeError = new Error("Redis client closed");
    const socket = this.#socket;
    this.#socket = undefined;
    this.#onFailure(closeError);
    socket?.destroy();
  }

  async xadd(streamKey: string, fields: Readonly<Record<string, string>>, id = "*"): Promise<string> {
    const pairs = Object.entries(fields);
    if (pairs.length === 0) {
      throw new Error("XADD requires at least one field");
    }
    const args = ["XADD", streamKey, id];
    for (const [field, value] of pairs) {
      args.push(field, value);
    }
    const response = await this.#requestAfterConnect(args);
    if (typeof response !== "string") {
      throw new Error("Redis XADD returned an invalid stream ID");
    }
    return response;
  }

  /** Creates a consumer group if it does not already exist. */
  async ensureConsumerGroup(streamKey: string, group: string, startId = "$"): Promise<void> {
    try {
      await this.#requestAfterConnect(["XGROUP", "CREATE", streamKey, group, startId, "MKSTREAM"]);
    } catch (error) {
      if (error instanceof RedisServerError && error.code === "BUSYGROUP") {
        return;
      }
      throw error;
    }
  }

  /**
   * Reads pending/new entries for a consumer group. For one stream, pass
   * `streamKey`; for several, pass `streams` in the matching cursor order.
   */
  async xreadgroup(options: RedisXReadGroupOptions): Promise<RedisStreamEntry[]> {
    const streams = normalizeReadStreams(options);
    const args = ["XREADGROUP", "GROUP", options.group, options.consumer];
    if (options.count !== undefined) {
      assertPositiveInteger(options.count, "count");
      args.push("COUNT", String(options.count));
    }
    if (options.blockMs !== undefined) {
      assertNonNegativeInteger(options.blockMs, "blockMs");
      args.push("BLOCK", String(options.blockMs));
    }
    args.push("STREAMS", ...streams.map((stream) => stream.streamKey), ...streams.map((stream) => stream.id ?? ">"));
    return parseXReadGroupResponse(await this.#requestAfterConnect(args));
  }

  async xack(streamKey: string, group: string, streamIds: string | readonly string[]): Promise<number> {
    const ids = typeof streamIds === "string" ? [streamIds] : [...streamIds];
    if (ids.length === 0) {
      return 0;
    }
    const response = await this.#requestAfterConnect(["XACK", streamKey, group, ...ids]);
    if (typeof response !== "number") {
      throw new Error("Redis XACK returned an invalid acknowledgement count");
    }
    return response;
  }

  /** Reclaims deliveries abandoned by a crashed consumer. */
  async xautoclaim(options: {
    streamKey: string;
    group: string;
    consumer: string;
    minIdleMs: number;
    startId?: string;
    count?: number;
  }): Promise<RedisAutoClaimResult> {
    assertNonNegativeInteger(options.minIdleMs, "minIdleMs");
    const args = [
      "XAUTOCLAIM", options.streamKey, options.group, options.consumer,
      String(options.minIdleMs), options.startId ?? "0-0",
    ];
    if (options.count !== undefined) {
      assertPositiveInteger(options.count, "count");
      args.push("COUNT", String(options.count));
    }
    return parseXAutoClaimResponse(
      options.streamKey,
      await this.#requestAfterConnect(args),
    );
  }

  async xpending(streamKey: string, group: string): Promise<RedisPendingSummary> {
    const response = await this.#requestAfterConnect(["XPENDING", streamKey, group]);
    if (!Array.isArray(response) || typeof response[0] !== "number") {
      throw new Error("Redis XPENDING returned an invalid response");
    }
    const count = response[0];
    const smallestId = typeof response[1] === "string" ? response[1] : undefined;
    const greatestId = typeof response[2] === "string" ? response[2] : undefined;
    return { count, ...(smallestId === undefined ? {} : { smallestId }), ...(greatestId === undefined ? {} : { greatestId }) };
  }

  async xdel(streamKey: string, streamIds: string | readonly string[]): Promise<number> {
    const ids = typeof streamIds === "string" ? [streamIds] : [...streamIds];
    if (ids.length === 0) return 0;
    const response = await this.#requestAfterConnect(["XDEL", streamKey, ...ids]);
    if (typeof response !== "number") throw new Error("Redis XDEL returned an invalid response");
    return response;
  }

  async destroyConsumerGroup(streamKey: string, group: string): Promise<boolean> {
    const response = await this.#requestAfterConnect(["XGROUP", "DESTROY", streamKey, group]);
    if (typeof response !== "number") throw new Error("Redis XGROUP DESTROY returned an invalid response");
    return response === 1;
  }

  async del(key: string): Promise<boolean> {
    const response = await this.#requestAfterConnect(["DEL", key]);
    if (typeof response !== "number") throw new Error("Redis DEL returned an invalid response");
    return response === 1;
  }

  async #authenticateAndSelectDatabase(): Promise<void> {
    if (this.#config.password !== undefined) {
      const authArgs = this.#config.username === undefined
        ? ["AUTH", this.#config.password]
        : ["AUTH", this.#config.username, this.#config.password];
      await this.#request(authArgs);
    }
    if (this.#config.database !== undefined) {
      await this.#request(["SELECT", String(this.#config.database)]);
    }
  }

  async #requestAfterConnect(args: readonly string[]): Promise<RespValue> {
    await this.connect();
    return this.#request(args);
  }

  #request(args: readonly string[]): Promise<RespValue> {
    const socket = this.#socket;
    if (socket === undefined || socket.destroyed) {
      return Promise.reject(new Error("Redis client is not connected"));
    }
    return new Promise<RespValue>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      socket.write(encodeCommand(args), (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          const index = this.#pending.findIndex((pending) => pending.resolve === resolve);
          if (index !== -1) {
            this.#pending.splice(index, 1);
            reject(error);
          }
        }
      });
    });
  }

  #onData(chunk: Buffer): void {
    this.#received = Buffer.concat([this.#received, chunk]);
    let offset = 0;
    while (offset < this.#received.length) {
      let parsed: ParsedResp | undefined;
      try {
        parsed = parseResp(this.#received, offset);
      } catch (error) {
        this.#onFailure(asError(error));
        return;
      }
      if (parsed === undefined) {
        break;
      }
      offset = parsed.nextOffset;
      const pending = this.#pending.shift();
      if (pending === undefined) {
        this.#onFailure(new Error("Redis sent a response without a pending command"));
        return;
      }
      if (parsed.value instanceof RedisServerError) {
        pending.reject(parsed.value);
      } else {
        pending.resolve(parsed.value);
      }
    }
    this.#received = this.#received.subarray(offset);
  }

  #onFailure(error: Error): void {
    const socket = this.#socket;
    this.#socket = undefined;
    const rejectConnect = this.#connectReject;
    this.#connectReject = undefined;
    this.#connectPromise = undefined;
    rejectConnect?.(error);
    while (this.#pending.length > 0) {
      this.#pending.shift()?.reject(error);
    }
    if (socket !== undefined && !socket.destroyed) {
      socket.destroy();
    }
  }
}

export function createRedisStreamsClient(options: RedisStreamsClientOptions): RedisStreamsClient {
  return new RedisStreamsClient(options);
}

function parseRedisUrl(value: string): ParsedRedisUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Redis URL must be a valid redis:// or rediss:// URL");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Redis URL protocol must be redis: or rediss:");
  }
  if (url.hostname.length === 0) {
    throw new Error("Redis URL must include a host");
  }
  const port = url.port === "" ? 6379 : Number(url.port);
  assertPositiveInteger(port, "Redis URL port");
  const path = url.pathname;
  let database: number | undefined;
  if (path !== "" && path !== "/") {
    const rawDatabase = path.slice(1);
    if (!/^\d+$/.test(rawDatabase)) {
      throw new Error("Redis URL database must be a non-negative integer path");
    }
    database = Number(rawDatabase);
    assertNonNegativeInteger(database, "Redis URL database");
  }
  const username = url.username === "" ? undefined : decodeURIComponent(url.username);
  const password = url.password === "" ? undefined : decodeURIComponent(url.password);
  return { host: url.hostname, port, tls: url.protocol === "rediss:", username, password, database };
}

function normalizeReadStreams(options: RedisXReadGroupOptions): readonly RedisStreamRead[] {
  const hasSingle = options.streamKey !== undefined;
  const hasMultiple = options.streams !== undefined;
  if (hasSingle === hasMultiple) {
    throw new Error("XREADGROUP requires exactly one of streamKey or streams");
  }
  if (hasSingle) {
    return options.id === undefined
      ? [{ streamKey: options.streamKey as string }]
      : [{ streamKey: options.streamKey as string, id: options.id }];
  }
  const streams = options.streams as readonly RedisStreamRead[];
  if (streams.length === 0) {
    throw new Error("XREADGROUP requires at least one stream");
  }
  return streams;
}

function parseXReadGroupResponse(response: RespValue): RedisStreamEntry[] {
  if (response === null) {
    return [];
  }
  if (!Array.isArray(response)) {
    throw new Error("Redis XREADGROUP returned an invalid response");
  }
  const entries: RedisStreamEntry[] = [];
  for (const stream of response) {
    if (!Array.isArray(stream) || stream.length !== 2 || typeof stream[0] !== "string" || !Array.isArray(stream[1])) {
      throw new Error("Redis XREADGROUP returned an invalid stream response");
    }
    for (const item of stream[1]) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !Array.isArray(item[1])) {
        throw new Error("Redis XREADGROUP returned an invalid entry response");
      }
      const fieldValues = item[1];
      if (fieldValues.length % 2 !== 0) {
        throw new Error("Redis XREADGROUP returned an odd number of field values");
      }
      const fields: Record<string, string> = {};
      for (let index = 0; index < fieldValues.length; index += 2) {
        const field = fieldValues[index];
        const value = fieldValues[index + 1];
        if (typeof field !== "string" || typeof value !== "string") {
          throw new Error("Redis XREADGROUP returned a non-string field value");
        }
        fields[field] = value;
      }
      entries.push({ streamKey: stream[0], streamId: item[0], fields });
    }
  }
  return entries;
}

function parseXAutoClaimResponse(streamKey: string, response: RespValue): RedisAutoClaimResult {
  if (!Array.isArray(response) || typeof response[0] !== "string" || !Array.isArray(response[1])) {
    throw new Error("Redis XAUTOCLAIM returned an invalid response");
  }
  const entries: RedisStreamEntry[] = [];
  for (const item of response[1]) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1]) || item[1].length % 2 !== 0) {
      throw new Error("Redis XAUTOCLAIM returned an invalid entry");
    }
    const fields: Record<string, string> = {};
    for (let index = 0; index < item[1].length; index += 2) {
      const key = item[1][index];
      const value = item[1][index + 1];
      if (typeof key !== "string" || typeof value !== "string") throw new Error("Redis XAUTOCLAIM returned non-string fields");
      fields[key] = value;
    }
    entries.push({ streamKey, streamId: item[0], fields });
  }
  const deleted = response[2];
  const deletedIds = Array.isArray(deleted) ? deleted.filter((value): value is string => typeof value === "string") : [];
  return { nextStartId: response[0], entries, deletedIds };
}

function encodeCommand(args: readonly string[]): Buffer {
  const frames: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const encoded = Buffer.from(arg);
    frames.push(Buffer.from(`$${encoded.length}\r\n`), encoded, Buffer.from("\r\n"));
  }
  return Buffer.concat(frames);
}

function parseResp(buffer: Buffer, startOffset: number): ParsedResp | undefined {
  const prefix = buffer[startOffset];
  if (prefix === undefined) {
    return undefined;
  }
  const lineEnd = buffer.indexOf("\r\n", startOffset);
  if (lineEnd === -1) {
    return undefined;
  }
  const line = buffer.toString("utf8", startOffset + 1, lineEnd);
  const afterLine = lineEnd + 2;
  switch (prefix) {
    case 43: // +
      return { value: line, nextOffset: afterLine };
    case 45: // -
      return { value: new RedisServerError(line), nextOffset: afterLine };
    case 58: { // :
      const value = Number(line);
      if (!Number.isSafeInteger(value)) {
        throw new Error("Invalid RESP integer");
      }
      return { value, nextOffset: afterLine };
    }
    case 36: { // $
      const length = parseRespLength(line);
      if (length === -1) {
        return { value: null, nextOffset: afterLine };
      }
      const end = afterLine + length;
      if (buffer.length < end + 2) {
        return undefined;
      }
      if (buffer[end] !== 13 || buffer[end + 1] !== 10) {
        throw new Error("Invalid RESP bulk string terminator");
      }
      return { value: buffer.toString("utf8", afterLine, end), nextOffset: end + 2 };
    }
    case 42: { // *
      const length = parseRespLength(line);
      if (length === -1) {
        return { value: null, nextOffset: afterLine };
      }
      const values: RespValue[] = [];
      let offset = afterLine;
      for (let index = 0; index < length; index += 1) {
        const nested = parseResp(buffer, offset);
        if (nested === undefined) {
          return undefined;
        }
        values.push(nested.value);
        offset = nested.nextOffset;
      }
      return { value: values, nextOffset: offset };
    }
    default:
      throw new Error("Unsupported RESP response type");
  }
}

function parseRespLength(value: string): number {
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < -1) {
    throw new Error("Invalid RESP length");
  }
  return length;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
