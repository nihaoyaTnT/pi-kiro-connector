import assert from "node:assert/strict";
import test from "node:test";
import { decodeEventStream, encodeEventStreamFrame } from "../src/eventstream.ts";

async function collect(chunks: Uint8Array[]) {
  async function* source() {
    for (const chunk of chunks) yield chunk;
  }
  const events = [];
  for await (const event of decodeEventStream(source())) events.push(event);
  return events;
}

test("decodes AWS EventStream frames split at arbitrary boundaries", async () => {
  const frame = encodeEventStreamFrame("assistantResponseEvent", { content: "hello" });
  const chunks = [frame.slice(0, 1), frame.slice(1, 9), frame.slice(9, 17), frame.slice(17)];
  const events = await collect(chunks);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "assistantResponseEvent");
  assert.deepEqual(events[0]?.payload, { content: "hello" });
});

test("preserves repeated text frames without heuristic deduplication", async () => {
  const chunks = ["666", "666", "666", "6"].map((content) =>
    encodeEventStreamFrame("assistantResponseEvent", { content }),
  );
  const events = await collect(chunks);
  assert.equal(events.map((event) => event.payload.content).join(""), "6666666666");
});

test("rejects CRC corruption and truncated frames", async () => {
  const corrupted = encodeEventStreamFrame("assistantResponseEvent", { content: "hello" });
  corrupted[corrupted.length - 1] ^= 0xff;
  await assert.rejects(() => collect([corrupted]), /CRC mismatch/);

  const truncated = encodeEventStreamFrame("assistantResponseEvent", { content: "hello" }).slice(0, -2);
  await assert.rejects(() => collect([truncated]), /truncated frame/);
});
