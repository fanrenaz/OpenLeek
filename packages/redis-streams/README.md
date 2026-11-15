# `@openleek/redis-streams`

Small dependency-free Redis Streams client for the OpenLeek workers. It uses a
single RESP2 TCP connection and supports `redis://` plus `rediss://` URLs.

```ts
const client = createRedisStreamsClient({ url: process.env.REDIS_URL! });
await client.connect();
await client.ensureConsumerGroup("social:run-1:round-1", "social-worker");
await client.xadd("social:run-1:round-1", { commandId: "cmd-1", body: "..." });

const entries = await client.xreadgroup({
  streamKey: "social:run-1:round-1",
  group: "social-worker",
  consumer: "worker-a",
  count: 25,
  blockMs: 1_000,
});

await client.xack("social:run-1:round-1", "social-worker", entries.map((entry) => entry.streamId));
await client.close();
```

## Lifecycle

`connect()` is idempotent and performs URL-configured `AUTH` and `SELECT`
before resolving. Operations call it automatically, so explicitly connecting is
optional when startup ordering does not matter.

The client does **not** reconnect after a TCP/TLS failure. In-flight commands
reject, and the worker should create or reconnect the client under its own
retry/lease policy. Call `close()` during shutdown to release the socket and
reject any pending requests. Redis Streams delivery is at-least-once, so pair
this client with owner-side command IDs and idempotent consumers.
