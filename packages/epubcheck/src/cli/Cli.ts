import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as EpubCheck from "../EpubCheck.ts";
import type { Severity } from "../messages/MessageCatalog.ts";
import * as JsonReport from "../report/JsonReport.ts";
import type * as Report from "../report/Report.ts";

export class CliUsageError extends Schema.TaggedError<CliUsageError>()("CliUsageError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export interface CliOptions {
  readonly path: string | undefined;
  readonly mode: EpubCheck.CheckMode | "exp" | undefined;
  readonly version: EpubCheck.EpubVersion | undefined;
  readonly profile: EpubCheck.Profile | undefined;
  readonly reportingLevel: Severity;
  readonly json: string | undefined;
  readonly locale: string | undefined;
  readonly failOnWarnings: boolean;
  readonly quiet: boolean;
}

const modes = ["epub", "opf", "xhtml", "svg", "nav", "mo", "exp"] as const;
const profiles = ["default", "edupub", "dict", "idx", "preview"] as const;
const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: string): value is T =>
  values.some((candidate) => candidate === value);

// Upstream accepts both `-flag` and `--flag` spellings for long options.
export const parseArgs = Effect.fn("Cli.parseArgs")(function* (argv: ReadonlyArray<string>) {
  const options: { -readonly [K in keyof CliOptions]: CliOptions[K] } = {
    path: undefined,
    mode: undefined,
    version: undefined,
    profile: undefined,
    reportingLevel: "INFO",
    json: undefined,
    locale: undefined,
    failOnWarnings: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const flag = arg.replace(/^--?/, "");
    const value = Effect.fnUntraced(function* () {
      const next = argv[++index];
      if (next === undefined) {
        return yield* new CliUsageError({ reason: `Missing value for option ${arg}.` });
      }
      return next;
    });
    if (!arg.startsWith("-") || arg === "-") {
      options.path = arg;
      continue;
    }
    switch (flag) {
      case "mode":
      case "m": {
        const mode = yield* value();
        if (!isOneOf(modes, mode)) {
          return yield* new CliUsageError({ reason: `Unrecognized mode: ${mode}.` });
        }
        options.mode = mode;
        break;
      }
      case "v": {
        const version = (yield* value()).slice(0, 1);
        if (version !== "2" && version !== "3") {
          return yield* new CliUsageError({ reason: `Unrecognized EPUB version: ${version}.` });
        }
        options.version = version;
        break;
      }
      case "profile":
      case "p": {
        const profile = yield* value();
        if (!isOneOf(profiles, profile)) {
          return yield* new CliUsageError({ reason: `Unrecognized profile: ${profile}.` });
        }
        options.profile = profile;
        break;
      }
      case "json":
      case "j":
        options.json = yield* value();
        break;
      case "locale":
        options.locale = yield* value();
        break;
      case "fatal":
      case "f":
        options.reportingLevel = "FATAL";
        break;
      case "error":
      case "e":
        options.reportingLevel = "ERROR";
        break;
      case "warn":
      case "w":
        options.reportingLevel = "WARNING";
        break;
      case "usage":
      case "u":
        options.reportingLevel = "USAGE";
        break;
      case "failonwarnings":
        options.failOnWarnings = true;
        break;
      case "quiet":
      case "q":
        options.quiet = true;
        break;
      default:
        return yield* new CliUsageError({ reason: `Unrecognized argument: ${arg}.` });
    }
  }
  return options;
});

const formatLine = (checkedPath: string, message: Report.Message) => {
  // Upstream omits the location path when it repeats the checked file name.
  const file = checkedPath.endsWith(message.location.path) ? "" : `/${message.location.path}`;
  const text = message.message.replace(/\s+/g, " ");
  return `${message.severity}(${message.id}): ${checkedPath}${file}(${message.location.line},${message.location.column}): ${text}`;
};

export const run = Effect.fn("Cli.run")(function* (options: CliOptions) {
  const checker = yield* EpubCheck.EpubCheck;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (options.path === undefined) {
    return yield* new CliUsageError({ reason: "At least one argument expected." });
  }
  const result = yield* checker.check({
    path: options.path,
    ...(options.mode === undefined || options.mode === "exp" ? {} : { mode: options.mode }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    reportingLevel: options.reportingLevel,
  });
  const checkedPath = path.relative(process.cwd(), result.path) || result.path;
  if (!options.quiet) {
    for (const message of result.messages) {
      const line = formatLine(checkedPath, message);
      yield* message.severity === "USAGE" ? Console.log(line) : Console.error(line);
    }
  }
  if (options.json !== undefined) {
    const json = JsonReport.render(result);
    yield* options.json === "-"
      ? Console.log(json)
      : fs.writeFileString(options.json, json).pipe(Effect.orDie);
  }
  const fatals = EpubCheck.countBySeverity(result.messages, "FATAL");
  const errors = EpubCheck.countBySeverity(result.messages, "ERROR");
  const warnings = EpubCheck.countBySeverity(result.messages, "WARNING");
  if (!options.quiet) {
    if (fatals + errors > 0) yield* Console.log("\nCheck finished with errors");
    else if (warnings > 0) yield* Console.log("\nCheck finished with warnings");
    else yield* Console.log("No errors or warnings detected.");
    yield* Console.log(
      `Messages: ${fatals} fatals / ${errors} errors / ${warnings} warnings / ${EpubCheck.countBySeverity(result.messages, "INFO")} infos\n`,
    );
    yield* Console.log("EPUBCheck completed");
  }
  return fatals + errors > 0 || (options.failOnWarnings && warnings > 0) ? 1 : 0;
});

export const main = Effect.fn("Cli.main")(function* (argv: ReadonlyArray<string>) {
  const exitCode = yield* parseArgs(argv).pipe(
    Effect.flatMap(run),
    Effect.catchTags({
      CliUsageError: (error) => Console.error(error.message).pipe(Effect.as(1)),
    }),
  );
  process.exitCode = exitCode;
});
