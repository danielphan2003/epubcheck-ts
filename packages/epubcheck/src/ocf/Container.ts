import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Dates from "../report/Dates.ts";
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
  // When `META-INF/container.xml` was made, as upstream's reports state it.
  readonly created: string | undefined;
  // None when the container has no such file; a failure when the file exists but cannot be read.
  readonly read: (path: string) => Effect.Effect<Option.Option<Uint8Array>, ResourceReadError>;
}

const pad = (value: number) => String(value).padStart(2, "0");

// Java's ZipEntry.getTime, printed in local time: an extended timestamp, or the MS-DOS fields.
const entryTime = (entry: Zip.ZipEntry) => {
  if (entry.unixTime !== undefined) return Dates.localWithZ(entry.unixTime * 1000);
  const { dosDate: date, dosTime: time } = entry;
  const day = `${1980 + (date >> 9)}-${pad((date >> 5) & 15)}-${pad(date & 31)}`;
  return `${day}T${pad(time >> 11)}:${pad((time >> 5) & 63)}:${pad((time & 31) * 2)}Z`;
};

export const fromZip = (archive: Zip.ZipArchive): Container => {
  // Look names up NFC-normalized: references may use another normalization form.
  const byName = new Map(archive.entries.map((entry) => [entry.name.normalize("NFC"), entry]));
  const container = byName.get("META-INF/container.xml");
  return {
    packaged: true,
    created: container === undefined ? undefined : entryTime(container),
    files: archive.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
    directories: archive.entries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
    read: (path) => {
      const entry = byName.get(path.normalize("NFC"));
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
  let created: string | undefined;
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
        if (child === "META-INF/container.xml") {
          created = Option.getOrUndefined(
            Option.map(info.value.birthtime, (time) => Dates.fileTime(time.getTime())),
          );
        }
      }
    }
    pending.push(...children.reverse());
  }
  const known = new Map(files.map((file) => [file.normalize("NFC"), file] as const));
  return {
    packaged: false,
    created,
    files,
    directories,
    read: (relative: string) => {
      const file = known.get(relative.normalize("NFC"));
      return file !== undefined
        ? fs.readFile(path.join(root, file)).pipe(
            Effect.asSome,
            Effect.mapError((cause) => new ResourceReadError({ path: relative, cause })),
          )
        : Effect.succeedNone;
    },
  } satisfies Container;
});
