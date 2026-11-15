import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { createRedisStreamsClient } from "../src/index.js";

interface FakeRedis {
  readonly port: number;
  readonly commands: string[][];
  close(): Promise<void>;
}

test("authenticates, selects a DB, and runs the Streams command lifecycle", async (t) => {
  const redis = await startFakeRedis((command, socket) => {
    switch (command[0]) {
      case "AUTH":
      case "SELECT":
        socket.write("+OK\r\n");
        return;
      case "XADD":
        socket.write("$3\r\n1-0\r\n");
        return;
      case "XGROUP":
        socket.write("-BUSYGROUP Consumer Group name already exists\r\n");
        return;
      case "XREADGROUP": {
        const response = "*1\r\n*2\r\n$16\r\nsocial:run:round\r\n*1\r\n*2\r\n$3\r\n1-0\r\n*4\r\n$9\r\ncommandId\r\n$5\r\ncmd-1\r\n$4\r\nbody\r\n$2\r\n{}\r\n";
        socket.write(response.slice(0, 31));
        socket.write(response.slice(31));
        return;
      }
      case "XACK":
        socket.write(":1\r\n");
        return;
      default:
        socket.write("-ERR unexpected command\r\n");
    }
  });
  t.after(async () => redis.close());

  const client = createRedisStreamsClient({ url: `redis://alice:secret@127.0.0.1:${redis.port}/2` });
  await client.connect();
  assert.equal(await client.xadd("social:run:round", { commandId: "cmd-1", body: "{}" }), "1-0");
  await client.ensureConsumerGroup("social:run:round", "social-worker");
  const entries = await client.xreadgroup({
    streamKey: "social:run:round",
    group: "social-worker",
    consumer: "worker-a",
    count: 25,
    blockMs: 100,
  });
  assert.deepEqual(entries, [{
    streamKey: "social:run:round",
    streamId: "1-0",
    fields: { commandId: "cmd-1", body: "{}" },
  }]);
  assert.equal(await client.xack("social:run:round", "social-worker", "1-0"), 1);
  await client.close();

  assert.deepEqual(redis.commands, [
    ["AUTH", "alice", "secret"],
    ["SELECT", "2"],
    ["XADD", "social:run:round", "*", "commandId", "cmd-1", "body", "{}"],
    ["XGROUP", "CREATE", "social:run:round", "social-worker", "$", "MKSTREAM"],
    ["XREADGROUP", "GROUP", "social-worker", "worker-a", "COUNT", "25", "BLOCK", "100", "STREAMS", "social:run:round", ">"],
    ["XACK", "social:run:round", "social-worker", "1-0"],
  ]);
});

test("returns no entries for a timed-out blocking read and supports multiple streams", async (t) => {
  const redis = await startFakeRedis((command, socket) => {
    if (command[0] === "XREADGROUP") {
      socket.write("$-1\r\n");
      return;
    }
    socket.write("+OK\r\n");
  });
  t.after(async () => redis.close());

  const client = createRedisStreamsClient({ url: `redis://127.0.0.1:${redis.port}` });
  assert.deepEqual(await client.xreadgroup({
    group: "workers",
    consumer: "one",
    streams: [{ streamKey: "social", id: ">" }, { streamKey: "financial", id: "0" }],
  }), []);
  await client.close();
  assert.deepEqual(redis.commands, [["XREADGROUP", "GROUP", "workers", "one", "STREAMS", "social", "financial", ">", "0"]]);
});

test("validates local stream input before issuing a command", async () => {
  const client = createRedisStreamsClient({ url: "redis://127.0.0.1:6379" });
  await assert.rejects(() => client.xadd("stream", {}), /at least one field/);
  await assert.rejects(() => client.xreadgroup({ group: "g", consumer: "c" }), /exactly one/);
});

test("reclaims abandoned deliveries and exposes bounded PEL cleanup primitives", async (t) => {
  const redis = await startFakeRedis((command, socket) => {
    if (command[0] === "XAUTOCLAIM") {
      socket.write("*3\r\n$3\r\n2-0\r\n*1\r\n*2\r\n$3\r\n1-0\r\n*2\r\n$9\r\ncommandId\r\n$5\r\ncmd-1\r\n*1\r\n$3\r\n0-9\r\n");
    } else if (command[0] === "XPENDING") {
      socket.write("*4\r\n:1\r\n$3\r\n1-0\r\n$3\r\n1-0\r\n*0\r\n");
    } else if (command[0] === "XDEL" || command[0] === "XGROUP" || command[0] === "DEL") {
      socket.write(":1\r\n");
    } else socket.write("-ERR unexpected command\r\n");
  });
  t.after(async () => redis.close());
  const client = createRedisStreamsClient({ url: `redis://127.0.0.1:${redis.port}` });
  assert.deepEqual(await client.xautoclaim({
    streamKey: "social:run:1", group: "workers", consumer: "worker-b", minIdleMs: 30_000, count: 100,
  }), {
    nextStartId: "2-0",
    entries: [{ streamKey: "social:run:1", streamId: "1-0", fields: { commandId: "cmd-1" } }],
    deletedIds: ["0-9"],
  });
  assert.deepEqual(await client.xpending("social:run:1", "workers"), { count: 1, smallestId: "1-0", greatestId: "1-0" });
  assert.equal(await client.xdel("social:run:1", ["1-0"]), 1);
  assert.equal(await client.destroyConsumerGroup("social:run:1", "workers"), true);
  assert.equal(await client.del("social:run:1"), true);
  await client.close();
});

async function startFakeRedis(onCommand: (command: string[], socket: Socket) => void): Promise<FakeRedis> {
  const commands: string[][] = [];
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (true) {
        const parsed = parseCommand(pending);
        if (parsed === undefined) {
          return;
        }
        pending = pending.subarray(parsed.nextOffset);
        commands.push(parsed.command);
        onCommand(parsed.command, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake Redis did not expose a TCP port");
  }
  return {
    port: address.port,
    commands,
    close: async () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

function parseCommand(buffer: Buffer): { command: string[]; nextOffset: number } | undefined {
  const firstEnd = buffer.indexOf("\r\n");
  if (firstEnd === -1 || buffer[0] !== 42) {
    return undefined;
  }
  const count = Number(buffer.toString("utf8", 1, firstEnd));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid RESP command array");
  }
  const command: string[] = [];
  let offset = firstEnd + 2;
  for (let index = 0; index < count; index += 1) {
    const lengthEnd = buffer.indexOf("\r\n", offset);
    if (lengthEnd === -1 || buffer[offset] !== 36) {
      return undefined;
    }
    const length = Number(buffer.toString("utf8", offset + 1, lengthEnd));
    const valueStart = lengthEnd + 2;
    const valueEnd = valueStart + length;
    if (!Number.isSafeInteger(length) || length < 0 || buffer.length < valueEnd + 2) {
      return undefined;
    }
    command.push(buffer.toString("utf8", valueStart, valueEnd));
    offset = valueEnd + 2;
  }
  return { command, nextOffset: offset };
}
