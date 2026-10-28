import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { EpubCheck, MessageCatalog, type Report } from "epubcheck-ts";

export class ReferenceJarMissing extends Schema.TaggedError<ReferenceJarMissing>()(
  "ReferenceJarMissing",
  { jar: Schema.String },
) {
  override get message(): string {
    return `Reference EPUBCheck jar not found at ${this.jar}. Run \`pnpm fetch:epubcheck-jar\` first.`;
  }
}

export class ReferenceRunFailed extends Schema.TaggedError<ReferenceRunFailed>()(
  "ReferenceRunFailed",
  { input: Schema.String, exitCode: Schema.Number },
) {
  override get message(): string {
    return `The reference EPUBCheck jar produced no JSON report for ${this.input} (exit code ${this.exitCode}).`;
  }
}

const ReferenceLocation = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  line: Schema.Number,
  column: Schema.Number,
  context: Schema.NullOr(Schema.String),
});

const ReferenceReport = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      ID: Schema.String,
      severity: Schema.String,
      message: Schema.String,
      additionalLocations: Schema.Number,
      locations: Schema.Array(ReferenceLocation),
      suggestion: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeReferenceReport = Schema.decodeEffect(Schema.fromJsonString(ReferenceReport));

export interface ReferenceOptions {
  readonly jar: string;
  readonly cacheDir: string;
  readonly resourcesDir: string;
}

type Invocation = EpubCheck.CheckRequest & {
  readonly mode: EpubCheck.CheckMode;
  readonly version: EpubCheck.EpubVersion;
  readonly profile: EpubCheck.Profile;
};

const jarArgs = (invocation: Invocation, input: string, isDirectory: boolean) => [
  input,
  ...(invocation.mode === "epub"
    ? isDirectory
      ? ["--mode", "exp"]
      : []
    : ["--mode", invocation.mode, "-v", `${invocation.version}.0`]),
  ...(invocation.profile === "default" ? [] : ["--profile", invocation.profile]),
  ...(invocation.locale === undefined || invocation.locale === "en"
    ? []
    : ["--locale", invocation.locale]),
  "-u",
  "--maxOfEachMessage",
  "unlimited",
];

const isKnownSeverity = (value: string): value is Report.Message["severity"] =>
  value === "FATAL" ||
  value === "ERROR" ||
  value === "WARNING" ||
  value === "USAGE" ||
  value === "INFO" ||
  value === "SUPPRESSED";

// Runs the pinned jar on a private copy of the input and caches its JSON report under .cache.
export const runReference = Effect.fn("Differential.runReference")(function* (
  options: ReferenceOptions,
  invocation: Invocation,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relative = path.relative(options.resourcesDir, invocation.path);
  // Fixtures are pinned upstream files, so the input path and options identify a report.
  const key = [
    relative.replace(/[\\/]/g, "__"),
    invocation.mode,
    invocation.version,
    invocation.profile,
    invocation.locale ?? "en",
  ];
  const cached = path.join(
    options.cacheDir,
    path.basename(path.dirname(options.jar)),
    `${key.join(".")}.json`,
  );
  const workDir = yield* fs.makeTempDirectoryScoped({ prefix: "epubcheck-diff-" });
  const input = path.join(workDir, path.basename(invocation.path));
  if (!(yield* fs.exists(cached))) {
    // `--mode exp` writes a temporary .epub next to the directory, so check a private copy.
    yield* fs.copy(invocation.path, input);
    const isDirectory = (yield* fs.stat(input)).type === "Directory";
    const output = path.join(workDir, "report.json");
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(
        "java",
        [
          "-XX:TieredStopAtLevel=1",
          "-XX:+UseSerialGC",
          "-jar",
          options.jar,
          ...jarArgs(invocation, input, isDirectory),
          "--json",
          output,
        ],
        { stdout: "ignore", stderr: "ignore", cwd: workDir },
      ),
    );
    if (!(yield* fs.exists(output))) {
      return yield* new ReferenceRunFailed({ input: relative, exitCode });
    }
    // Strip the private copy's location so cached reports are stable across runs.
    const text = (yield* fs.readFileString(output)).replaceAll(`${workDir}/`, "");
    yield* fs.makeDirectory(path.dirname(cached), { recursive: true });
    yield* fs.writeFileString(cached, text);
  }
  const report = yield* decodeReferenceReport(yield* fs.readFileString(cached));
  const threshold = MessageCatalog.severityRank(invocation.reportingLevel ?? "INFO");
  const container = path.basename(invocation.path);
  return report.messages.flatMap((message): ReadonlyArray<Report.Message> => {
    // Upstream prints a few IDs with an underscore (`HTM_056`); the catalog uses hyphens.
    const id = message.ID.replace("_", "-");
    const severity = message.severity;
    if (!isKnownSeverity(severity) || !MessageCatalog.isMessageId(id)) return [];
    if (MessageCatalog.severityRank(severity) < threshold) return [];
    return message.locations.map((location) => ({
      id,
      severity,
      message: message.message,
      suggestion: message.suggestion ?? "",
      location: {
        path: (location.path ?? "").replace(`${container}/`, ""),
        line: location.line,
        column: location.column,
        context: location.context ?? undefined,
      },
    }));
  });
}, Effect.scoped);

// An EpubCheck implementation backed by the reference jar, used to validate the harness itself.
export const referenceLayer = (options: ReferenceOptions) =>
  Layer.effect(
    EpubCheck.EpubCheck,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
      >();
      const check = Effect.fn("ReferenceEpubCheck.check")(function* (
        request: EpubCheck.CheckRequest,
      ) {
        const invocation: Invocation = {
          ...request,
          mode: request.mode ?? EpubCheck.inferMode(request.path),
          version: request.version ?? "3",
          profile: request.profile ?? "default",
        };
        const messages = yield* runReference(options, invocation).pipe(
          Effect.provide(context),
          Effect.orDie,
        );
        return {
          path: request.path,
          mode: invocation.mode,
          messages,
        } satisfies EpubCheck.CheckResult;
      });
      return EpubCheck.EpubCheck.of({ check });
    }),
  );

export interface Difference {
  readonly path: string;
  readonly mode: EpubCheck.CheckMode;
  readonly missing: ReadonlyArray<string>;
  readonly extra: ReadonlyArray<string>;
}

const multiset = (messages: ReadonlyArray<Report.Message>) => {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = `${message.severity} ${message.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const subtract = (left: Map<string, number>, right: Map<string, number>) =>
  [...left].flatMap(([key, count]) =>
    Array.from({ length: Math.max(0, count - (right.get(key) ?? 0)) }, () => key),
  );

export const compare = (
  path: string,
  mode: EpubCheck.CheckMode,
  ours: ReadonlyArray<Report.Message>,
  reference: ReadonlyArray<Report.Message>,
): Difference => {
  const left = multiset(ours);
  const right = multiset(reference);
  return { path, mode, missing: subtract(right, left), extra: subtract(left, right) };
};
