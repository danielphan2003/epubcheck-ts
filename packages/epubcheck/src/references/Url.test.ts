import { describe, expect, it } from "@effect/vitest";

import * as Url from "./Url.ts";

describe("Url.syntaxProblem", () => {
  // Each answer is EPUBCheck 5.4.0's RSC-020 detail, from galimatias in strict mode.
  it.each([
    { url: "images/cover.png", problem: undefined },
    { url: "café.png#top", problem: undefined },
    { url: " lead.png ", problem: undefined },
    { url: "//example.org/a", problem: undefined },
    { url: "a b.png", problem: "Illegal character in path segment: space is not allowed" },
    { url: 'a"b.png', problem: 'Illegal character in path segment: “"” is not allowed' },
    { url: "a{b.png", problem: "Illegal character in path segment: “{” is not allowed" },
    { url: "a\u007fb.png", problem: "Illegal character in path segment: “\u007f” is not allowed" },
    { url: "a\\c.png", problem: 'Backslash ("\\") used as path segment delimiter' },
    { url: "\\\\example.org\\a", problem: 'Backslash ("\\") used as path segment delimiter' },
    { url: "a%zz.png", problem: 'Percentage ("%") is not followed by two hexadecimal digits' },
    { url: "x.png?a%zz", problem: 'Percentage ("%") is not followed by two hexadecimal digits' },
    { url: "a\tb.png", problem: "Tab, new line or carriage return found" },
    { url: "x.png?a b", problem: "Illegal character in query: space is not allowed" },
    { url: "x.png?a`b", problem: "Illegal character in query: “`” is not allowed" },
    { url: "x.png#a b", problem: "Illegal character in fragment: space is not allowed" },
    { url: "x.png#a#b", problem: "Illegal character in fragment: “#” is not allowed" },
    { url: "a b\\c.png", problem: "Illegal character in path segment: space is not allowed" },
    { url: "ht tp://x", problem: "Illegal character in path segment: space is not allowed" },
    { url: "mailto:a b@x.org", problem: "Illegal character in scheme data: space is not allowed" },
    { url: "http:/example.org/a", problem: 'Expected a slash ("/")' },
    {
      url: "http://a b/",
      problem: "Invalid host: Illegal character in domain: space is not allowed",
    },
    { url: "http://[::1/", problem: "Invalid host: Unmatched '['" },
    { url: "http://x.org:99999/", problem: "Port number must be less than 65536" },
    {
      url: "http://us@er@x.org/",
      problem: 'User or password contains an at symbol ("@") not percent-encoded',
    },
    { url: "http://x.org/a\\c", problem: 'Backslash ("\\") used as path segment delimiter' },
  ])("checks $url", ({ url, problem }) => {
    expect(Url.syntaxProblem(url)).toBe(problem);
  });
});

describe("Url.checker", () => {
  const container = { container: true };
  // Targets and findings as EPUBCheck 5.4.0 reports them for EPUB/content.xhtml.
  it.each([
    { url: "img/a.png", target: { kind: "local", path: "EPUB/img/a.png" }, ids: [] },
    { url: "./", target: { kind: "local", path: "EPUB/" }, ids: [] },
    { url: "my%20image.png", target: { kind: "local", path: "EPUB/my image.png" }, ids: [] },
    { url: "café.png", target: { kind: "local", path: "EPUB/café.png" }, ids: [] },
    { url: "%2E%2E/z.png", target: { kind: "local", path: "z.png" }, ids: [] },
    { url: "dir\\a.png", target: { kind: "local", path: "EPUB/dir/a.png" }, ids: ["RSC-020"] },
    { url: "a.png?v=1", target: { kind: "local", path: "EPUB/a.png" }, ids: ["RSC-033"] },
    // A leaking URL is reported, then resolved at the container root.
    { url: "../../x.png", target: { kind: "local", path: "x.png" }, ids: ["RSC-026"] },
    { url: "/abs.png", target: { kind: "local", path: "abs.png" }, ids: ["RSC-026"] },
    {
      url: "https://example.org/a%20b.png#f",
      target: { kind: "remote", url: "https://example.org/a%20b.png", scheme: "https" },
      ids: [],
    },
    {
      url: "file:///etc/a.png",
      target: { kind: "remote", url: "file:///etc/a.png", scheme: "file" },
      ids: ["RSC-030"],
    },
    { url: "data:text/plain,x", target: { kind: "data", mediaType: "text/plain" }, ids: [] },
  ])("resolves $url", ({ url, target, ids }) => {
    const { problems, resolved } = Url.checker("EPUB/content.xhtml", container).check(url);
    expect(resolved?.target).toEqual(target);
    expect(problems.map((problem) => problem.id)).toEqual(ids);
  });

  it("stops reporting queries and leaks after an absolute URL, as upstream does", () => {
    const checker = Url.checker("EPUB/content.xhtml", container);
    expect(checker.check("a.png?v=1").problems.map((problem) => problem.id)).toEqual(["RSC-033"]);
    checker.check("https://example.org/");
    expect(checker.check("b.png?v=1").problems).toEqual([]);
    expect(checker.check("/abs.png").problems).toEqual([]);
  });

  it("resolves against an absolute base", () => {
    const checker = Url.checker("EPUB/content.xhtml", container);
    checker.setBase("https://example.org/book/");
    expect(checker.check("a.png").resolved?.target).toEqual({
      kind: "remote",
      url: "https://example.org/book/a.png",
      scheme: "https",
    });
  });

  it("reports container leaks only in a publication", () => {
    const checker = Url.checker("content.xhtml", { container: false });
    expect(checker.check("/abs.png").problems).toEqual([]);
  });
});

describe("Url.encodePath", () => {
  it.each([
    { path: "EPUB/my image.png", encoded: "EPUB/my%20image.png" },
    { path: "EPUB/café.png", encoded: "EPUB/caf%C3%A9.png" },
    { path: "EPUB/a%zz.png", encoded: "EPUB/a%25zz.png" },
    { path: "EPUB/a?b#c.png", encoded: "EPUB/a%3Fb%23c.png" },
    { path: "EPUB/(a)+b~c.png", encoded: "EPUB/(a)+b~c.png" },
  ])("encodes $path", ({ path, encoded }) => {
    expect(Url.encodePath(path)).toBe(encoded);
  });
});
