import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Zip from "./Zip.ts";
import * as ZipWriter from "./ZipWriter.ts";

describe("ZipWriter.write", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it.effect("writes an archive the reader reads back, mimetype first and stored", () =>
    Effect.gen(function* () {
      // 2024-05-06 07:08:10 local time.
      const modified = DateTime.toEpochMillis(
        DateTime.makeZonedUnsafe(
          { year: 2024, month: 5, day: 6, hour: 7, minute: 8, second: 10 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        ),
      );
      const entries = [
        { name: "mimetype", data: encode("application/epub+zip"), modified },
        { name: "EPUB/content é.xhtml", data: encode("<html/>".repeat(100)), modified },
      ];
      const archive = yield* Zip.parse(yield* ZipWriter.write(entries));
      expect(archive.entries.map((entry) => [entry.name, entry.method])).toEqual([
        ["mimetype", 0],
        ["EPUB/content é.xhtml", 8],
      ]);
      for (const [index, entry] of archive.entries.entries()) {
        expect(yield* Zip.read(archive, entry)).toEqual(entries[index]?.data);
      }
      const view = new DataView(archive.bytes.buffer);
      expect(view.getUint16(10, true)).toBe((7 << 11) | (8 << 5) | 5);
      expect(view.getUint16(12, true)).toBe(((2024 - 1980) << 9) | (5 << 5) | 6);
    }),
  );
});
