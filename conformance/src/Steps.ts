import {
  CucumberExpression,
  ParameterType,
  ParameterTypeRegistry,
} from "@cucumber/cucumber-expressions";
import type { PickleStep } from "@cucumber/messages";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { EpubCheck, type Report } from "epubcheck-ts";

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

type Severity = Report.Message["severity"];
type ReportingLevel = NonNullable<EpubCheck.CheckRequest["reportingLevel"]>;

export interface CheckInvocation {
  readonly path: string;
  readonly mode: EpubCheck.CheckMode;
  readonly version: EpubCheck.EpubVersion;
  readonly profile: EpubCheck.Profile;
  readonly reportingLevel: ReportingLevel;
  readonly locale: string;
}

export interface Check {
  readonly invocation: CheckInvocation;
  readonly messages: ReadonlyArray<Report.Message>;
}

// Mutable per-scenario state, mirroring upstream's TestEnvironment, EPUBCheckConfiguration and TestReport.
export interface World {
  readonly resourcesDir: string;
  basepath: string;
  version: EpubCheck.EpubVersion;
  mode: EpubCheck.CheckMode | undefined;
  profile: EpubCheck.Profile;
  reportingLevel: ReportingLevel;
  locale: string;
  defaultLocale: string;
  reportingFormat: string;
  maxOfEachMessage: number | undefined;
  checks: Array<Check>;
  messages: Array<Report.Message>;
  lastAsserted: Report.Message | undefined;
}

export const makeWorld = (resourcesDir: string): World => ({
  resourcesDir,
  basepath: "",
  version: "3",
  mode: undefined,
  profile: "default",
  reportingLevel: "INFO",
  locale: "en",
  defaultLocale: "en",
  reportingFormat: "default",
  maxOfEachMessage: undefined,
  checks: [],
  messages: [],
  lastAsserted: undefined,
});

const fail = (reason: string) => Effect.fail(new StepFailed({ reason }));

// Parameter types copied from upstream's ParameterTypes.java so step text matches identically.
const registry = new ParameterTypeRegistry();
// Cucumber expressions drop regexp flags, so upstream's `?i:` groups become explicit letter classes.
const caseInsensitive = (source: string) =>
  new RegExp(
    source.replace(/[a-z]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`),
  );
const defineType = (name: string, regexp: RegExp, transform: (...groups: string[]) => unknown) =>
  registry.defineParameterType(new ParameterType(name, regexp, null, transform, false, false));
defineType("bool", /true|false/, (value) => value === "true");
defineType(
  "checkerMode",
  caseInsensitive(
    "(?:full publication|(?:(?:media overlays|navigation|package|svg content|xhtml content) document))",
  ),
  (mode) => {
    switch ((mode ?? "").toLowerCase()) {
      case "media overlays document":
        return "mo";
      case "navigation document":
        return "nav";
      case "package document":
        return "opf";
      case "svg content document":
        return "svg";
      case "xhtml content document":
        return "xhtml";
      default:
        return "epub";
    }
  },
);
defineType("locale", /.*?/, (locale) => locale);
defineType("messageId", /[A-Z]{3}-[0-9]{3}[a-z]?/, (id) => id);
defineType("messageQuantity", /(?: )?(\d*)(?: time(?:s)?)?/, (times) =>
  times === undefined || times === "" ? 1 : Number(times),
);
defineType("profile", /.*?/, (profile) => (profile ?? "").toLowerCase());
defineType("severity", caseInsensitive("(?:fatal error|error|warning|usage|info)"), (severity) => {
  const lower = (severity ?? "").toLowerCase();
  return lower === "fatal error" ? "FATAL" : lower.toUpperCase();
});
defineType("version", /\d(?:\.\d)?(?:\.\d)?/, (version) =>
  (version ?? "").startsWith("2") ? "2" : (version ?? "").startsWith("3") ? "3" : "unknown",
);

const SeverityArg = Schema.Literals(["FATAL", "ERROR", "WARNING", "USAGE", "INFO"]);
const Any = Schema.Unknown;

type Requirements = EpubCheck.EpubCheck | FileSystem.FileSystem | Path.Path;

export interface StepDefinition {
  readonly expression: CucumberExpression;
  readonly run: (
    world: World,
    args: ReadonlyArray<unknown>,
    step: PickleStep,
  ) => Effect.Effect<void, StepFailed, Requirements>;
}

const define = <S extends Schema.Decoder<unknown>>(
  text: string,
  args: S,
  run: (
    world: World,
    args: S["Type"],
    step: PickleStep,
  ) => Effect.Effect<void, StepFailed, Requirements>,
): StepDefinition => ({
  expression: new CucumberExpression(text, registry),
  run: (world, raw, step) =>
    Schema.decodeEffect(args)(raw).pipe(
      Effect.mapError(
        (error) =>
          new StepFailed({ reason: `Invalid step arguments for "${text}": ${error.message}` }),
      ),
      Effect.flatMap((decoded) => run(world, decoded, step)),
    ),
});

const noop = Effect.void;

// Upstream's TestReport collapses Java `\s` whitespace, which excludes NBSP and other spaces.
const normalize = (text: string) => text.replace(/[ \t\n\v\f\r]+/g, " ");

const check = Effect.fn("Steps.check")(function* (world: World, file: string) {
  const checker = yield* EpubCheck.EpubCheck;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(world.resourcesDir, world.basepath + file);
  if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* fail(`Couldn't find EPUB: ${world.basepath}${file}`);
  }
  const invocation: CheckInvocation = {
    path: target,
    mode: world.mode ?? EpubCheck.inferMode(file),
    version: world.version,
    profile: world.profile,
    reportingLevel: world.reportingLevel,
    locale: world.locale,
  };
  const result = yield* checker.check(invocation);
  world.checks.push({ invocation, messages: result.messages });
  // Upstream's TestReport accumulates messages across every check in a scenario.
  world.messages.push(...result.messages);
});

const consumeWhere = (world: World, predicate: (message: Report.Message) => boolean) => {
  const consumed = world.messages.filter(predicate);
  world.messages = world.messages.filter((message) => !predicate(message));
  return consumed;
};

const describeRemaining = (messages: ReadonlyArray<Report.Message>) =>
  messages.map((message) => `${message.severity} ${message.id}: ${message.message}`).join("; ");

const assertNone = (world: World, severities: ReadonlyArray<Severity>, label: string) => {
  const remaining = world.messages.filter((message) => severities.includes(message.severity));
  return remaining.length === 0
    ? noop
    : fail(`Unexpected ${label}: ${describeRemaining(remaining)}`);
};

export const steps: ReadonlyArray<StepDefinition> = [
  // TestEnvironment
  define(
    "(the )(EPUB )test files (are)located at {string}",
    Schema.Tuple([Schema.String]),
    (world, [basepath]) =>
      Effect.sync(() => {
        world.basepath = basepath;
      }),
  ),
  define(
    "(the )default locale (is )(set to )('){locale}(')",
    Schema.Tuple([Schema.String]),
    (world, [locale]) =>
      Effect.sync(() => {
        world.defaultLocale = locale;
      }),
  ),
  // EPUBCheckConfiguration
  define("EPUBCheck with default settings", Schema.Tuple([]), () => noop),
  define(
    "EPUBCheck configured to check EPUB {version} rules",
    Schema.Tuple([Schema.String]),
    (world, [version]) =>
      version === "2" || version === "3"
        ? Effect.sync(() => {
            world.version = version;
          })
        : fail(`Unknown EPUB version: ${version}`),
  ),
  define(
    "the maximum number of each message is set to {int}",
    Schema.Tuple([Schema.Number]),
    (world, [max]) =>
      Effect.sync(() => {
        world.maxOfEachMessage = max;
      }),
  ),
  define(
    "EPUBCheck configured to check a(n) {checkerMode}",
    Schema.Tuple([EpubCheck.CheckMode]),
    (world, [mode]) =>
      Effect.sync(() => {
        world.mode = mode;
      }),
  ),
  define(
    "EPUBCheck configured with the ('){profile}(') profile",
    Schema.Tuple([EpubCheck.Profile]),
    (world, [profile]) =>
      Effect.sync(() => {
        world.profile = profile;
      }),
  ),
  define(
    "(the )reporting format (is )set to {}",
    Schema.Tuple([Schema.String]),
    (world, [format]) =>
      Effect.sync(() => {
        world.reportingFormat = format;
      }),
  ),
  define(
    "(the )reporting level (is )set to {severity}",
    Schema.Tuple([SeverityArg]),
    (world, [level]) =>
      Effect.sync(() => {
        world.reportingLevel = level;
      }),
  ),
  define(
    "(the )reporting locale (is )set to ('){locale}(')",
    Schema.Tuple([Schema.String]),
    (world, [locale]) =>
      Effect.sync(() => {
        world.locale = locale;
      }),
  ),
  // ExecutionSteps
  define(
    "checking EPUB/file/document/directory/file\\ set {string}",
    Schema.Tuple([Schema.String]),
    (world, [file]) => check(world, file),
  ),
  // AssertionSteps
  define(
    "no( other) warning(s)/error(s) or error(s)/warning(s) are/is reported",
    Schema.Tuple([]),
    (world) => assertNone(world, ["FATAL", "ERROR", "WARNING"], "errors or warnings"),
  ),
  define("no( other) usage(s) are/is reported", Schema.Tuple([]), (world) =>
    assertNone(world, ["USAGE"], "usages"),
  ),
  define(
    "(the ){severity} {messageId} is reported{messageQuantity}(  \\(){}",
    Schema.Tuple([SeverityArg, Schema.String, Schema.Number, Any]),
    (world, [severity, id, quantity]) => {
      if (quantity === 1) {
        const index = world.messages.findIndex((message) => message.id === id);
        const found = world.messages[index];
        if (found === undefined) return fail(`No message found with ID ${id}`);
        world.messages.splice(index, 1);
        world.lastAsserted = found;
        return found.severity === severity
          ? noop
          : fail(`Expected ${id} to be ${severity} but it was ${found.severity}`);
      }
      const found = consumeWhere(world, (message) => message.id === id);
      world.lastAsserted = found.at(-1);
      if (found.length !== quantity) {
        return fail(`Expected ${id} ${quantity} times but found it ${found.length} times`);
      }
      return found.every((message) => message.severity === severity)
        ? noop
        : fail(`Expected every ${id} to be ${severity}`);
    },
  ),
  define(
    "(the )following {severity}( ID)(s) are/is reported(  \\(){}",
    Schema.Tuple([SeverityArg, Any]),
    (world, [severity], step) => {
      const rows =
        step.argument?.dataTable?.rows.map((row) => row.cells.map((cell) => cell.value)) ?? [];
      const actual = consumeWhere(world, (message) => message.severity === severity);
      const matches =
        actual.length === rows.length &&
        rows.every((row, index) => {
          const message = actual[index];
          return (
            message !== undefined &&
            message.id === row[0] &&
            (row[1] === undefined || normalize(message.message).includes(row[1]))
          );
        });
      return matches
        ? noop
        : fail(
            `Expected ${severity} messages [${rows.map((row) => row.join(" ")).join(", ")}] but got [${describeRemaining(actual)}]`,
          );
    },
  ),
  define("(the )message is {string}", Schema.Tuple([Schema.String]), (world, [expected]) => {
    const actual =
      world.lastAsserted === undefined ? undefined : normalize(world.lastAsserted.message);
    return actual === expected ? noop : fail(`Expected message "${expected}" but got "${actual}"`);
  }),
  define("(the )message contains {string}", Schema.Tuple([Schema.String]), (world, [expected]) => {
    const actual =
      world.lastAsserted === undefined ? undefined : normalize(world.lastAsserted.message);
    return actual?.includes(expected) === true
      ? noop
      : fail(`Expected message containing "${expected}" but got "${actual}"`);
  }),
  define("(the )message has line and column info", Schema.Tuple([]), (world) => {
    const location = world.lastAsserted?.location;
    return location !== undefined && location.line !== -1 && location.column !== -1
      ? noop
      : fail("Expected the last asserted message to have line and column info");
  }),
  define("all messages have line and column info", Schema.Tuple([]), (world) => {
    const missing = world.messages.filter(
      (message) =>
        (message.severity === "WARNING" || message.severity === "ERROR") &&
        (message.location.line === -1 || message.location.column === -1),
    );
    return missing.length === 0
      ? noop
      : fail(`Messages without line and column info: ${describeRemaining(missing)}`);
  }),
];
