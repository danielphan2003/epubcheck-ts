import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Zip from "./Zip.ts";

// The publication's resources, from a ZIP archive or an expanded directory.
export interface Container {
  readonly packaged: boolean;
  // Container-relative paths, in archive or directory-walk order.
  readonly files: ReadonlyArray<string>;
  readonly directories: ReadonlyArray<string>;
  readonly zip: Zip.ZipArchive | undefined;
  readonly read: (path: string) => Effect.Effect<Option.Option<Uint8Array>>;
}

export const fromZip = (archive: Zip.ZipArchive): Container => {
  const byName = new Map(archive.entries.map((entry) => [entry.name, entry]));
  return {
    packaged: true,
    files: archive.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
    directories: archive.entries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
    zip: archive,
    read: (path) => {
      const entry = byName.get(path);
      if (entry === undefined || entry.isDirectory) return Effect.succeedNone;
      return Zip.read(archive, entry).pipe(Effect.option);
    },
  };
};

export const fromDirectory = Effect.fn("Container.fromDirectory")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const directories: Array<string> = [];
  // Walk depth-first, parents before children, like Java's Files.walk.
  const walk = Effect.fnUntraced(function* (relative: string): Effect.fn.Return<void, never> {
    const names = yield* fs
      .readDirectory(relative === "" ? root : path.join(root, relative))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of [...names].sort()) {
      const child = relative === "" ? name : `${relative}/${name}`;
      const info = yield* fs.stat(path.join(root, child)).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory") {
        directories.push(child);
        yield* walk(child);
      } else {
        files.push(child);
      }
    }
  });
  yield* walk("");
  const known = new Set(files);
  return {
    packaged: false,
    files,
    directories,
    zip: undefined,
    read: (relative: string) =>
      known.has(relative)
        ? fs.readFile(path.join(root, relative)).pipe(Effect.option)
        : Effect.succeedNone,
  } satisfies Container;
});
