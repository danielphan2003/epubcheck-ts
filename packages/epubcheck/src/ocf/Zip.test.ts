import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Zip from "./Zip.ts";

interface EntrySpec {
  readonly name: Uint8Array;
  readonly data: Uint8Array;
  readonly flags?: number;
  readonly method?: number;
}

const encode = (text: string) => new TextEncoder().encode(text);

// Builds a stored-entry archive; `tamper` edits the bytes once they are laid out.
const archive = (
  entries: ReadonlyArray<EntrySpec>,
  options: {
    readonly prefix?: number;
    readonly tamper?: (bytes: Uint8Array, directory: number) => void;
  } = {},
) => {
  const parts: Array<Uint8Array> = [new Uint8Array(options.prefix ?? 0)];
  const central: Array<Uint8Array> = [];
  let offset = 0;
  for (const entry of entries) {
    const local = new Uint8Array(30 + entry.name.length + entry.data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(6, entry.flags ?? 0, true);
    view.setUint16(8, entry.method ?? 0, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    local.set(entry.data, 30 + entry.name.length);
    const header = new Uint8Array(46 + entry.name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(8, entry.flags ?? 0, true);
    headerView.setUint16(10, entry.method ?? 0, true);
    headerView.setUint32(20, entry.data.length, true);
    headerView.setUint32(24, entry.data.length, true);
    headerView.setUint16(28, entry.name.length, true);
    headerView.setUint32(42, offset, true);
    header.set(entry.name, 46);
    parts.push(local);
    central.push(header);
    offset += local.length;
  }
  const directorySize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const bytes = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
  let position = 0;
  for (const part of all) {
    bytes.set(part, position);
    position += part.length;
  }
  options.tamper?.(bytes, (options.prefix ?? 0) + offset);
  return bytes;
};

const mimetype = { name: encode("mimetype"), data: encode("application/epub+zip") };

const failure = (bytes: Uint8Array) =>
  Zip.parse(bytes).pipe(
    Effect.map(() => "parsed"),
    Effect.catchTags({ ZipFormatError: (error) => Effect.succeed(error.message) }),
  );

describe("Zip.parse", () => {
  // The messages are the JDK's, which upstream reports in PKG-008 and PKG-027.
  it.effect.each([
    {
      name: "no end record",
      bytes: encode("not a zip at all"),
      expected: "zip END header not found",
    },
    {
      name: "a central directory offset past the file",
      bytes: archive([mimetype], {
        tamper: (bytes) => new DataView(bytes.buffer).setUint32(bytes.length - 6, 999, true),
      }),
      expected: "invalid END header (bad central directory offset)",
    },
    {
      name: "a bad central directory signature",
      bytes: archive([mimetype], {
        tamper: (bytes, directory) => bytes.set([0, 0, 0, 0], directory),
      }),
      expected: "invalid CEN header (bad signature)",
    },
    {
      name: "an encrypted entry",
      bytes: archive([{ ...mimetype, flags: 1 }]),
      expected: "invalid CEN header (encrypted entry)",
    },
    {
      name: "an unsupported compression method",
      bytes: archive([{ ...mimetype, method: 12 }]),
      expected: "invalid CEN header (bad compression method)",
    },
    {
      name: "a name running past the directory",
      bytes: archive([mimetype], {
        tamper: (bytes, directory) =>
          new DataView(bytes.buffer).setUint16(directory + 28, 500, true),
      }),
      expected: "invalid CEN header (bad header size)",
    },
    {
      name: "a name that is not UTF-8",
      bytes: archive([{ name: new Uint8Array([0x66, 0xff, 0x6f]), data: encode("x") }]),
      expected: "invalid CEN header (bad entry name)",
    },
  ])("reports $name", ({ bytes, expected }) =>
    Effect.gen(function* () {
      expect(yield* failure(bytes)).toBe(expected);
    }),
  );

  it.effect("reads stored entries, also behind a stub prefix", () =>
    Effect.gen(function* () {
      for (const prefix of [0, 64]) {
        const parsed = yield* Zip.parse(
          archive([mimetype, { name: encode("EPUB/ü.xhtml"), data: encode("<x/>") }], { prefix }),
        );
        expect(parsed.entries.map((entry) => entry.name)).toEqual(["mimetype", "EPUB/ü.xhtml"]);
        const [first] = parsed.entries;
        if (first === undefined) return yield* Effect.die("no entry");
        expect(new TextDecoder().decode(yield* Zip.read(parsed, first))).toBe(
          "application/epub+zip",
        );
      }
    }),
  );
});
