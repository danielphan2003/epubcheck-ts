import type * as Collect from "../references/Collect.ts";
import * as Url from "../references/Url.ts";
import * as MediaTypes from "../resources/MediaTypes.ts";
import { trimBy } from "../util/JavaText.ts";
import * as CssParser from "./CssParser.ts";

// EPUB style sheet rules, as upstream's CSS handler applies them while its parser reads a sheet:
// syntax errors (CSS-008), forbidden and obsolete properties, `@font-face` rules, the sheet's
// URLs, and the Media Overlays classes its selectors use.

// The font types `@font-face` may use (CSS-007).
const isFontType = (mediaType: string, version: "2" | "3") =>
  version === "3"
    ? MediaTypes.isCoreFont(mediaType)
    : /^(?:font\/|application\/font|application\/x-font)/.test(mediaType) ||
      mediaType === "application/vnd.ms-opentype";

const spaceOrQuote = (c: number) => CssParser.isWhitespace(c) || CssParser.isQuote(c);

// Java's String.trim: every character up to U+0020.
const isBlank = (value: string) => /^[\x00-\x20]*$/.test(value);

const usesClass = (construct: CssParser.Construct, name: string): boolean =>
  construct.type === "class"
    ? construct.value === name
    : "components" in construct && construct.components.some((each) => usesClass(each, name));

export interface Source {
  readonly path: string;
  readonly context: Collect.Context;
  // The line of the document the CSS text is on, which its lines count from; 0 for a file.
  readonly offset: number;
  readonly styleAttribute: boolean;
}

export const check = (css: string, { path, context, offset, styleAttribute }: Source) => {
  const findings: Array<Collect.Finding> = [];
  const references: Array<Collect.Reference> = [];
  const fonts: Array<{ readonly embedded: boolean; readonly name: string }> = [];
  // Upstream corrects the line of a position in a document, never the column.
  const at = (line: number, column: number) => ({ path, line: offset + line, column });
  const urls = Url.checker(path, context);
  const parsed = new Map<string, Url.Resolved | undefined>();
  let remote = false;
  let ended = false;

  const register = (url: string, line: number, column: number, type: Collect.ReferenceType) => {
    if (isBlank(url)) {
      findings.push({ id: "CSS-002", args: [], ...at(line, column) });
      return;
    }
    // A fragment-only URL would point into the document using the sheet; upstream skips it.
    if (url.startsWith("#")) return;
    const { problems, resolved } = urls.check(url);
    for (const problem of problems) findings.push({ ...problem, ...at(line, column) });
    parsed.set(url, resolved);
    if (resolved === undefined) return;
    // A remote style sheet is reported anyway (RSC-006); it does not need the property.
    if (type !== "stylesheet" && resolved.target.kind === "remote") remote = true;
    references.push({ ...resolved, type, resource: false, ...at(line, column) });
  };

  // The handler's state, which upstream keeps for the whole sheet: a family, style, weight and
  // source carry over to later `@font-face` rules that do not set their own.
  let rule: CssParser.AtRule | undefined;
  let inFontFace = false;
  let declared = false;
  let family: string | undefined;
  let style: string | undefined;
  let weight: string | undefined;
  let source: string | undefined;

  const failed = (message: string) => {
    findings.push({ id: "PKG-008", args: [message], path, line: -1, column: -1 });
  };
  const result = () => ({ findings, references, fonts, remote, ended });

  for (const event of CssParser.parse(css, styleAttribute, context.locale)) {
    switch (event.kind) {
      case "error":
        findings.push({ id: "CSS-008", args: [event.message], ...at(event.line, event.column) });
        break;
      // Upstream reports the exceptions its parser and handler throw.
      case "failure":
        failed("null");
        return result();
      case "at-rule": {
        rule = event.rule;
        if (rule.name === "@import") {
          const first = rule.components[0];
          if (first === undefined) {
            failed("Index 0 out of bounds for length 0");
            return result();
          }
          const url =
            first.type === "uri"
              ? CssParser.uriText(first.value)
              : first.type === "string"
                ? trimBy(CssParser.cssText(first), CssParser.isQuote)
                : undefined;
          if (url !== undefined) register(url, first.line, first.column, "stylesheet");
        } else if (rule.name !== "@namespace") {
          for (const component of rule.components) {
            if (component.type !== "uri") continue;
            const url = CssParser.uriText(component.value);
            register(url, rule.line, rule.column, inFontFace ? "font" : "generic");
          }
        }
        if (rule.name === "@font-face") inFontFace = true;
        break;
      }
      case "end-at-rule":
        if (inFontFace) {
          inFontFace = false;
          if (family !== undefined) {
            const shown = [style, weight].filter(
              (value) => value !== undefined && value.toLowerCase() !== "normal",
            );
            const embedded = source !== undefined && !source.startsWith("http");
            fonts.push({ embedded, name: [family, ...shown].join(",") });
          }
          // Upstream reports this at the rule's own position, uncorrected.
          if (!declared) {
            findings.push({
              id: "CSS-019",
              args: [],
              path,
              line: rule?.line ?? -1,
              column: rule?.column ?? -1,
            });
          }
          declared = false;
        }
        rule = undefined;
        break;
      case "selectors":
        for (const selector of event.selectors) {
          for (const [name, property] of context.undeclaredClasses ?? []) {
            if (!usesClass(selector, `.${name}`)) continue;
            findings.push({
              id: "CSS-029",
              args: [name, property],
              ...at(selector.line, selector.column),
            });
          }
        }
        break;
      case "declaration": {
        const { name, components, line, column } = event.declaration;
        for (const component of components) {
          if (component.type !== "uri") continue;
          register(
            CssParser.uriText(component.value),
            line,
            column,
            inFontFace ? "font" : "generic",
          );
        }
        const first = components[0];
        if (name.startsWith("-epub-")) {
          findings.push({
            id: "OBS-001",
            args: ["css-prefixed-property", name],
            ...at(line, column),
          });
        } else if (
          name === "text-transform" &&
          components.some((component) => CssParser.cssText(component) === "-epub-fullwidth")
        ) {
          findings.push({
            id: "OBS-001",
            args: ["css-prefixed-value", "-epub-fullwidth"],
            ...at(line, column),
          });
        }
        if (name === "position" && first !== undefined) {
          if (CssParser.cssText(first).toLowerCase() === "fixed") {
            findings.push({ id: "CSS-006", args: [], ...at(line, column) });
          }
        }
        if (context.version === "3" && (name === "direction" || name === "unicode-bidi")) {
          findings.push({ id: "CSS-001", args: [name], ...at(line, column) });
        }
        if (!inFontFace) break;
        declared = true;
        const value = first === undefined ? undefined : CssParser.cssText(first);
        if (name === "font-family") {
          if (value !== undefined) family = trimBy(value, spaceOrQuote);
        } else if (name === "font-style") style = value;
        else if (name === "font-weight") weight = value;
        else if (name === "src") {
          for (const component of components) {
            if (component.type !== "uri") continue;
            const resolved = parsed.get(CssParser.uriText(component.value));
            if (resolved === undefined || !context.container) continue;
            source = Url.referenceName(resolved);
            // Upstream looks the font up with its fragment, so a font with one is never checked.
            const mediaType =
              resolved.fragment === undefined ? context.mediaTypeOf?.(resolved.target) : undefined;
            if (mediaType !== undefined && !isFontType(mediaType, context.version)) {
              findings.push({
                id: "CSS-007",
                args: [Url.nameOf(resolved.target), mediaType],
                ...at(line, column),
              });
            }
          }
        }
        findings.push({ id: "CSS-028", args: [], ...at(line, column) });
        break;
      }
      case "end":
        ended = true;
        break;
    }
  }
  return result();
};

// Upstream's byte order marks, in the order it tries them; its UTF-32LE mark is FE FF 00 00.
const MARKS = [
  ["UTF-32BE", [0x00, 0x00, 0xfe, 0xff]],
  ["UTF-32LE", [0xfe, 0xff, 0x00, 0x00]],
  ["UTF-8", [0xef, 0xbb, 0xbf]],
  ["UTF-16BE", [0xfe, 0xff]],
  ["UTF-16LE", [0xff, 0xfe]],
] as const;

const decodeUtf32 = (bytes: Uint8Array, little: boolean) => {
  let text = "";
  for (let index = 0; index < bytes.length; index += 4) {
    const [a = 0, b = 0, c = 0, d = 0] = bytes.subarray(index, index + 4);
    const code = little
      ? (d << 24) | (c << 16) | (b << 8) | a
      : (a << 24) | (b << 16) | (c << 8) | d;
    const valid =
      index + 4 <= bytes.length &&
      code >= 0 &&
      code <= 0x10ffff &&
      (code < 0xd800 || code > 0xdfff);
    text += valid ? String.fromCodePoint(code) : "�";
  }
  return text;
};

const decodeAs = (bytes: Uint8Array, encoding: string) => {
  const name = encoding.toLowerCase();
  if (name.startsWith("utf-32")) return decodeUtf32(bytes, name.endsWith("le"));
  // Java decodes BOM-less UTF-16 as big-endian, and keeps any byte order mark as a character.
  const label = name === "utf-16" ? "utf-16be" : name;
  try {
    return new TextDecoder(label, { ignoreBOM: true }).decode(bytes);
  } catch {
    // Java falls back to its default encoding for a name it does not know.
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  }
};

// A style sheet file as upstream reads it: by its byte order mark, else its `@charset`, else as
// UTF-8. UTF-16 is tolerated (CSS-003), any other encoding is an error (CSS-004).
export const decodeFile = (bytes: Uint8Array, path: string) => {
  const read = Math.min(4, bytes.length);
  const head = [0, 1, 2, 3].map((index) => (index < read ? (bytes[index] ?? 0) : 0));
  const mark = MARKS.find(([, marker]) => marker.every((byte, index) => head[index] === byte));
  // Upstream pushes back what its four-byte read took past the mark, which is wrong for a file
  // shorter than that.
  const back = mark === undefined ? read : 4 - mark[1].length;
  const stream = new Uint8Array([
    ...bytes.subarray(Math.max(0, read - back), read),
    ...bytes.subarray(read),
  ]);

  // Its `@charset` sniffing reads a character per code unit, from at most 256 bytes.
  const encoding = mark?.[0] ?? "UTF-8";
  const width = encoding.startsWith("UTF-16") ? 2 : encoding.startsWith("UTF-32") ? 4 : 1;
  const little = width === 1 || encoding.endsWith("LE");
  let charset: string | undefined;
  let seen = "";
  let open = 0;
  let openAt = -1;
  for (let consumed = 0; ;) {
    const unit = stream.subarray(consumed, consumed + width);
    consumed += unit.length;
    if (consumed === 256) break;
    const byte = (little ? unit[0] : unit[width - 1]) ?? 0;
    // A Java byte is signed, and casts to a character as such.
    const c = byte >= 0x80 ? byte + 0xff00 : byte;
    seen += String.fromCharCode(c);
    if (
      (seen.length === 1 && c !== 0x40) ||
      c === 0x3b ||
      c === 0x7b ||
      c === 0x7d ||
      (seen.length === 8 && seen !== "@charset")
    ) {
      break;
    }
    if (open === 0 && (c === 0x22 || c === 0x27)) {
      open = c;
      openAt = seen.length;
    } else if (open === c) {
      // An empty name counts as none.
      if (c !== 0 && openAt < seen.length - 1) charset = seen.slice(openAt, -1);
      break;
    } else if (unit.length === 0) break;
  }

  const findings: Array<Collect.Finding> = [];
  const named = (mark?.[0] ?? charset)?.toLowerCase();
  if (named !== undefined && named !== "utf-8") {
    const id = named.startsWith("utf-16") ? "CSS-003" : "CSS-004";
    findings.push({ id, args: [named], path, line: -1, column: -1 });
  }
  return { text: decodeAs(stream, mark?.[0] ?? charset ?? "utf-8"), findings };
};
