import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Zip from "./Zip.ts";

export class ResourceReadError extends Schema.TaggedError<ResourceReadError>()(
  "ResourceReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Cannot read container resource ${this.path}.`;
  }
}

export class SymbolicLinkError extends Schema.TaggedError<SymbolicLinkError>()(
  "SymbolicLinkError",
  { path: Schema.String },
) {
  // Upstream's wording, reported in PKG-008.
  override get message(): string {
    return "java.io.IOException: symbolic links are disallowed";
  }
}

// The publication's resources, from a ZIP archive or an expanded directory.
export interface Container {
  readonly packaged: boolean;
  // Container-relative paths, in archive or directory-walk order.
  readonly files: ReadonlyArray<string>;
  readonly directories: ReadonlyArray<string>;
  // None when the container has no such file; a failure when the file exists but cannot be read.
  readonly read: (path: string) => Effect.Effect<Option.Option<Uint8Array>, ResourceReadError>;
}

export const fromZip = (archive: Zip.ZipArchive): Container => {
  const byName = new Map(archive.entries.map((entry) => [entry.name, entry]));
  return {
    packaged: true,
    files: archive.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
    directories: archive.entries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
    read: (path) => {
      const entry = byName.get(path);
      if (entry === undefined || entry.isDirectory) return Effect.succeedNone;
      return Zip.read(archive, entry).pipe(
        Effect.asSome,
        Effect.mapError((cause) => new ResourceReadError({ path, cause })),
      );
    },
  };
};

// Walks the directory depth-first, parents before children, like Java's Files.walk, and rejects
// symbolic links as upstream does.
export const fromDirectory = Effect.fn("Container.fromDirectory")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const directories: Array<string> = [];
  const pending: Array<string> = [""];
  while (pending.length > 0) {
    const relative = pending.pop() ?? "";
    const names = yield* fs
      .readDirectory(relative === "" ? root : path.join(root, relative))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const children: Array<string> = [];
    for (const name of [...names].sort()) {
      const child = relative === "" ? name : `${relative}/${name}`;
      const info = yield* fs.lstat(path.join(root, child)).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "SymbolicLink") return yield* new SymbolicLinkError({ path: child });
      if (info.value.type === "Directory") {
        directories.push(child);
        children.push(child);
      } else {
        files.push(child);
      }
    }
    pending.push(...children.reverse());
  }
  const known = new Set(files);
  return {
    packaged: false,
    files,
    directories,
    read: (relative: string) =>
      known.has(relative)
        ? fs.readFile(path.join(root, relative)).pipe(
            Effect.asSome,
            Effect.mapError((cause) => new ResourceReadError({ path: relative, cause })),
          )
        : Effect.succeedNone,
  } satisfies Container;
});
