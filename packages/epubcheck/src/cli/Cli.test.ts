import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EpubCheck from "../EpubCheck.ts";
import * as Cli from "./Cli.ts";

// Runs the command line on arguments that never reach a check.
const run = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let stdout = "";
    let stderr = "";
    const terminal = Cli.Terminal.of({
      stdout: (text) =>
        Effect.sync(() => {
          stdout += text;
        }),
      stderr: (text) =>
        Effect.sync(() => {
          stderr += text;
        }),
    });
    const outcome = yield* Cli.main(argv, { cwd: "/nowhere", defaultLocale: "en" }).pipe(
      Effect.provideService(Cli.Terminal, terminal),
    );
    return { exitCode: outcome.exitCode, stdout, stderr };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(
          EpubCheck.EpubCheck,
          EpubCheck.EpubCheck.of({ check: () => Effect.die("unexpected check") }),
        ),
      ),
    ),
  );

const HELP = "EPUBCheck v5.4.0\n\nWhen running this tool";

describe("Cli.main", () => {
  // Each answer is EPUBCheck 5.4.0's: exit code, and the start of standard output and error.
  it.effect.each([
    { argv: [], exitCode: 1, stdout: "", stderr: "At least one argument expected\n" },
    { argv: ["--version"], exitCode: 0, stdout: "EPUBCheck v5.4.0\n", stderr: "" },
    { argv: ["-h"], exitCode: 0, stdout: HELP, stderr: "" },
    { argv: ["-v", "3.1", "a.epub"], exitCode: 1, stdout: "-help displays help\n", stderr: "" },
    {
      argv: ["a.epub", "b.epub"],
      exitCode: 1,
      stdout: HELP,
      stderr: 'Unrecognized argument: "b.epub"\n',
    },
    {
      argv: ["-c", "-x", "a.epub"],
      exitCode: 1,
      stdout: HELP,
      stderr: 'Expected the Custom message file name, but found "-x"\n',
    },
    {
      argv: ["-j", "a.json", "-o", "b.xml", "a.epub"],
      exitCode: 1,
      stdout: "",
      stderr: "Only one output format can be specified at a time.\n",
    },
    {
      argv: ["--maxOfEachMessage", "3x", "a.epub"],
      exitCode: 1,
      stdout: HELP,
      stderr: "Argument \"3x\" to the --maxOfEachMessage option must be a number or 'unlimited'.\n",
    },
    // Upstream fails on a report flag before any path, without a message.
    { argv: ["--json"], exitCode: 1, stdout: "", stderr: "" },
    {
      argv: ["bookdir"],
      exitCode: 1,
      stdout: "Mode required for non-epub files. Default version is 3.0.\n",
      stderr: "",
    },
    { argv: ["-q", "--version"], exitCode: 0, stdout: "", stderr: "" },
  ])("handles $argv", ({ argv, exitCode, stdout, stderr }) =>
    Effect.gen(function* () {
      const result = yield* run(argv);
      expect(result.exitCode).toBe(exitCode);
      if (stdout === "") expect(result.stdout).toBe("");
      else expect(result.stdout.startsWith(stdout)).toBe(true);
      expect(result.stderr).toBe(stderr);
    }),
  );
});
