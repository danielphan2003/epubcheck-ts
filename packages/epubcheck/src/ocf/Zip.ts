import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ZipFormatError extends Schema.TaggedError<ZipFormatError>()("ZipFormatError", {
  reason: Schema.Literals([
    "no-end-of-central-directory",
    "bad-central-directory",
    "bad-entry-name",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "no-end-of-central-directory":
        return "zip END header not found";
      case "bad-central-directory":
        return "invalid CEN header (bad signature)";
      case "bad-entry-name":
        return "invalid CEN header (bad entry name)";
    }
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

const utf8 = new TextDecoder("utf-8", { fatal: true });

const findEndOfCentralDirectory = (view: DataView) => {
  // The end record is 22 bytes plus a comment of up to 65535 bytes.
  const lowest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
};

// Reads the central directory like java.util.zip.ZipFile: names must decode as UTF-8.
export const parse = Effect.fn("Zip.parse")(function* (bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) return yield* new ZipFormatError({ reason: "no-end-of-central-directory" });
  let count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if ((count === 0xffff || offset === 0xffffffff) && end >= 20) {
    const locator = end - 20;
    if (view.getUint32(locator, true) === ZIP64_LOCATOR) {
      const zip64End = Number(view.getBigUint64(locator + 8, true));
      if (zip64End + 56 <= bytes.byteLength && view.getUint32(zip64End, true) === ZIP64_END) {
        count = Number(view.getBigUint64(zip64End + 32, true));
        offset = Number(view.getBigUint64(zip64End + 48, true));
      }
    }
  }
  const entries: Array<ZipEntry> = [];
  for (let index = 0; index < count; index++) {
    if (
      offset + 46 > bytes.byteLength ||
      view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY
    ) {
      return yield* new ZipFormatError({ reason: "bad-central-directory" });
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = yield* Effect.try({
      try: () => utf8.decode(nameBytes),
      catch: () => new ZipFormatError({ reason: "bad-entry-name" }),
    });
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      method,
      compressedSize,
      size,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, entries } satisfies ZipArchive;
});

const inflateRaw = (name: string, data: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      new Response(
        new Blob([new Uint8Array(data)])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw")),
      ).arrayBuffer(),
    catch: (cause) => new ZipEntryError({ name, cause }),
  }).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

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
  switch (entry.method) {
    case 0:
      return data;
    case 8:
      return yield* inflateRaw(entry.name, data);
    default:
      return yield* new ZipEntryError({
        name: entry.name,
        cause: `compression method ${entry.method}`,
      });
  }
});
