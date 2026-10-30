import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as EpubCheck from "../EpubCheck.ts";
import * as MessageCatalog from "../messages/MessageCatalog.ts";
import * as ZipWriter from "../ocf/ZipWriter.ts";
import * as Dates from "../report/Dates.ts";
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

// Like Java's PrintStream, writes to a closed pipe (`epubcheck -l | head`) are dropped.
export const terminalLayer = Layer.sync(Terminal, () => {
  process.stdout.on("error", () => {});
  return Terminal.of({
    stdout: Effect.fn("Terminal.stdout")(function* (text: string) {
      yield* Effect.sync(() => process.stdout.write(text));
    }),
    stderr: Effect.fn("Terminal.stderr")(function* (text: string) {
      yield* Effect.sync(() => process.stderr.write(text));
    }),
  });
});

const LOCALES = Object.keys(bundles).filter((locale) => locale !== "default");

// Like Java's ResourceBundle: the requested locale, then the default locale, then English.
// Traditional Chinese (`zh-Hant`) finds the Taiwanese bundle.
const resolveLocale = (requested: string | undefined, fallback: string) => {
  for (const tag of [requested, fallback]) {
    if (tag === undefined) continue;
    const parts = tag.split(/[-_]/);
    const traditional = parts[0]?.toLowerCase() === "zh" && parts[1]?.toLowerCase() === "hant";
    const candidates = traditional && parts.length === 2 ? [...parts, "TW"] : parts;
    for (let length = candidates.length; length > 0; length--) {
      const candidate = candidates
        .slice(0, length)
        .filter((part) => part.length !== 4)
        .join("-")
        .toLowerCase();
      const match = LOCALES.find((locale) => locale.toLowerCase() === candidate);
      if (match !== undefined) return match;
    }
  }
  return "en";
};

// Java's Locale.forLanguageTag keeps the well-formed subtags before the first ill-formed one
// (`de_DE` has none, so the default locale applies).
const languageTag = (tag: string) => {
  const subtags = tag.split("-");
  const end = subtags.findIndex((subtag, index) =>
    index === 0 ? !/^[A-Za-z]{2,8}$/.test(subtag) : !/^[A-Za-z0-9]{1,8}$/.test(subtag),
  );
  const kept = end < 0 ? subtags : subtags.slice(0, end);
  return kept.length === 0 ? undefined : kept.join("-");
};

const text = (locale: string, key: string, ...args: ReadonlyArray<string>) => {
  const language = locale.split("-")[0] ?? locale;
  const pattern =
    bundles[locale]?.[key] ?? bundles[language]?.[key] ?? bundles["default"]?.[key] ?? key;
  return MessageCatalog.formatJava(pattern, args);
};

type ReportFormat = "json" | "xml" | "xmp";
type ReportingLevel = NonNullable<EpubCheck.CheckRequest["reportingLevel"]>;

// Where a report goes: a file, standard output (`-`), or next to the checked path.
type ReportTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdout" }
  | { readonly kind: "beside"; readonly path: string };

// What upstream's argument parser records.
export interface CliOptions {
  readonly path: string | undefined;
  readonly mode: string | undefined;
  readonly version: EpubCheck.EpubVersion;
  readonly profile: EpubCheck.Profile | undefined;
  readonly reportingLevel: ReportingLevel;
  readonly report: { readonly format: ReportFormat; readonly target: ReportTarget } | undefined;
  readonly maxOfEachMessage: number;
  readonly locale: string;
  readonly failOnWarnings: boolean;
  readonly save: boolean;
  readonly displayHelp: boolean;
  readonly displayVersion: boolean;
  readonly listChecks: { readonly target: string | undefined } | undefined;
  // The override file; one named by the environment variable is used only if it exists.
  readonly customMessages: { readonly path: string; readonly fromEnvironment: boolean } | undefined;
}

export interface CliEnvironment {
  readonly cwd: string;
  readonly defaultLocale: string;
  // Upstream's `ePubCheckCustomMessageFile` environment variable.
  readonly customMessageFile?: string | undefined;
}

export interface CliOutcome {
  readonly exitCode: number;
  // The report's cap on locations per message, when a report was written (negative: unlimited).
  readonly maxOfEachMessage: number | undefined;
}

const MODES = ["opf", "xhtml", "svg", "nav", "mo"] as const;
const PROFILES = ["default", "edupub", "dict", "idx", "preview"] as const;
const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: string): value is T =>
  values.some((candidate) => candidate === value);

const LEVELS: Readonly<Record<string, ReportingLevel>> = {
  i: "INFO",
  info: "INFO",
  f: "FATAL",
  fatal: "FATAL",
  e: "ERROR",
  error: "ERROR",
  w: "WARNING",
  warn: "WARNING",
  u: "USAGE",
  usage: "USAGE",
};

// Upstream's console: standard output can be silenced (`-q`), standard error cannot.
const console = () => {
  const lines: Array<{ readonly stream: "stdout" | "stderr"; readonly text: string }> = [];
  let quiet = false;
  return {
    lines,
    out: (line: string) => {
      if (!quiet) lines.push({ stream: "stdout", text: `${line}\n` });
    },
    err: (line: string) => lines.push({ stream: "stderr", text: `${line}\n` }),
    // Output that bypasses quiet mode.
    raw: (stream: "stdout" | "stderr", value: string) => lines.push({ stream, text: value }),
    setQuiet: (value: boolean) => {
      quiet = value;
    },
  };
};
type Console = ReturnType<typeof console>;

// Upstream's processArguments: options take one or two dashes, help and version print as soon as
// they are read, and the first error ends parsing with an exit code.
const parseArgs = (argv: ReadonlyArray<string>, environment: CliEnvironment, out: Console) => {
  let locale = resolveLocale(undefined, environment.defaultLocale);
  let path: string | undefined;
  let mode: string | undefined;
  let version: EpubCheck.EpubVersion = "3";
  let profile: CliOptions["profile"];
  let reportingLevel: ReportingLevel = "INFO";
  // Upstream keeps the report's format and target apart: `-r` sets only the target.
  let format: ReportFormat | undefined;
  let target: ReportTarget | undefined;
  let maxOfEachMessage = Groups.DEFAULT_MAX_OF_EACH_MESSAGE;
  let failOnWarnings = false;
  let save = false;
  let displayHelp = false;
  let displayVersion = false;
  let listChecks: CliOptions["listChecks"];
  const formats = new Set<ReportFormat>();
  let customMessages: CliOptions["customMessages"] =
    environment.customMessageFile === undefined || environment.customMessageFile === ""
      ? undefined
      : { path: environment.customMessageFile, fromEnvironment: true };
  const help = () => out.out(text(locale, "help_text", EpubCheck.VERSION));
  const stop = (exitCode: number) => ({ exitCode });

  if (argv.length === 0) {
    out.err(text(locale, "argument_needed"));
    return stop(1);
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const next = argv[index + 1];
    const match = /^--?(.*)$/s.exec(arg);
    if (match === null) {
      if (path !== undefined) {
        out.err(text(locale, "unrecognized_argument", arg));
        help();
        return stop(1);
      }
      path = arg;
      continue;
    }
    const flag = match[1] ?? "";
    const level = LEVELS[flag];
    if (level !== undefined) {
      reportingLevel = level;
      continue;
    }
    switch (flag) {
      case "v":
        // Upstream prints a hint and fails without a message.
        if (next !== "2" && next !== "2.0" && next !== "3" && next !== "3.0") {
          out.out(text(locale, "display_help"));
          return stop(1);
        }
        index++;
        version = next.startsWith("2") ? "2" : "3";
        break;
      case "m":
      case "mode":
      case "p":
      case "profile":
        if (next === undefined) {
          out.out(text(locale, "display_help"));
          return stop(1);
        }
        index++;
        if (flag.startsWith("m")) mode = next;
        else {
          const name = next.toLowerCase();
          if (isOneOf(PROFILES, name)) {
            profile = name;
            break;
          }
          out.err(text(locale, "mode_version_ignored"));
          profile = "default";
        }
        break;
      case "s":
      case "save":
        save = true;
        break;
      case "o":
      case "out":
      case "j":
      case "json":
      case "x":
      case "xmp": {
        format = flag.startsWith("o") ? "xml" : flag.startsWith("x") ? "xmp" : "json";
        if (next !== undefined && !next.startsWith("-")) {
          index++;
          target = { kind: "file", path: next };
        } else if (next === "-") {
          index++;
          target = { kind: "stdout" };
        } else if (path === undefined) {
          // Upstream fails on a null path here, silently.
          return stop(1);
        } else target = { kind: "beside", path };
        formats.add(format);
        break;
      }
      case "q":
      case "quiet":
        out.setQuiet(true);
        break;
      case "failonwarnings":
        failOnWarnings = true;
        break;
      case "r":
      case "redir":
        if (next !== undefined) {
          index++;
          target = { kind: "file", path: next };
        }
        break;
      case "c":
      case "customMessages":
        if (next === undefined) break;
        if (next.toLowerCase() === "none") customMessages = undefined;
        else if (!next.startsWith("-")) customMessages = { path: next, fromEnvironment: false };
        else {
          out.err(text(locale, "expected_message_filename", next));
          help();
          return stop(1);
        }
        index++;
        break;
      case "l":
      case "listChecks":
        listChecks = { target: undefined };
        if (next !== undefined && !next.startsWith("-")) {
          index++;
          listChecks = { target: next };
        }
        break;
      case "locale":
        if (next === undefined) {
          out.err(text(locale, "missing_locale"));
          help();
          return stop(1);
        }
        if (next.startsWith("-")) {
          out.err(text(locale, "incorrect_locale", next));
          help();
          return stop(1);
        }
        index++;
        locale = resolveLocale(languageTag(next), environment.defaultLocale);
        break;
      case "maxOfEachMessage":
      case "maxofeachmessage":
        if (next === undefined) {
          out.err(text(locale, "missing_maxofeach"));
          help();
          return stop(1);
        }
        index++;
        if (next === "unlimited") maxOfEachMessage = -1;
        else if (/^[+-]?\d+$/.test(next) && Number(next) >= -(2 ** 31) && Number(next) < 2 ** 31) {
          maxOfEachMessage = Number(next);
        } else {
          out.err(text(locale, "incorrect_maxofeach", next));
          help();
          return stop(1);
        }
        break;
      case "h":
      case "?":
      case "help":
        help();
        displayHelp = true;
        break;
      case "version":
        out.out(text(locale, "epubcheck_version_text", EpubCheck.VERSION));
        displayVersion = true;
        break;
      default:
        out.err(text(locale, "unrecognized_argument", arg));
        help();
        return stop(1);
    }
  }
  if (formats.size > 1) {
    out.err(text(locale, "output_type_conflict"));
    return stop(1);
  }
  const options: CliOptions = {
    path: path?.replaceAll("\\", "/"),
    mode,
    version,
    profile,
    reportingLevel,
    report: format === undefined || target === undefined ? undefined : { format, target },
    maxOfEachMessage,
    locale,
    failOnWarnings,
    save,
    displayHelp,
    displayVersion,
    listChecks,
    customMessages,
  };
  if (options.path === undefined) {
    if (listChecks !== undefined || displayHelp || displayVersion) return { options };
    out.err(text(locale, "no_file_specified"));
    return stop(1);
  }
  if (/^.+\.[Ee][Pp][Uu][Bb]$/s.test(options.path)) {
    if (mode !== undefined || version !== "3") {
      out.err(text(locale, "mode_version_ignored"));
      return { options: { ...options, mode: undefined } };
    }
  } else if (mode === undefined && profile === undefined) {
    out.out(text(locale, "mode_required"));
    return stop(1);
  }
  return { options };
};

const counter = (locale: string, kind: string, count: number) =>
  text(
    locale,
    `counter_${kind}_${count === 0 ? "zero" : count === 1 ? "one" : "many"}`,
    String(count),
  );

// Upstream's PathUtil.removeWorkingDirectory: a path under the working directory starts with `.`.
const removeWorkingDirectory = (path: string, cwd: string) =>
  cwd === "/" || !path.startsWith(cwd) ? path : `.${path.slice(cwd.length)}`;

// Java's File.getAbsolutePath, which does not normalize.
const javaAbsolute = (path: string, cwd: string) =>
  path.startsWith("/") ? path : `${cwd}/${path}`;

// Java's String.split: trailing empty fields are dropped.
const splitFields = (line: string) => {
  const fields = line.split("\t");
  while (fields.length > 1 && fields.at(-1) === "") fields.pop();
  return fields;
};

// Upstream's override file: tab-separated ID, severity, and an optional message and suggestion
// per line, after an optional header. Problems are CHK messages located at the file, whose line
// numbers, as upstream counts them, skip the header and lines with problems.
const readCustomMessages = Effect.fn("Cli.readCustomMessages")(function* (
  file: string,
  shown: string,
  locale: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const report = yield* Report.Report;
  const overrides: Record<string, EpubCheck.Override> = {};
  const content = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(content)) {
    yield* report.message("CHK-001", Report.location(shown));
    return overrides;
  }
  let lineNumber = 1;
  const lines = content.value.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (lineNumber === 1 && line.toLowerCase().startsWith("id")) continue;
    const fields = splitFields(line);
    const [written = "", severity = "", message = "", suggestion = ""] = fields;
    if (fields.length >= 2) {
      const id = MessageCatalog.fromDisplayId(written);
      if (id === undefined) {
        yield* report.message("CHK-002", Report.location(shown, lineNumber, 0), written, shown);
        continue;
      }
      if (!MessageCatalog.isSeverity(severity)) {
        const column = 1 + written.length;
        yield* report.message(
          "CHK-003",
          Report.location(shown, lineNumber, column),
          severity,
          shown,
        );
        continue;
      }
      const original = MessageCatalog.rawMessage(id, locale);
      const allowed = MessageCatalog.argumentCount(original);
      if (message !== "" && MessageCatalog.argumentCount(message) > allowed) {
        yield* report.message("CHK-004", Report.location(shown, lineNumber, 0), shown);
        continue;
      }
      if (suggestion !== "" && MessageCatalog.argumentCount(suggestion) > allowed) {
        yield* report.message("CHK-005", Report.location(shown, lineNumber, 0), shown);
        continue;
      }
      const defaultSeverity = MessageCatalog.defaultSeverity(id);
      const text = message === "" ? original : message;
      overrides[id] = {
        severity,
        message:
          severity === defaultSeverity
            ? text
            : ` (severity overridden from ${defaultSeverity}) ${text}`,
        ...(suggestion === "" ? {} : { suggestion }),
      };
    }
    lineNumber++;
  }
  return overrides;
});

// Upstream's Archive skips system files and version-control directories.
const IGNORED_FILES = new Set([".DS_Store", "._DS_Store", "Thumbs.db", "ehthumbs.db"]);
const IGNORED_DIRECTORIES = new Set([".svn", ".git"]);

// Packages an expanded EPUB next to its directory like upstream's `--save`: files in directory
// listing order, depth-first, then `mimetype` moved first, each dated by its modification time.
const saveArchive = Effect.fn("Cli.saveArchive")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Array<ZipWriter.Entry> = [];
  // Recursive, so its type is spelled out.
  const walk: (dir: string, prefix: string) => Effect.Effect<void, PlatformError.PlatformError> =
    Effect.fnUntraced(function* (dir: string, prefix: string) {
      for (const name of yield* fs.readDirectory(dir)) {
        const file = path.join(dir, name);
        const info = yield* fs.stat(file);
        if (info.type === "File" && !IGNORED_FILES.has(name)) {
          const modified = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
          entries.push({ name: `${prefix}${name}`, data: yield* fs.readFile(file), modified });
        } else if (info.type === "Directory" && !IGNORED_DIRECTORIES.has(name)) {
          yield* walk(file, `${prefix}${name}/`);
        }
      }
    });
  yield* walk(directory, "");
  const archive = yield* ZipWriter.write([
    ...entries.filter((entry) => entry.name === "mimetype"),
    ...entries.filter((entry) => entry.name !== "mimetype"),
  ]);
  yield* fs.writeFile(`${directory.replace(/[\\/]+$/, "")}.epub`, archive);
});

const listChecks = () =>
  [
    "ID\tSeverity\tMessage\tSuggestion",
    ...MessageCatalog.messageIds.map(
      (id) =>
        `${MessageCatalog.displayId(id)}\t${MessageCatalog.defaultSeverity(id)}\t${MessageCatalog.rawMessage(id)}\t${MessageCatalog.formatSuggestion(id)}`,
    ),
  ].join("\n");

// Upstream's run: help and version end early, `--listChecks` lists and stops, and otherwise
// the check runs and prints its messages, verdict, report and summary.
const run = Effect.fn("Cli.run")(function* (
  options: CliOptions,
  environment: CliEnvironment,
  out: Console,
) {
  const checker = yield* EpubCheck.EpubCheck;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { locale, report } = options;
  const done = (exitCode: number): CliOutcome => ({
    exitCode,
    maxOfEachMessage: report === undefined ? undefined : options.maxOfEachMessage,
  });
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const strip = (file: string) => removeWorkingDirectory(file, environment.cwd);

  if (options.displayHelp || (options.displayVersion && options.path === undefined)) {
    return done(0);
  }
  if (options.listChecks !== undefined) {
    const target = options.listChecks.target;
    if (target === undefined) out.raw("stdout", `${listChecks()}\n`);
    else {
      const file = path.resolve(environment.cwd, target);
      const written = yield* fs.writeFileString(file, `${listChecks()}\n`).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!written)
        out.err(text(locale, "error_creating_config_file", javaAbsolute(target, environment.cwd)));
    }
    return done(0);
  }
  const raw = options.path ?? "";
  const expanded = options.mode === "exp";
  const absolute = path.resolve(environment.cwd, raw);
  // Upstream checks an expanded EPUB as the archive it builds next to the directory.
  const archive = `${path.dirname(absolute)}/${path.basename(absolute)}.epub`;
  const epubFileName = expanded ? archive : strip(raw);
  // Where messages about the container itself are located.
  const containerPath = strip(expanded ? archive : absolute);
  const preamble = yield* Report.make({ locale, reportingLevel: options.reportingLevel });
  const used = options.customMessages;
  const custom =
    used === undefined ||
    (used.fromEnvironment && !(yield* exists(path.resolve(environment.cwd, used.path))))
      ? undefined
      : used.path;
  const overrides =
    custom === undefined
      ? undefined
      : yield* readCustomMessages(
          path.resolve(environment.cwd, custom),
          strip(javaAbsolute(custom, environment.cwd)),
          locale,
        ).pipe(Effect.provideService(Report.Report, preamble));

  const startedAt = yield* Clock.currentTimeMillis;
  let exitCode = 1;
  let stdoutClosed = false;
  // Upstream reads the override file before it knows an expanded EPUB's archive.
  const early = new Set(yield* preamble.messages);
  let messages: ReadonlyArray<Report.Message> = [...early];
  let result: EpubCheck.CheckResult | undefined;
  const count = (severity: Report.Message["severity"]) =>
    messages.filter((message) => message.severity === severity).length;
  const consoleLine = (message: Report.Message) => {
    const name = strip(early.has(message) ? raw : epubFileName);
    const where =
      result === undefined
        ? message.location.path
        : JsonReport.locationPath(result, message.location, containerPath);
    const file = name.endsWith(where) ? name : `${name}/${where}`;
    // Java's `\s`, which leaves U+00A0 and other Unicode spaces alone.
    const body = message.message.replace(/[ \t\n\v\f\r]+/g, " ");
    return `${message.severity}(${MessageCatalog.displayId(message.id)}): ${file}(${message.location.line},${message.location.column}): ${body}`;
  };
  const print = (message: Report.Message) => {
    if (report !== undefined) return;
    // Upstream prints USAGE messages on standard output even in quiet mode.
    if (message.severity === "USAGE") out.raw("stdout", `${consoleLine(message)}\n`);
    else out.err(consoleLine(message));
  };

  const mode = expanded ? undefined : options.mode;
  const supported =
    mode === undefined ||
    mode === "opf" ||
    mode === "xhtml" ||
    mode === "svg" ||
    (options.version === "3" && (mode === "mo" || mode === "nav"));
  if (expanded && !(yield* exists(absolute))) {
    messages.forEach(print);
    out.err(text(locale, "directory_not_found", raw));
  } else if (!expanded && !(yield* exists(absolute))) {
    messages.forEach(print);
    out.err(text(locale, "file_not_found", raw));
  } else if (!supported) {
    messages.forEach(print);
    out.out(text(locale, "display_help"));
    const label = JsonReport.epubVersionLabel(options.version);
    out.err(text(locale, "mode_version_not_supported", mode ?? "", label));
  } else {
    const checked = yield* checker.check({
      path: absolute,
      ...(mode === undefined || !isOneOf(MODES, mode) ? { mode: "epub" } : { mode }),
      version: options.version,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      locale,
      reportingLevel: options.reportingLevel,
      ...(overrides === undefined ? {} : { overrides }),
    });
    result = checked;
    messages = [...messages, ...checked.messages];
    const showVersion =
      report === undefined &&
      MessageCatalog.severityRank(options.reportingLevel) <= MessageCatalog.severityRank("INFO");
    if (checked.publication !== undefined && showVersion) {
      out.out(
        text(
          locale,
          "validating_version_message",
          JsonReport.epubVersionLabel(checked.publication.version),
        ),
      );
    }
    messages.forEach(print);
    const errors = count("FATAL") + count("ERROR");
    if (errors === 0 && count("WARNING") === 0) {
      if (report?.target.kind !== "stdout") out.out(text(locale, "no_errors__or_warnings"));
      exitCode = 0;
    } else if (errors === 0) {
      out.err(text(locale, "there_were_warnings"));
      exitCode = options.failOnWarnings ? 1 : 0;
    } else out.err(text(locale, "there_were_errors"));
    if (expanded && options.save) {
      if (errors > 0) out.err(text(locale, "deleting_archive"));
      else {
        // Upstream skips the archive when the directory cannot be read.
        yield* saveArchive(absolute).pipe(Effect.catchTags({ PlatformError: () => Effect.void }));
      }
    }
  }
  const finishedAt = yield* Clock.currentTimeMillis;

  if (report !== undefined) {
    // An expanded EPUB is dated by the archive upstream builds from its files.
    const container = path.join(absolute, "META-INF", "container.xml");
    const built = expanded
      ? yield* fs.stat(container).pipe(
          Effect.map((info) => Option.getOrUndefined(info.mtime)),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    const full = {
      path: absolute,
      mode: result?.mode ?? "epub",
      ...result,
      ...(built === undefined ? {} : { created: Dates.localWithZ(built.getTime()) }),
      messages,
    };
    const rendered =
      report.format === "json"
        ? JsonReport.render(full, {
            path: strip(javaAbsolute(epubFileName, environment.cwd)),
            containerPath,
            maxOfEachMessage: options.maxOfEachMessage,
            checkedAt: startedAt,
            elapsedTime: finishedAt - startedAt,
            customMessageFileName:
              overrides === undefined || custom === undefined
                ? undefined
                : javaAbsolute(custom, environment.cwd),
          })
        : (report.format === "xml" ? XmlReport.renderJhove : XmlReport.renderXmp)(full, {
            path: containerPath,
            uri: epubFileName,
            maxOfEachMessage: options.maxOfEachMessage,
            checkedAt: startedAt,
          });
    const target = report.target;
    if (target.kind === "stdout") {
      out.raw("stdout", rendered);
      // Upstream closes standard output with the report.
      stdoutClosed = true;
    } else {
      const file =
        target.kind === "file"
          ? path.resolve(environment.cwd, target.path)
          : (yield* fs.stat(path.resolve(environment.cwd, target.path)).pipe(
                Effect.map((info) => info.type === "Directory"),
                Effect.orElseSucceed(() => false),
              ))
            ? path.join(
                path.dirname(path.resolve(environment.cwd, target.path)),
                `${path.basename(target.path)}check.${EXTENSIONS[report.format]}`,
              )
            : path.resolve(environment.cwd, `${target.path}check.${EXTENSIONS[report.format]}`);
      yield* fs.writeFileString(file, rendered).pipe(Effect.orDie);
    }
  }

  // Upstream's summary counts only the severities the reporting level shows.
  const rank = MessageCatalog.severityRank(options.reportingLevel);
  const counters = (
    [
      ["FATAL", "fatal"],
      ["ERROR", "error"],
      ["WARNING", "warn"],
      ["INFO", "info"],
      ["USAGE", "usage"],
    ] as const
  )
    .filter(([severity]) => MessageCatalog.severityRank(severity) >= rank)
    .map(([severity, kind]) => counter(locale, kind, count(severity)));
  if (!stdoutClosed) {
    out.out(`${text(locale, "messages")}: ${counters.join(" / ")}\n`);
    out.out(text(locale, "epubcheck_completed"));
  }
  return done(exitCode);
});

const EXTENSIONS: Readonly<Record<ReportFormat, string>> = { json: "json", xml: "xml", xmp: "xmp" };

export const main = Effect.fn("Cli.main")(function* (
  argv: ReadonlyArray<string>,
  environment: CliEnvironment,
) {
  const terminal = yield* Terminal;
  const out = console();
  const parsed = parseArgs(argv, environment, out);
  const outcome =
    "options" in parsed
      ? yield* run(parsed.options, environment, out)
      : ({ exitCode: parsed.exitCode, maxOfEachMessage: undefined } satisfies CliOutcome);
  for (const line of out.lines) yield* terminal[line.stream](line.text);
  return outcome;
});
