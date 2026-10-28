import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as EpubCheck from "../EpubCheck.ts";
import * as MessageCatalog from "../messages/MessageCatalog.ts";
import * as Container from "../ocf/Container.ts";
import * as ZipWriter from "../ocf/ZipWriter.ts";
import * as Groups from "../report/Groups.ts";
import * as JsonReport from "../report/JsonReport.ts";
import * as Report from "../report/Report.ts";
import * as XmlReport from "../report/XmlReport.ts";
import { bundles } from "./strings.generated.ts";

// A command line compatible with upstream's: the same options, the same console text (from
// upstream's bundles) on the same streams, and the same exit codes.

export class Terminal extends Context.Service<
  Terminal,
  {
    readonly stdout: (text: string) => Effect.Effect<void>;
    readonly stderr: (text: string) => Effect.Effect<void>;
  }
>()("epubcheck-ts/cli/Cli/Terminal") {}

export const terminalLayer = Layer.succeed(
  Terminal,
  Terminal.of({
    stdout: Effect.fn("Terminal.stdout")(function* (text: string) {
      yield* Effect.sync(() => process.stdout.write(text));
    }),
    stderr: Effect.fn("Terminal.stderr")(function* (text: string) {
      yield* Effect.sync(() => process.stderr.write(text));
    }),
  }),
);

const LOCALES = Object.keys(bundles).filter((locale) => locale !== "default");

// Like Java's ResourceBundle: the requested locale, then the default locale, then English.
const resolveLocale = (requested: string | undefined, fallback: string) => {
  for (const tag of [requested, fallback]) {
    if (tag === undefined) continue;
    const parts = tag.split(/[-_]/);
    for (let length = parts.length; length > 0; length--) {
      const candidate = parts.slice(0, length).join("-").toLowerCase();
      const match = LOCALES.find((locale) => locale.toLowerCase() === candidate);
      if (match !== undefined) return match;
    }
  }
  return "en";
};

const text = (locale: string, key: string, ...args: ReadonlyArray<string>) => {
  const language = locale.split("-")[0] ?? locale;
  const pattern =
    bundles[locale]?.[key] ?? bundles[language]?.[key] ?? bundles["default"]?.[key] ?? key;
  return MessageCatalog.formatJava(pattern, args);
};

type ReportFormat = "json" | "xml" | "xmp";
type ReportingLevel = NonNullable<EpubCheck.CheckRequest["reportingLevel"]>;

export interface CliOptions {
  readonly path: string | undefined;
  readonly mode: EpubCheck.CheckMode | "exp" | undefined;
  readonly version: EpubCheck.EpubVersion | undefined;
  readonly profile: EpubCheck.Profile | undefined;
  readonly reportingLevel: ReportingLevel;
  // `-` writes the report to standard output.
  readonly report: { readonly format: ReportFormat; readonly target: string } | undefined;
  readonly maxOfEachMessage: number;
  readonly locale: string | undefined;
  readonly failOnWarnings: boolean;
  readonly quiet: boolean;
  readonly save: boolean;
  readonly showVersion: boolean;
  readonly help: boolean;
  readonly listChecks: { readonly target: string | undefined } | undefined;
  readonly customMessages: string | undefined;
}

export interface CliEnvironment {
  readonly cwd: string;
  readonly defaultLocale: string;
}

export interface CliOutcome {
  readonly exitCode: number;
  // The report's cap on locations per message, when a report was written (negative: unlimited).
  readonly maxOfEachMessage: number | undefined;
}

const MODES = ["epub", "opf", "xhtml", "svg", "nav", "mo", "exp"] as const;
const PROFILES = ["default", "edupub", "dict", "idx", "preview"] as const;
const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: string): value is T =>
  values.some((candidate) => candidate === value);

const LEVELS: Readonly<Record<string, ReportingLevel>> = {
  f: "FATAL",
  fatal: "FATAL",
  e: "ERROR",
  error: "ERROR",
  w: "WARNING",
  warn: "WARNING",
  u: "USAGE",
  usage: "USAGE",
};

// Options take one or two dashes, as upstream accepts both; the first error wins.
export const parseArgs = (argv: ReadonlyArray<string>, locale: string) => {
  let path: string | undefined;
  let mode: CliOptions["mode"];
  let version: CliOptions["version"];
  let profile: CliOptions["profile"];
  let reportingLevel: ReportingLevel = "INFO";
  let report: CliOptions["report"];
  let maxOfEachMessage = Groups.DEFAULT_MAX_OF_EACH_MESSAGE;
  let requestedLocale: string | undefined;
  let failOnWarnings = false;
  let quiet = false;
  let save = false;
  let showVersion = false;
  let help = false;
  let listChecks: CliOptions["listChecks"];
  let customMessages: string | undefined;

  const fail = (key: string, ...args: ReadonlyArray<string>) =>
    Result.fail(text(locale, key, ...args));
  if (argv.length === 0) return fail("argument_needed");
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    // An optional value: the next argument unless it is another option (`-` is stdout).
    const optional = () => {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) return undefined;
      index++;
      return next;
    };
    if (!arg.startsWith("-") || arg === "-") {
      path = arg;
      continue;
    }
    const flag = arg.replace(/^--?/, "");
    const level = LEVELS[flag];
    if (level !== undefined) {
      reportingLevel = level;
      continue;
    }
    switch (flag.toLowerCase() === "maxofeachmessage" ? "maxOfEachMessage" : flag) {
      case "mode":
      case "m": {
        const value = optional();
        if (value === undefined) return fail("mode_argument_expected");
        if (!isOneOf(MODES, value)) {
          return fail("mode_version_not_supported", value, version ?? "3.0");
        }
        mode = value;
        break;
      }
      case "v": {
        const value = optional();
        if (value === undefined) return fail("version_argument_expected");
        const major = value.slice(0, 1);
        if (major !== "2" && major !== "3") {
          return fail("mode_version_not_supported", mode ?? "epub", value);
        }
        version = major;
        break;
      }
      case "profile":
      case "p": {
        const value = optional();
        if (value === undefined) return fail("profile_argument_expected");
        // Upstream falls back to the default profile for an unknown name.
        profile = isOneOf(PROFILES, value) ? value : "default";
        break;
      }
      case "out":
      case "o":
      case "xmp":
      case "x":
      case "json":
      case "j": {
        if (report !== undefined) return fail("output_type_conflict");
        const format = flag.startsWith("o") ? "xml" : flag.startsWith("x") ? "xmp" : "json";
        report = { format, target: optional() ?? "-" };
        break;
      }
      case "maxOfEachMessage": {
        const value = argv[index + 1];
        if (value === undefined) return fail("missing_maxofeach");
        index++;
        if (value.toLowerCase() === "unlimited") maxOfEachMessage = -1;
        else if (/^[+-]?\d+$/.test(value)) maxOfEachMessage = Number(value);
        else return fail("incorrect_maxofeach", value);
        break;
      }
      case "locale": {
        const value = argv[index + 1];
        if (value === undefined) return fail("missing_locale");
        if (value.startsWith("-")) return fail("incorrect_locale", value);
        index++;
        requestedLocale = value;
        break;
      }
      case "save":
        save = true;
        break;
      case "failonwarnings":
        failOnWarnings = true;
        break;
      case "quiet":
      case "q":
        quiet = true;
        break;
      case "version":
        showVersion = true;
        break;
      case "help":
      case "h":
      case "?":
        help = true;
        break;
      case "listChecks":
      case "l":
        listChecks = { target: optional() };
        break;
      case "customMessages":
      case "c":
        customMessages = optional() ?? "";
        break;
      default:
        return fail("unrecognized_argument", arg);
    }
  }
  return Result.succeed<CliOptions>({
    path,
    mode,
    version,
    profile,
    reportingLevel,
    report,
    maxOfEachMessage,
    locale: requestedLocale,
    failOnWarnings,
    quiet,
    save,
    showVersion,
    help,
    listChecks,
    customMessages,
  });
};

const counter = (locale: string, kind: string, count: number) =>
  text(
    locale,
    `counter_${kind}_${count === 0 ? "zero" : count === 1 ? "one" : "many"}`,
    String(count),
  );

// Upstream's tab-separated override file: a header, then ID, severity, and an optional message
// and suggestion per line. Problems are reported as CHK messages.
const readCustomMessages = Effect.fn("Cli.readCustomMessages")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const report = yield* Report.Report;
  const at = Report.location(file);
  const overrides: Record<string, EpubCheck.Override> = {};
  const content = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(content)) {
    yield* report.message("CHK-001", at, file);
    return overrides;
  }
  for (const line of content.value.split(/\r?\n/).slice(1)) {
    if (line.trim() === "") continue;
    const [id = "", severity = "", message = "", suggestion = ""] = line.split("\t");
    if (!MessageCatalog.isMessageId(id)) {
      yield* report.message("CHK-002", at, id, file);
      continue;
    }
    if (!MessageCatalog.isSeverity(severity)) {
      yield* report.message("CHK-003", at, severity, file);
      continue;
    }
    const allowed = MessageCatalog.argumentCount(MessageCatalog.rawMessage(id));
    if (MessageCatalog.argumentCount(message) > allowed) {
      yield* report.message("CHK-004", at, file);
      continue;
    }
    if (MessageCatalog.argumentCount(suggestion) > allowed) {
      yield* report.message("CHK-005", at, file);
      continue;
    }
    overrides[id] = {
      severity,
      ...(message === "" ? {} : { message }),
      ...(suggestion === "" ? {} : { suggestion }),
    };
  }
  return overrides;
});

// Packages an expanded EPUB next to its directory, `mimetype` first, like upstream's `--save`.
const saveArchive = Effect.fn("Cli.saveArchive")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const container = yield* Container.fromDirectory(directory);
  const names = ["mimetype", ...container.files.filter((file) => file !== "mimetype")];
  const entries: Array<ZipWriter.Entry> = [];
  for (const name of names) {
    const data = yield* container.read(name);
    if (Option.isSome(data)) entries.push({ name, data: data.value });
  }
  yield* fs
    .writeFile(`${directory.replace(/[\\/]+$/, "")}.epub`, ZipWriter.write(entries))
    .pipe(Effect.orDie);
});

const listChecks = () =>
  [
    "ID\tSeverity\tMessage\tSuggestion",
    ...MessageCatalog.messageIds.map(
      (id) =>
        `${id}\t${MessageCatalog.defaultSeverity(id)}\t${MessageCatalog.rawMessage(id)}\t${MessageCatalog.formatSuggestion(id)}`,
    ),
  ].join("\n");

export const run = Effect.fn("Cli.run")(function* (
  options: CliOptions,
  environment: CliEnvironment,
) {
  const terminal = yield* Terminal;
  const checker = yield* EpubCheck.EpubCheck;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locale = resolveLocale(options.locale, environment.defaultLocale);
  const done = (exitCode: number): CliOutcome => ({
    exitCode,
    maxOfEachMessage: options.report === undefined ? undefined : options.maxOfEachMessage,
  });

  if (options.help) {
    yield* terminal.stdout(`${text(locale, "help_text", EpubCheck.VERSION)}\n`);
    return done(0);
  }
  if (options.showVersion) {
    yield* terminal.stdout(`${text(locale, "epubcheck_version_text", EpubCheck.VERSION)}\n`);
  }
  if (options.listChecks !== undefined) {
    const target = options.listChecks.target;
    if (target === undefined) yield* terminal.stdout(`${listChecks()}\n`);
    else {
      yield* fs
        .writeFileString(path.resolve(environment.cwd, target), `${listChecks()}\n`)
        .pipe(Effect.orDie);
    }
  }
  if (options.path === undefined) {
    if (options.showVersion || options.listChecks !== undefined) return done(0);
    yield* terminal.stderr(`${text(locale, "no_file_specified")}\n`);
    return done(1);
  }

  const startedAt = yield* Clock.currentTimeMillis;
  const target = path.resolve(environment.cwd, options.path);
  const isDirectory = yield* fs.stat(target).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
  // The console names an expanded EPUB after the archive upstream builds from it.
  const displayPath = isDirectory
    ? `./${path.basename(target)}.epub`
    : path.isAbsolute(options.path) || options.path.startsWith(".") || options.mode !== undefined
      ? options.path
      : `./${options.path}`;

  const preamble = yield* Report.make({ locale, reportingLevel: options.reportingLevel });
  const overrides =
    options.customMessages === undefined
      ? undefined
      : yield* readCustomMessages(path.resolve(environment.cwd, options.customMessages)).pipe(
          Effect.provideService(Report.Report, preamble),
        );
  const checked = yield* checker.check({
    path: target,
    ...(options.mode === undefined || options.mode === "exp" ? {} : { mode: options.mode }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    locale,
    reportingLevel: options.reportingLevel,
    ...(overrides === undefined ? {} : { overrides }),
  });
  const result = { ...checked, messages: [...(yield* preamble.messages), ...checked.messages] };
  const finishedAt = yield* Clock.currentTimeMillis;

  // A report on standard output replaces the console summary; problems still go to stderr.
  const quiet = options.quiet || options.report?.target === "-";
  const out = (line: string) => (quiet ? Effect.void : terminal.stdout(`${line}\n`));
  const err = (line: string) => terminal.stderr(`${line}\n`);
  if (result.publication !== undefined) {
    yield* out(
      text(
        locale,
        "validating_version_message",
        JsonReport.epubVersionLabel(result.publication.version),
      ),
    );
  }
  for (const message of result.messages) {
    const where = JsonReport.locationPath(result, message.location, displayPath);
    const file = where === displayPath ? displayPath : `${displayPath}/${where}`;
    const line = `${message.severity}(${message.id}): ${file}(${message.location.line},${message.location.column}): ${message.message}`;
    yield* message.severity === "USAGE" || message.severity === "INFO" ? out(line) : err(line);
  }

  const count = (severity: Report.Message["severity"]) =>
    result.messages.filter((message) => message.severity === severity).length;
  const fatals = count("FATAL");
  const errors = count("ERROR");
  const warnings = count("WARNING");
  if (fatals + errors > 0) yield* err(text(locale, "there_were_errors"));
  else if (warnings > 0) yield* err(text(locale, "there_were_warnings"));
  else yield* out(text(locale, "no_errors__or_warnings"));
  const counters = [
    counter(locale, "fatal", fatals),
    counter(locale, "error", errors),
    counter(locale, "warn", warnings),
    counter(locale, "info", count("INFO")),
    ...(options.reportingLevel === "USAGE" ? [counter(locale, "usage", count("USAGE"))] : []),
  ];
  yield* out(`${text(locale, "messages")}: ${counters.join(" / ")}\n`);
  yield* out(text(locale, "epubcheck_completed"));

  if (options.report !== undefined) {
    const rendered =
      options.report.format === "json"
        ? JsonReport.render(result, {
            path: displayPath,
            maxOfEachMessage: options.maxOfEachMessage,
            checkedAt: startedAt,
            elapsedTime: finishedAt - startedAt,
            customMessageFileName: options.customMessages,
          })
        : (options.report.format === "xml" ? XmlReport.renderJhove : XmlReport.renderXmp)(result, {
            path: displayPath,
            uri: isDirectory ? `${target}.epub` : target,
            maxOfEachMessage: options.maxOfEachMessage,
            checkedAt: startedAt,
          });
    if (options.report.target === "-") yield* terminal.stdout(rendered);
    else {
      yield* fs
        .writeFileString(path.resolve(environment.cwd, options.report.target), rendered)
        .pipe(Effect.orDie);
    }
  }
  if (options.save && isDirectory) {
    if (fatals + errors > 0) yield* out(text(locale, "deleting_archive"));
    else {
      yield* saveArchive(target).pipe(
        // Upstream skips the archive when the directory cannot be read.
        Effect.catchTags({
          SymbolicLinkError: () => Effect.void,
          ResourceReadError: () => Effect.void,
        }),
      );
    }
  }
  return done(fatals + errors > 0 || (options.failOnWarnings && warnings > 0) ? 1 : 0);
});

export const main = Effect.fn("Cli.main")(function* (
  argv: ReadonlyArray<string>,
  environment: CliEnvironment,
) {
  const terminal = yield* Terminal;
  const parsed = parseArgs(argv, resolveLocale(undefined, environment.defaultLocale));
  if (Result.isFailure(parsed)) {
    yield* terminal.stderr(`${parsed.failure}\n`);
    return { exitCode: 1, maxOfEachMessage: undefined } satisfies CliOutcome;
  }
  return yield* run(parsed.success, environment);
});
