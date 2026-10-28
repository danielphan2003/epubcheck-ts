import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const TEST_EXCLUDE = [
  "**/vendor/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/.{idea,git,cache,output,temp}/**",
];

const GENERATED_AND_VENDORED = [
  "vendor/**",
  "node_modules",
  "dist",
  ".cache",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
  "**/*.generated.ts",
  "conformance/score.json",
];

export default defineConfig({
  test: {
    environment: "node",
    exclude: TEST_EXCLUDE,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: GENERATED_AND_VENDORED,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: GENERATED_AND_VENDORED,
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "typescript/no-this-alias": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-array-reverse": "off",
      "typescript/no-extraneous-class": "error",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "unicorn/no-useless-spread": "error",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "eslint/no-unsafe-optional-chaining": "error",
      "eslint/no-unneeded-ternary": "error",
      "unicorn/no-useless-fallback-in-spread": "error",
      "unicorn/require-module-specifiers": "error",
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-explicit-any": "error",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "effect",
              message:
                'Import Effect modules as namespaces from their subpaths: import * as Effect from "effect/Effect".',
            },
          ],
        },
      ],
    },
  },
});
