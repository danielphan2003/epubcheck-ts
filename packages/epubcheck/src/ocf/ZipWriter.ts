import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// Writes a ZIP archive the way upstream's `--save` packages an expanded EPUB: `mimetype` stored
// and every other entry deflated. The caller puts `mimetype` first.

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const deflateRaw = (data: Uint8Array) =>
  Effect.promise(async () => {
    const stream = new Blob([new Uint8Array(data)])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  });

// MS-DOS timestamps, in local time as Java's ZipOutputStream writes them.
const dosTimestamp = (millis: number) => {
  const parts = DateTime.toParts(
    DateTime.makeZonedUnsafe(millis, { timeZone: DateTime.zoneMakeLocal() }),
  );
  return {
    time: (parts.hour << 11) | (parts.minute << 5) | Math.floor(parts.second / 2),
    date: ((parts.year - 1980) << 9) | (parts.month << 5) | parts.day,
  };
};

export interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
  // The source file's modification time, in epoch milliseconds.
  readonly modified: number;
}

export const write = Effect.fn("ZipWriter.write")(function* (entries: ReadonlyArray<Entry>) {
  const encoder = new TextEncoder();
  const locals: Array<Uint8Array> = [];
  const centrals: Array<Uint8Array> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const { time, date } = dosTimestamp(entry.modified);
    const crc = crc32(entry.data);
    const stored = entry.name === "mimetype";
    const body = stored ? entry.data : yield* deflateRaw(entry.data);
    const local = new Uint8Array(30 + name.length + body.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, stored ? 0 : 8, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, stored ? 0 : 8, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, body.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const archive = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.length;
  }
  return archive;
});
