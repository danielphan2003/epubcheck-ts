import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Collect from "./Collect.ts";
import * as Url from "./Url.ts";

describe("Collect.srcsetUrls", () => {
  it.each([
    { srcset: "a.png 1x, b.png 2x", urls: ["a.png", "b.png"] },
    // As in HTML, a URL runs to the next space, commas included.
    { srcset: "a.png,b.png", urls: ["a.png,b.png"] },
    { srcset: "a.png 100w, b.png (max-width: 10px) 200w", urls: ["a.png", "b.png"] },
    {
      srcset: "data:image/png;base64,AAA= 1x, b.png 2x",
      urls: ["data:image/png;base64,AAA=", "b.png"],
    },
    { srcset: "data:image/png;base64,\n  AAA= 1x", urls: ["data:image/png;base64,AAA="] },
  ])("reads $srcset", ({ srcset, urls }) => {
    expect(Collect.srcsetUrls(srcset)).toEqual(urls);
  });
});

describe("Collect.fromDocument in a Navigation Document", () => {
  const document = (head: string, body: string) => {
    const parsed = Xml.parse(
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head>${head}</head><body>${body}</body></html>`,
    );
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    return parsed.success;
  };
  const links = (...hrefs: ReadonlyArray<string>) =>
    hrefs.map((href) => `<a href="${href}">x</a>`).join("");
  // Each row's findings are EPUBCheck 5.4.0's; the toc links are those its reading order check
  // reads, in order.
  it.each([
    {
      name: "a remote link",
      body: `<nav epub:type="toc">${links("https://example.org/x")}</nav>`,
      found: [["NAV-010", "toc", "https://example.org/x"]],
      toc: [],
    },
    {
      name: "a link against a remote base",
      head: '<base href="http://example.org/"/>',
      body: `<nav epub:type="toc">${links("c1.xhtml")}</nav>`,
      found: [["NAV-010", "toc", "c1.xhtml"]],
      toc: [],
    },
    {
      name: "a link against the nav's base",
      body: `<nav epub:type="toc" xml:base="http://example.org/">${links("c1.xhtml")}</nav>`,
      found: [["NAV-010", "toc", "c1.xhtml"]],
      toc: [],
    },
    // The last type upstream tests names the nav.
    {
      name: "a toc and page list",
      body: `<nav epub:type="toc page-list">${links("https://example.org/x")}</nav>`,
      found: [["NAV-010", "page-list", "https://example.org/x"]],
      toc: [],
    },
    // A nested nav sets the type if it has one of its own, and any `</nav>` ends it.
    {
      name: "a nested landmarks nav",
      body: `<nav epub:type="toc">${links("c2.xhtml")}<nav epub:type="landmarks">${links("c1.xhtml")}</nav>${links("https://example.org/a")}</nav>`,
      found: [],
      toc: ["EPUB/c2.xhtml"],
    },
    {
      name: "a nested nav without types",
      body: `<nav epub:type="toc">${links("c2.xhtml")}<nav>${links("c1.xhtml")}</nav>${links("https://example.org/a")}</nav>`,
      found: [],
      toc: ["EPUB/c2.xhtml", "EPUB/c1.xhtml"],
    },
    // upstream splits `epub:type` on ASCII whitespace only.
    {
      name: "a type joined by a no-break space",
      body: `<nav epub:type="landmarks\u00a0x">${links("https://example.org/x")}</nav>`,
      found: [],
      toc: [],
    },
    // galimatias strips Java whitespace around a URL; the message quotes it as written.
    {
      name: "a remote link after an ideographic space",
      body: `<nav epub:type="toc">${links("\u3000https://example.org/r")}</nav>`,
      found: [["NAV-010", "toc", "\u3000https://example.org/r"]],
      toc: [],
    },
    // A document checked alone has its own `file:` URL, whose origin a host-less one shares.
    {
      name: "a file link in a document checked alone",
      body: `<nav epub:type="toc">${links("file:///etc/passwd")}</nav>`,
      alone: true,
      found: [
        ["RSC-030", "file:///etc/passwd"],
        ["RSC-030", "file:///etc/passwd"],
      ],
      toc: ["file:///etc/passwd"],
    },
    // Upstream checks each link of a Navigation Document twice.
    {
      name: "an invalid URL",
      body: `<nav epub:type="toc">${links("http://exa mple.org/")}</nav>`,
      found: [
        [
          "RSC-020",
          "http://exa mple.org/",
          "Invalid host: Illegal character in domain: space is not allowed",
        ],
        [
          "RSC-020",
          "http://exa mple.org/",
          "Invalid host: Illegal character in domain: space is not allowed",
        ],
      ],
      toc: [],
    },
    // The fragment is the URL's, without the whitespace around it.
    {
      name: "a link with whitespace around it",
      body: `<nav epub:type="toc">${links(" c1.xhtml#a ")}</nav>`,
      found: [],
      toc: ["EPUB/c1.xhtml#a"],
    },
  ])("reads $name", ({ head, body, alone, found, toc }) => {
    const context = { version: "3", container: alone !== true, navigation: true } as const;
    const read = Collect.fromDocument(document(head ?? "", body), "EPUB/nav.xhtml", context);
    expect(read.findings.map(({ id, args }) => [id, ...args])).toEqual(found);
    expect(read.tocLinks.map(({ resolved }) => Url.referenceName(resolved))).toEqual(toc);
  });
});

describe("Collect.fromDocument SVG references", () => {
  // Each row's references are those EPUBCheck 5.4.0 checks for an SVG document's attributes.
  it.each([
    {
      name: "paint and clip path URLs",
      attributes: 'fill="url(#g)" stroke="url(\'#p\')" clip-path="url(&quot;#c&quot;)"',
      found: [
        ["svg-paint", "EPUB/s.svg#g"],
        ["svg-paint", "EPUB/s.svg#p"],
        ["svg-clip-path", "EPUB/s.svg#c"],
      ],
    },
    // Upstream reads a value only written exactly as `url(...)`.
    {
      name: "other spellings",
      attributes: 'fill="URL(#g)" stroke=" url(#g)" clip-path="url(#c) "',
      found: [],
    },
    {
      name: "other properties",
      attributes: 'mask="url(#m)" filter="url(#f)" marker-start="url(#k)"',
      found: [],
    },
  ])("reads $name", ({ attributes, found }) => {
    const parsed = Xml.parse(`<svg xmlns="http://www.w3.org/2000/svg"><rect ${attributes}/></svg>`);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const { references } = Collect.fromDocument(parsed.success, "EPUB/s.svg", {
      version: "3",
      container: true,
    });
    expect(references.map((reference) => [reference.type, Url.referenceName(reference)])).toEqual(
      found,
    );
  });
});

describe("Collect.idTypes", () => {
  // Upstream types an ID by its first element: SVG paint servers, clip paths and symbols.
  it("types IDs by their first element", () => {
    const parsed = Xml.parse(
      '<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g"/><pattern id="p"/><clipPath id="c"/><symbol id="s"/><mask id="m"/><solidcolor id="k"/><rect id="g"/></svg>',
    );
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    expect([...Collect.idTypes(parsed.success)]).toEqual([
      ["g", "svg-paint"],
      ["p", "svg-paint"],
      ["c", "svg-clip-path"],
      ["s", "svg-symbol"],
      ["m", "generic"],
      ["k", "generic"],
    ]);
  });
});
