export interface KiroWireEvent {
  type: string;
  payload: Record<string, unknown>;
  headers: ReadonlyMap<string, unknown>;
}

const textDecoder = new TextDecoder();

export const MAX_EVENTSTREAM_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_EVENTSTREAM_HEADER_BYTES = 128 * 1024;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

export interface EventStreamDecodeOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  maxFrameBytes?: number;
  maxHeaderBytes?: number;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function int16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(offset, false);
}

function int32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, false);
}

function int64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(offset, false);
}

function parseHeaders(bytes: Uint8Array): Map<string, unknown> {
  const headers = new Map<string, unknown>();
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes[offset++];
    if (nameLength === undefined || offset + nameLength + 1 > bytes.length) {
      throw new Error("Malformed AWS EventStream header name");
    }
    const name = textDecoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = bytes[offset++];
    if (type === undefined) throw new Error("Malformed AWS EventStream header type");

    let value: unknown;
    switch (type) {
      case 0:
        value = true;
        break;
      case 1:
        value = false;
        break;
      case 2:
        if (offset + 1 > bytes.length) throw new Error("Malformed byte header");
        value = bytes[offset++];
        break;
      case 3:
        if (offset + 2 > bytes.length) throw new Error("Malformed int16 header");
        value = int16(bytes, offset);
        offset += 2;
        break;
      case 4:
        if (offset + 4 > bytes.length) throw new Error("Malformed int32 header");
        value = int32(bytes, offset);
        offset += 4;
        break;
      case 5:
      case 8:
        if (offset + 8 > bytes.length) throw new Error("Malformed int64 header");
        value = int64(bytes, offset);
        offset += 8;
        break;
      case 6:
      case 7: {
        if (offset + 2 > bytes.length) throw new Error("Malformed variable header");
        const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
        offset += 2;
        if (offset + length > bytes.length) throw new Error("Malformed variable header value");
        const data = bytes.subarray(offset, offset + length);
        value = type === 7 ? textDecoder.decode(data) : data;
        offset += length;
        break;
      }
      case 9:
        if (offset + 16 > bytes.length) throw new Error("Malformed UUID header");
        value = bytes.subarray(offset, offset + 16);
        offset += 16;
        break;
      default:
        throw new Error(`Unsupported AWS EventStream header type ${type}`);
    }
    headers.set(name, value);
  }
  return headers;
}

async function nextWithTimeout<T>(
  operation: Promise<T>,
  options: EventStreamDecodeOptions,
): Promise<T> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("Request aborted");
  }
  const timeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => reject(new Error(`Kiro EventStream was idle for ${timeoutMs}ms`)),
        timeoutMs,
      );
    }
    if (options.signal) {
      onAbort = () => reject(options.signal?.reason ?? new Error("Request aborted"));
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}

async function* bodyChunks(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: EventStreamDecodeOptions,
): AsyncGenerator<Uint8Array> {
  if ("getReader" in body && typeof body.getReader === "function") {
    const reader = body.getReader();
    let completed = false;
    try {
      while (true) {
        const result = await nextWithTimeout(reader.read(), options);
        if (result.done) {
          completed = true;
          return;
        }
        yield result.value;
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const iterator = body[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const result = await nextWithTimeout(iterator.next(), options);
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    // A generic async iterator has no standard abort primitive. Invoke return
    // best-effort without awaiting an implementation blocked in next().
    if (!completed) void iterator.return?.().catch(() => undefined);
  }
}

class ChunkQueue {
  private readonly chunks: Array<{ bytes: Uint8Array; offset: number }> = [];
  length = 0;

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.chunks.push({ bytes, offset: 0 });
    this.length += bytes.byteLength;
  }

  peek(length: number): Uint8Array {
    const first = this.chunks[0];
    if (!first || length > this.length) throw new Error("Insufficient buffered EventStream data");
    if (first.bytes.byteLength - first.offset >= length) {
      return first.bytes.subarray(first.offset, first.offset + length);
    }
    return this.copy(length, false);
  }

  read(length: number): Uint8Array {
    return this.copy(length, true);
  }

  private copy(length: number, consume: boolean): Uint8Array {
    if (length > this.length) throw new Error("Insufficient buffered EventStream data");
    const output = new Uint8Array(length);
    let written = 0;
    let chunkIndex = 0;
    while (written < length) {
      const chunk = this.chunks[chunkIndex]!;
      const available = chunk.bytes.byteLength - chunk.offset;
      const count = Math.min(available, length - written);
      output.set(chunk.bytes.subarray(chunk.offset, chunk.offset + count), written);
      written += count;
      if (consume) {
        chunk.offset += count;
        this.length -= count;
        if (chunk.offset === chunk.bytes.byteLength) this.chunks.shift();
      } else {
        chunkIndex++;
      }
    }
    return output;
  }
}

function parsePayload(payload: Uint8Array): Record<string, unknown> {
  if (payload.length === 0) return {};
  try {
    const parsed = JSON.parse(textDecoder.decode(payload)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("payload is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid JSON in Kiro EventStream payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Decode and CRC-check an AWS EventStream response incrementally. */
export async function* decodeEventStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: EventStreamDecodeOptions = {},
): AsyncGenerator<KiroWireEvent> {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_EVENTSTREAM_FRAME_BYTES;
  const maxHeaderBytes = options.maxHeaderBytes ?? MAX_EVENTSTREAM_HEADER_BYTES;
  const buffered = new ChunkQueue();

  for await (const chunk of bodyChunks(body, options)) {
    buffered.push(chunk);
    while (buffered.length >= 12) {
      const prelude = buffered.peek(12);
      const totalLength = uint32(prelude, 0);
      const headersLength = uint32(prelude, 4);
      if (totalLength < 16 || headersLength > totalLength - 16) {
        throw new Error("Malformed AWS EventStream frame length");
      }
      if (totalLength > maxFrameBytes) {
        throw new Error(`AWS EventStream frame exceeded the ${maxFrameBytes}-byte limit`);
      }
      if (headersLength > maxHeaderBytes) {
        throw new Error(`AWS EventStream headers exceeded the ${maxHeaderBytes}-byte limit`);
      }
      if (buffered.length < totalLength) break;

      const frame = buffered.read(totalLength);
      const expectedPreludeCrc = uint32(frame, 8);
      if (crc32(frame.subarray(0, 8)) !== expectedPreludeCrc) {
        throw new Error("AWS EventStream prelude CRC mismatch");
      }
      const expectedMessageCrc = uint32(frame, totalLength - 4);
      if (crc32(frame.subarray(0, totalLength - 4)) !== expectedMessageCrc) {
        throw new Error("AWS EventStream message CRC mismatch");
      }

      const headers = parseHeaders(frame.subarray(12, 12 + headersLength));
      const payload = parsePayload(frame.subarray(12 + headersLength, totalLength - 4));
      const messageType = headers.get(":message-type");
      const eventType = String(headers.get(":event-type") ?? headers.get(":exception-type") ?? "");
      if (messageType === "exception" || messageType === "error") {
        const detail =
          (typeof payload.message === "string" && payload.message) ||
          (typeof payload.Message === "string" && payload.Message) ||
          "Kiro returned a streaming exception";
        throw new Error(`${eventType || "KiroStreamException"}: ${detail}`);
      }
      if (eventType) yield { type: eventType, payload, headers };
    }
  }
  if (buffered.length > 0) throw new Error("Kiro EventStream ended with a truncated frame");
}

/** Test/helper encoder for standards-compliant AWS EventStream messages. */
export function encodeEventStreamFrame(type: string, payload: Record<string, unknown>): Uint8Array {
  const name = new TextEncoder().encode(":event-type");
  const value = new TextEncoder().encode(type);
  const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length);
  let offset = 0;
  headers[offset++] = name.length;
  headers.set(name, offset);
  offset += name.length;
  headers[offset++] = 7;
  headers[offset++] = value.length >>> 8;
  headers[offset++] = value.length & 0xff;
  headers.set(value, offset);

  const data = new TextEncoder().encode(JSON.stringify(payload));
  const total = 12 + headers.length + data.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, headers.length, false);
  view.setUint32(8, crc32(frame.subarray(0, 8)), false);
  frame.set(headers, 12);
  frame.set(data, 12 + headers.length);
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)), false);
  return frame;
}
