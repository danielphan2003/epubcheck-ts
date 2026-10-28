#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { EpubCheck } from "epubcheck-ts";

import * as Differential from "./Differential.ts";
import * as Features from "./Features.ts";
import * as Runner from "./Runner.ts";
import * as Score from "./Score.ts";

class ConformanceCheckFailed extends Schema.TaggedError<ConformanceCheckFailed>()(
  "ConformanceCheckFailed",
  { reasons: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Conformance check failed:\n- ${this.reasons.join("\n- ")}`;
  }
}

const Upstream = Schema.fromJsonString(
  Schema.Struct({
    tag: Schema.String,
    paths: Schema.Array(Schema.String),
    objects: Schema.Record(Schema.String, Schema.String),
  }),
);

const readUpstream = Effect.fn("Conformance.readUpstream")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* paths;
  return yield* Schema.decodeEffect(Upstream)(yield* fs.readFileString(files.upstream));
});

const referenceJar = Effect.fn("Conformance.referenceJar")(function* () {
  const path = yield* Path.Path;
  const files = yield* paths;
  const { tag } = yield* readUpstream();
  return path.join(files.root, ".cache/epubcheck", `epubcheck-${tag.slice(1)}`, "epubcheck.jar");
});

// The committed vendored copy must stay byte-identical to upstream: every vendored path needs a
// recorded git object id, and HEAD's object for that path must equal it.
const vendorProblems = Effect.fn("Conformance.vendorProblems")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const files = yield* paths;
  const upstream = yield* readUpstream();
  const problems: Array<string> = [];
  for (const relative of upstream.paths) {
    const expected = upstream.objects[relative];
    if (expected === undefined) {
      problems.push(`vendor/epubcheck/UPSTREAM.json records no object id for ${relative}.`);
      continue;
    }
    const actual = yield* spawner
      .string(
        ChildProcess.make("git", ["rev-parse", `HEAD:vendor/epubcheck/${relative}`], {
          cwd: files.root,
        }),
      )
      .pipe(
        Effect.map((output) => output.trim()),
        Effect.catchTags({ PlatformError: () => Effect.void }),
      );
    if (actual === undefined) {
      problems.push(`Cannot run git to verify vendor/epubcheck/${relative}.`);
    } else if (actual !== expected) {
      problems.push(
        `vendor/epubcheck/${relative} differs from upstream; vendored files must stay verbatim.`,
      );
    }
  }
  return problems;
});

const paths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../..");
  return {
    root,
    resources: path.join(root, "vendor/epubcheck/src/test/resources"),
    upstream: path.join(root, "vendor/epubcheck/UPSTREAM.json"),
    score: path.join(root, "conformance/score.json"),
    passing: path.join(root, "conformance/passing.txt"),
    readme: path.join(root, "README.md"),
    referenceCache: path.join(root, ".cache/reference-reports"),
  };
});

const filterFlag = Flag.String("filter").pipe(
  Flag.withDescription("Only run scenarios whose id or name contains this text."),
  Flag.optional,
);

const runAll = Effect.fn("Conformance.runAll")(function* (filter: Option.Option<string>) {
  const files = yield* paths;
  const upstream = yield* readUpstream();
  const scenarios = (yield* Features.loadScenarios(files.resources)).filter((scenario) =>
    Option.match(filter, {
      onNone: () => true,
      onSome: (text) => scenario.id.includes(text) || scenario.name.includes(text),
    }),
  );
  const results = yield* Runner.runScenarios(scenarios, files.resources);
  return { results, score: Score.summarize(results, upstream.tag) };
});

const printSummary = (score: Score.Score) =>
  Console.log(
    [
      `Conformance: ${score.passed} / ${score.total} scenarios passing (upstream EPUBCheck ${score.upstream})`,
      `Scenarios expecting reported messages: ${score.expectsMessages.passed} / ${score.expectsMessages.total}`,
      ...Object.entries(score.areas).map(
        ([area, tally]) =>
          `  ${area.padEnd(48)} ${String(tally.passed).padStart(4)} / ${tally.total}`,
      ),
    ].join("\n"),
  );

const run = Command.make(
  "run",
  {
    filter: filterFlag,
    failures: Flag.Boolean("failures").pipe(
      Flag.withDescription("Print each failing scenario and why it failed."),
      Flag.withDefault(false),
    ),
    oracle: Flag.Boolean("oracle").pipe(
      Flag.withDescription(
        "Answer every check with the reference EPUBCheck jar instead of epubcheck-ts, to validate the harness.",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("Conformance.run")(function* ({ filter, failures, oracle }) {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* paths;
    const jar = yield* referenceJar();
    if (oracle && !(yield* fs.exists(jar))) {
      return yield* new Differential.ReferenceJarMissing({ jar });
    }
    const { results, score } = yield* oracle
      ? runAll(filter).pipe(
          Effect.provide(
            Differential.referenceLayer({
              jar,
              cacheDir: files.referenceCache,
              resourcesDir: files.resources,
            }),
          ),
        )
      : runAll(filter);
    if (failures) {
      for (const result of results) {
        if (result.status !== "passed") {
          yield* Console.log(
            `${result.status.toUpperCase()} ${result.scenario.id} ${result.scenario.name}\n    ${result.detail ?? ""}`,
          );
        }
      }
    }
    yield* printSummary(score);
  }),
).pipe(Command.withDescription("Run the upstream scenarios and print the score."));

const update = Command.make(
  "update",
  {},
  Effect.fn("Conformance.update")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* paths;
    const { results, score } = yield* runAll(Option.none());
    yield* fs.writeFileString(files.score, Score.renderScore(score));
    yield* fs.writeFileString(files.passing, Score.renderPassing(results));
    const readme = yield* fs.readFileString(files.readme);
    yield* fs.writeFileString(files.readme, Score.injectTable(readme, score));
    yield* printSummary(score);
  }),
).pipe(
  Command.withDescription(
    "Rewrite conformance/score.json, conformance/passing.txt and the README table.",
  ),
);

const check = Command.make(
  "check",
  {
    baselineScore: Flag.String("baseline-score").pipe(
      Flag.withDescription(
        "score.json from the base branch; the run fails if the score drops below it.",
      ),
      Flag.optional,
    ),
    baselinePassing: Flag.String("baseline-passing").pipe(
      Flag.withDescription("passing.txt from the base branch, used to list regressed scenarios."),
      Flag.optional,
    ),
  },
  Effect.fn("Conformance.check")(function* ({ baselineScore, baselinePassing }) {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* paths;
    const { results, score } = yield* runAll(Option.none());
    yield* printSummary(score);
    const reasons: Array<string> = [];
    const passing = Score.renderPassing(results);
    if ((yield* fs.readFileString(files.score)) !== Score.renderScore(score)) {
      reasons.push(
        "conformance/score.json is stale; run `pnpm conformance update` and commit the result.",
      );
    }
    if ((yield* fs.readFileString(files.passing)) !== passing) {
      reasons.push(
        "conformance/passing.txt is stale; run `pnpm conformance update` and commit the result.",
      );
    }
    if (!(yield* fs.readFileString(files.readme)).includes(Score.renderTable(score))) {
      reasons.push(
        "The README conformance table is stale; run `pnpm conformance update` and commit the result.",
      );
    }
    if (Option.isSome(baselinePassing)) {
      const comparison = Score.comparePassing(
        yield* fs.readFileString(baselinePassing.value),
        passing,
      );
      yield* Console.log(
        `Versus baseline: +${comparison.improvements.length} newly passing, -${comparison.regressions.length} newly failing`,
      );
      for (const line of comparison.regressions) yield* Console.log(`  regressed: ${line}`);
    }
    if (Option.isSome(baselineScore)) {
      const baseline = yield* Score.decodeScore(yield* fs.readFileString(baselineScore.value));
      if (score.passed < baseline.passed) {
        reasons.push(
          `The score dropped from ${baseline.passed} to ${score.passed} passing scenarios.`,
        );
      }
      if (score.expectsMessages.passed < baseline.expectsMessages.passed) {
        reasons.push(
          `Scenarios expecting messages dropped from ${baseline.expectsMessages.passed} to ${score.expectsMessages.passed}.`,
        );
      }
    }
    reasons.push(...(yield* vendorProblems()));
    if (reasons.length > 0) return yield* new ConformanceCheckFailed({ reasons });
  }),
).pipe(
  Command.withDescription(
    "Fail when committed results are stale or the score dropped below a baseline.",
  ),
);

const diff = Command.make(
  "diff",
  {
    filter: filterFlag,
    jobs: Flag.Int("jobs").pipe(
      Flag.withDescription("Reference jar processes to run at once."),
      Flag.withDefault(6),
    ),
  },
  Effect.fn("Conformance.diff")(function* ({ filter, jobs }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = yield* paths;
    const jar = yield* referenceJar();
    if (!(yield* fs.exists(jar))) return yield* new Differential.ReferenceJarMissing({ jar });
    const { results } = yield* runAll(filter);
    const checks = new Map(
      results
        .flatMap((result) => result.checks)
        .map((entry) => [JSON.stringify(entry.invocation), entry] as const),
    );
    const reference = {
      jar,
      cacheDir: files.referenceCache,
      resourcesDir: files.resources,
    };
    const differences = yield* Effect.forEach(
      [...checks.values()],
      (entry) =>
        Differential.runReference(reference, entry.invocation).pipe(
          Effect.map((messages) =>
            Differential.compare(
              entry.invocation.path,
              entry.invocation.mode,
              entry.messages,
              messages,
            ),
          ),
        ),
      { concurrency: jobs },
    );
    const disagreements = differences.filter(
      (difference) => difference.missing.length > 0 || difference.extra.length > 0,
    );
    for (const difference of disagreements) {
      const input = path.relative(files.resources, difference.path);
      yield* Console.log(
        `${input} [${difference.mode}]\n    missing: ${difference.missing.join(", ") || "-"}\n    extra:   ${difference.extra.join(", ") || "-"}`,
      );
    }
    yield* Console.log(
      `Differential: ${differences.length - disagreements.length} / ${differences.length} inputs report the same message IDs and severities as EPUBCheck`,
    );
  }),
).pipe(
  Command.withDescription(
    "Diff epubcheck-ts against the reference EPUBCheck jar on every scenario input.",
  ),
);

const conformance = Command.make("conformance").pipe(
  Command.withDescription("Run the upstream EPUBCheck conformance suite against epubcheck-ts."),
  Command.withSubcommands([run, update, check, diff]),
);

Command.run(conformance, { version: "0.0.0" }).pipe(
  Effect.provide(EpubCheck.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain,
);
