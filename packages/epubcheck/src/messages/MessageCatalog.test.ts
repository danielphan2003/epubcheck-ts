import { describe, expect, it } from "@effect/vitest";

import { defaultSeverity, formatMessage, formatSuggestion, isMessageId } from "./MessageCatalog.ts";

describe("MessageCatalog", () => {
  it("formats positional arguments like Java String.format", () => {
    expect(formatMessage("PKG-009", ["a:b.xhtml", '":"'])).toBe(
      'The file name "a:b.xhtml" contains characters that are not allowed in OCF file names: ":".',
    );
  });

  it("reports a missing argument the way upstream's formatter does", () => {
    expect(formatMessage("PKG-020", [])).toBe(
      `OPF file "%1$s" could not be found. !!! Format specifier '%1$s'`,
    );
  });

  it("replaces a localized argument keyword with its bundle value, formatted by later arguments", () => {
    expect(formatMessage("OBS-001", ["element", "bindings"])).toContain("the bindings element");
    // Java .properties drops the space after `=`, so upstream renders no space before "with".
    expect(formatMessage("PKG-007", ["whitespace"])).toBe(
      'The content of the mimetype file must be the string "application/epub+zip"with no whitespace or newline.',
    );
  });

  it("falls back from a regional locale to the language and then the default bundle", () => {
    expect(formatMessage("PKG-018", [], "fr-CA")).toBe(formatMessage("PKG-018", [], "fr"));
    expect(formatMessage("PKG-018", [], "xx")).toBe("The EPUB file could not be found.");
  });

  it("exposes upstream default severities and suggestions", () => {
    expect(defaultSeverity("PKG-018")).toBe("FATAL");
    expect(defaultSeverity("PKG-012")).toBe("USAGE");
    expect(formatSuggestion("HTM-011")).toBe(
      "Define the entity or use the numbered entity instead.",
    );
    expect(isMessageId("OPF-001")).toBe(true);
    expect(isMessageId("OPF-999")).toBe(false);
  });
});
