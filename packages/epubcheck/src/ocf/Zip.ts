import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Messages follow java.util.zip.ZipFile, which upstream reports verbatim: an "invalid CEN header"
// becomes PKG-027, any other archive error PKG-008.
const REASONS = {
  "no-end-header": "zip END header not found",
  "bad-central-directory-offset": "invalid END header (bad central directory offset)",
  "bad-signature": "invalid CEN header (bad signature)",
  "bad-header-size": "invalid CEN header (bad header size)",
  "encrypted-entry": "invalid CEN header (encrypted entry)",
  "bad-compression-method": "invalid CEN header (bad compression method)",
  "bad-entry-name": "invalid CEN header (bad entry name)",
} as const;

export class ZipFormatError extends Schema.TaggedError<ZipFormatError>()("ZipFormatError", {
  reason: Schema.Literals([
    "no-end-header",
    "bad-central-directory-offset",
    "bad-signature",
    "bad-header-size",
    "encrypted-entry",
    "bad-compression-method",
    "bad-entry-name",
  ]),
}) {
  override get message(): string {
    return REASONS[this.reason];
  }

  get isCentralDirectoryError() {
    return this.message.startsWith("invalid CEN header");
  }
}

export class ZipEntryError extends Schema.TaggedError<ZipEntryError>()("ZipEntryError", {
  name: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Cannot read ZIP entry ${this.name}.`;
  }
}

export interface ZipEntry {
  readonly name: string;
  // The MS-DOS modification time, and the Unix one an extended timestamp field records, if any.
  readonly dosTime: number;
  readonly dosDate: number;
  readonly unixTime: number | undefined;
  readonly isDirectory: boolean;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

export interface ZipArchive {
  readonly bytes: Uint8Array;
  readonly entries: ReadonlyArray<ZipEntry>;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const ZIP64_EXTRA = 0x0001;
const UINT32_MAX = 0xffffffff;

const utf8 = new TextDecoder("utf-8", { fatal: true });

const findEndOfCentralDirectory = (view: DataView) => {
  // The end record is 22 bytes plus a comment of up to 65535 bytes.
  const lowest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
};

interface Directory {
  readonly count: number;
  readonly start: number;
  readonly size: number;
  // Bytes before the archive proper (a self-extracting stub); every recorded offset shifts by it.
  readonly prefix: number;
}

const locateDirectory = (view: DataView, end: number): Directory | undefined => {
  let count = view.getUint16(end + 10, true);
  let size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  let directoryEnd = end;
  if ((count === 0xffff || offset === UINT32_MAX || size === UINT32_MAX) && end >= 20) {
    const locator = end - 20;
    if (view.getUint32(locator, true) === ZIP64_LOCATOR) {
      const zip64End = Number(view.getBigUint64(locator + 8, true));
      if (zip64End + 56 <= view.byteLength && view.getUint32(zip64End, true) === ZIP64_END) {
        count = Number(view.getBigUint64(zip64End + 32, true));
        size = Number(view.getBigUint64(zip64End + 40, true));
        offset = Number(view.getBigUint64(zip64End + 48, true));
        directoryEnd = zip64End;
      }
    }
  }
  const start = directoryEnd - size;
  if (start < 0 || offset > start) return undefined;
  return { count, start, size, prefix: start - offset };
};

// The ZIP64 extended-information extra field replaces size and offset fields that overflowed.
const EXTENDED_TIMESTAMP = 0x5455;

// The modification time of an extended timestamp field, in seconds since the epoch.
const extendedTimestamp = (view: DataView, extraStart: number, extraLength: number) => {
  let cursor = extraStart;
  const end = extraStart + extraLength;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const length = view.getUint16(cursor + 2, true);
    if (id === EXTENDED_TIMESTAMP && length >= 5 && (view.getUint8(cursor + 4) & 1) !== 0) {
      return view.getInt32(cursor + 5, true);
    }
    cursor += 4 + length;
  }
  return undefined;
};

const zip64Values = (
  view: DataView,
  extraStart: number,
  extraLength: number,
  overflowed: ReadonlyArray<boolean>,
) => {
  let cursor = extraStart;
  const end = extraStart + extraLength;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const length = view.getUint16(cursor + 2, true);
    if (id === ZIP64_EXTRA) {
      const values: Array<number | undefined> = [];
      let field = cursor + 4;
      for (const isOverflowed of overflowed) {
        if (isOverflowed && field + 8 <= cursor + 4 + length) {
          values.push(Number(view.getBigUint64(field, true)));
          field += 8;
        } else values.push(undefined);
      }
      return values;
    }
    cursor += 4 + length;
  }
  return overflowed.map(() => undefined);
};

// Reads the central directory with java.util.zip.ZipFile's rules: names must be UTF-8, and
// encrypted entries or unsupported compression methods make the archive unreadable.
export const parse = Effect.fn("Zip.parse")(function* (bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) return yield* new ZipFormatError({ reason: "no-end-header" });
  const directory = locateDirectory(view, end);
  if (directory === undefined)
    return yield* new ZipFormatError({ reason: "bad-central-directory-offset" });
  const directoryEnd = directory.start + directory.size;
  const entries: Array<ZipEntry> = [];
  let offset = directory.start;
  for (let index = 0; index < directory.count; index++) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) {
      return yield* new ZipFormatError({ reason: "bad-signature" });
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength + extraLength + commentLength > directoryEnd) {
      return yield* new ZipFormatError({ reason: "bad-header-size" });
    }
    if ((flags & 1) !== 0) return yield* new ZipFormatError({ reason: "encrypted-entry" });
    if (method !== 0 && method !== 8)
      return yield* new ZipFormatError({ reason: "bad-compression-method" });
    const name = yield* Effect.try({
      try: () => utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      catch: () => new ZipFormatError({ reason: "bad-entry-name" }),
    });
    const recorded = [
      view.getUint32(offset + 24, true),
      view.getUint32(offset + 20, true),
      view.getUint32(offset + 42, true),
    ] as const;
    const [size, compressedSize, localHeaderOffset] = zip64Values(
      view,
      offset + 46 + nameLength,
      extraLength,
      recorded.map((value) => value === UINT32_MAX),
    ).map((value, position) => value ?? recorded[position] ?? 0);
    entries.push({
      name,
      dosTime: view.getUint16(offset + 12, true),
      dosDate: view.getUint16(offset + 14, true),
      unixTime: extendedTimestamp(view, offset + 46 + nameLength, extraLength),
      isDirectory: name.endsWith("/"),
      method,
      compressedSize: compressedSize ?? 0,
      size: size ?? 0,
      localHeaderOffset: (localHeaderOffset ?? 0) + directory.prefix,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, entries } satisfies ZipArchive;
});

// Inflates at most `limit` bytes, so a tiny entry cannot expand into gigabytes.
const inflateRaw = (name: string, data: Uint8Array, limit: number) =>
  Effect.tryPromise({
    try: async () => {
      const reader = new Blob([new Uint8Array(data)])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))
        .getReader();
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
      const output = new Uint8Array(total);
      let position = 0;
      for (const chunk of chunks) {
        output.set(chunk, position);
        position += chunk.length;
      }
      return output;
    },
    catch: (cause) => new ZipEntryError({ name, cause }),
  }).pipe(
    Effect.filterOrFail(
      (output) => output !== undefined,
      () => new ZipEntryError({ name, cause: "entry inflates past its declared size" }),
    ),
  );

export const read = Effect.fn("Zip.read")(function* (archive: ZipArchive, entry: ZipEntry) {
  const view = new DataView(
    archive.bytes.buffer,
    archive.bytes.byteOffset,
    archive.bytes.byteLength,
  );
  const header = entry.localHeaderOffset;
  if (
    header + 30 > archive.bytes.byteLength ||
    view.getUint32(header, true) !== LOCAL_FILE_HEADER
  ) {
    return yield* new ZipEntryError({ name: entry.name, cause: "bad local file header" });
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const data = archive.bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  return yield* inflateRaw(entry.name, data, entry.size);
});
