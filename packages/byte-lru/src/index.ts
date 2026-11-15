export interface ByteLruOptions<Value> {
  maxBytes: number;
  sizeOf(value: Value): number;
}

/** A byte-bounded LRU with per-key in-flight request coalescing. */
export class ByteLru<Value> {
  readonly #values = new Map<string, { value: Value; bytes: number }>();
  readonly #pending = new Map<string, Promise<Value>>();
  readonly #maxBytes: number;
  readonly #sizeOf: (value: Value) => number;
  #bytes = 0;

  constructor(options: ByteLruOptions<Value>) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new Error("maxBytes must be a non-negative safe integer");
    }
    this.#maxBytes = options.maxBytes;
    this.#sizeOf = options.sizeOf;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: string): Value | undefined {
    const entry = this.#values.get(key);
    if (entry === undefined) return undefined;
    this.#values.delete(key);
    this.#values.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value): void {
    const bytes = Math.max(0, Math.ceil(this.#sizeOf(value)));
    const previous = this.#values.get(key);
    if (previous !== undefined) {
      this.#values.delete(key);
      this.#bytes -= previous.bytes;
    }
    if (bytes > this.#maxBytes || this.#maxBytes === 0) return;
    this.#values.set(key, { value, bytes });
    this.#bytes += bytes;
    while (this.#bytes > this.#maxBytes) {
      const oldest = this.#values.entries().next().value as [string, { value: Value; bytes: number }] | undefined;
      if (oldest === undefined) break;
      this.#values.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
    }
  }

  async getOrLoad(key: string, load: () => Promise<Value>): Promise<Value> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.#pending.get(key);
    if (pending !== undefined) return pending;
    const request = load().then((value) => {
      this.set(key, value);
      return value;
    }).finally(() => {
      this.#pending.delete(key);
    });
    this.#pending.set(key, request);
    return request;
  }
}

export function jsonByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
