import * as Result from "effect/Result";

import type { MessageId } from "../messages/MessageCatalog.ts";
import * as MediaTypes from "../resources/MediaTypes.ts";
import * as Xml from "../xml/Xml.ts";
import * as Url from "./Url.ts";

// Reads the URLs a content document or style sheet points at, as upstream does while it parses
// them: each URL is checked where it appears, and those that point at publication resources are
// collected, with what kind of use each is, for the checks that need the whole publication.

export type ReferenceType =
  | "hyperlink"
  | "image"
  | "stylesheet"
  | "script"
  | "audio"
  | "video"
  | "track"
  | "font"
  | "iframe"
  | "object"
  | "embed"
  // CSS `url()` values outside `@font-face`, and `input` images.
  | "generic"
  | "svg-symbol"
  | "cite"
  // A Search Key Map's link to dictionary content.
  | "search-key"
  // A Media Overlay's link to the content it narrates.
  | "overlay-text";

export interface Finding {
  readonly id: MessageId;
  readonly args: ReadonlyArray<string>;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface Reference {
  readonly type: ReferenceType;
  readonly target: Url.Target;
  readonly fragment: string | undefined;
  // The media type the referencing element declares (a `type` attribute), if any.
  readonly mediaType?: string | undefined;
  // The referencing element's local name.
  readonly element?: string | undefined;
  // Whether the reference needs no manifest fallback: an image in `picture`, an `object` with
  // content, or a media source next to one of a core media type.
  readonly intrinsicFallback?: boolean | undefined;
  // Whether the document loads it as one of its resources, which decides the `remote-resources`
  // and `svg` manifest properties.
  readonly resource: boolean;
  // Where the reference appears: document path and position.
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface Context {
  readonly version: "2" | "3";
  // False for a single document, which has no container to resolve references in.
  readonly container: boolean;
  // The media type of a resource in a publication: its manifest item's, or a data URL's own.
  readonly mediaTypeOf?: ((target: Url.Target) => string | undefined) | undefined;
  // Media Overlays styling classes the package does not declare, with their properties, which a
  // selector using them is reported for (CSS-029).
  readonly undeclaredClasses?: ReadonlyArray<readonly [string, string]> | undefined;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const OPS_NS = "http://www.idpf.org/2007/ops";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

export interface Features {
  readonly scripted: boolean;
  // A JavaScript `script` or an event handler (upstream's HAS_SCRIPTS); forms are only scripted.
  readonly scripts: boolean;
  readonly svg: boolean;
  readonly mathml: boolean;
  readonly switch: boolean;
  readonly remoteResources: boolean;
  // Where the first `epub:type="dictionary"` element is.
  readonly dictionary: { readonly line: number; readonly column: number } | undefined;
  // Content that allows the `index` and `glossary` properties.
  readonly index: boolean;
  readonly glossary: boolean;
  // Whether the document has a style sheet or `style` element (not just `style` attributes).
  readonly styled: boolean;
  // Where each `style` element or attribute whose CSS uses remote resources starts.
  readonly remoteStyles: ReadonlyArray<number>;
}

// HTML's srcset candidates: a URL (which may itself contain commas, as data URLs do), then
// optional descriptors up to the next comma.
export const srcsetUrls = (value: string) => {
  const urls: Array<string> = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index] ?? "")) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index] ?? "")) index++;
    let url = value.slice(start, index);
    // A data URL may be wrapped after its comma; its payload continues on the next line.
    if (url.startsWith("data:") && url.endsWith(",")) {
      while (index < value.length && /\s/.test(value[index] ?? "")) index++;
      const payload = index;
      while (index < value.length && !/\s/.test(value[index] ?? "")) index++;
      url += value.slice(payload, index);
    }
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      let depth = 0;
      while (index < value.length) {
        const char = value[index];
        if (char === "(") depth++;
        else if (char === ")") depth--;
        else if (char === "," && depth <= 0) break;
        index++;
      }
    }
    if (url !== "") urls.push(url);
  }
  return urls;
};

const SCRIPT_TYPES = new Set([
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// Upstream counts only these event handler attributes as scripting.
const EVENT_HANDLERS = new Set(
  (
    "onafterprint onbeforeprint onbeforeunload onerror onhaschange onload onmessage onoffline " +
    "onpagehide onpageshow onpopstate onredo onresize onstorage onundo onunload onblur onchange " +
    "oncontextmenu onfocus onformchange onforminput oninput oninvalid onreset onselect onsubmit " +
    "onkeydown onkeypress onkeyup onabort oncanplay oncanplaythrough ondurationchange onemptied " +
    "onended onloadeddata onloadedmetadata onloadstart onpause onplay onplaying onprogress " +
    "onratechange onreadystatechange onseeked onseeking onstalled onsuspend ontimeupdate " +
    "onvolumechange onwaiting onclick ondblclick ondrag ondragend ondragenter ondragleave " +
    "ondragover ondragstart ondrop onmousedown onmousemove onmouseout onmouseover onmouseup " +
    "onmousewheel onscroll"
  ).split(" "),
);

// A `script` with another type (a module, or a data block) does not make content scripted.
const isScript = (element: Xml.XmlElement) => {
  const type = Xml.attribute(element, "type");
  return type === undefined || SCRIPT_TYPES.has(type.toLowerCase());
};

interface CssUrl {
  readonly url: string;
  readonly kind: "import" | "url";
  readonly fontFace: boolean;
  // The declaration's start, or the URL's own for `@import`.
  readonly line: number;
  readonly column: number;
}

// The URLs of a style sheet or `style` attribute, outside comments and strings, with upstream's
// positions (1-based, relative to the CSS text).
export const cssUrls = (css: string) => {
  const urls: Array<CssUrl> = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const advance = (count = 1) => {
    for (let step = 0; step < count && index < css.length; step++) {
      const char = css[index];
      index++;
      if (char === "\n" || (char === "\r" && css[index] !== "\n")) {
        line++;
        column = 1;
      } else column++;
    }
  };
  // Reads a quoted string at the current position, without its quotes.
  const string = () => {
    const quote = css[index];
    advance();
    let value = "";
    while (index < css.length && css[index] !== quote && css[index] !== "\n") {
      if (css[index] === "\\") {
        value += css.slice(index, index + 2);
        advance(2);
      } else {
        value += css[index];
        advance();
      }
    }
    advance();
    return value;
  };
  // The current statement: where it starts, and its first characters (`@import`, ...).
  let start: { readonly line: number; readonly column: number } | undefined;
  let prelude = "";
  let components = 0;
  // Upstream reads URLs only among a declaration's or rule's top-level values, not inside
  // functions such as `image-set()` or `@supports` conditions.
  let depth = 0;
  const blocks: Array<boolean> = [];
  const reset = () => {
    start = undefined;
    prelude = "";
    components = 0;
    depth = 0;
  };
  const statement = () => /^@[\w-]*/.exec(prelude)?.[0]?.toLowerCase() ?? "";
  const push = (url: string, position: { readonly line: number; readonly column: number }) => {
    const rule = statement();
    components++;
    if (rule === "@namespace") return;
    // `@import` takes a URL only as its first component (not `url (...)`, say).
    if (rule === "@import" && (components > 1 || !/^@import\s*$/i.test(prelude))) return;
    urls.push({
      url,
      kind: rule === "@import" ? "import" : "url",
      fontFace: blocks.at(-1) === true,
      ...(rule === "@import" ? position : (start ?? position)),
    });
  };

  while (index < css.length) {
    const char = css[index] ?? "";
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      advance(end < 0 ? css.length - index : end + 2 - index);
      continue;
    }
    if (/\s/.test(char)) {
      if (start !== undefined && prelude.length < 16) prelude += " ";
      advance();
      continue;
    }
    const position = { line, column };
    start ??= position;
    if (char === '"' || char === "'") {
      const value = string();
      // A string is a URL only as the argument of `@import`.
      if (statement() === "@import") push(value, position);
      else components++;
      continue;
    }
    if (/^url\(/i.test(css.slice(index, index + 4)) && !/[\w-]/.test(css[index - 1] ?? "")) {
      advance(4);
      while (/\s/.test(css[index] ?? "")) advance();
      let url: string;
      if (css[index] === '"' || css[index] === "'") {
        url = string();
        while (index < css.length && css[index] !== ")") advance();
      } else {
        const end = css.indexOf(")", index);
        url = css.slice(index, end < 0 ? css.length : end).trim();
        advance((end < 0 ? css.length : end) - index);
      }
      advance();
      if (depth === 0) push(url, position);
      continue;
    }
    if (char === "{") {
      blocks.push(statement() === "@font-face");
      reset();
    } else if (char === "}") {
      blocks.pop();
      reset();
    } else if (char === ";") reset();
    else {
      if (char === "(") depth++;
      else if (char === ")") depth = Math.max(depth - 1, 0);
      if (prelude.length < 16) prelude += char;
    }
    advance();
  }
  return urls;
};

// The font types `@font-face` may use (CSS-007).
const isFontType = (mediaType: string, version: "2" | "3") =>
  version === "3"
    ? MediaTypes.isCoreFont(mediaType)
    : /^(?:font\/|application\/font|application\/x-font)/.test(mediaType) ||
      mediaType === "application/vnd.ms-opentype";

const BLESSED_IMAGES = new Set([
  "image/gif",
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/avif",
  "image/jxl",
]);

// What a `type` attribute must agree with: the codecs of MP4 and Ogg audio, and no other
// parameters.
const declaredType = (value: string) => {
  const parsed = MediaTypes.parse(value);
  if (parsed === undefined) return "";
  const codecs = parsed.parameters.get("codecs");
  const audio = parsed.essence === "audio/mp4" || parsed.essence === "audio/ogg";
  return MediaTypes.serialize({
    essence: parsed.essence,
    parameters: new Map<string, string>(audio && codecs !== undefined ? [["codecs", codecs]] : []),
  });
};
// Upstream compares parsed types, whose parameters are unordered.
const canonical = (value: string) => {
  const parsed = MediaTypes.parse(value);
  if (parsed === undefined) return "";
  const sorted = [...parsed.parameters].sort(([left], [right]) => (left < right ? -1 : 1));
  return JSON.stringify([parsed.essence, sorted]);
};

// The selectors of a style sheet's rules, outside comments and strings, with their positions
// (1-based, relative to the CSS text). At-rule preludes and declarations are not selectors; the
// rules of conditional group at-rules such as `@media` are.
export const cssSelectors = (css: string) => {
  const selectors: Array<{
    readonly text: string;
    readonly line: number;
    readonly column: number;
  }> = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const advance = () => {
    const char = css[index];
    index++;
    if (char === "\n" || (char === "\r" && css[index] !== "\n")) {
      line++;
      column = 1;
    } else column++;
  };
  // Whether each open block holds rules (the style sheet itself, `@media`, ...) or anything else.
  const blocks: Array<boolean> = [];
  let prelude: Array<{ readonly char: string; readonly line: number; readonly column: number }> =
    [];
  const holdsRules = () => blocks.at(-1) ?? true;
  while (index < css.length) {
    const char = css[index] ?? "";
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      const length = (end < 0 ? css.length : end + 2) - index;
      for (let step = 0; step < length; step++) advance();
      prelude.push({ char: " ", line, column });
      continue;
    }
    if (char === '"' || char === "'") {
      prelude.push({ char: '""', line, column });
      advance();
      while (index < css.length && css[index] !== char && css[index] !== "\n") {
        if (css[index] === "\\") advance();
        advance();
      }
      advance();
      continue;
    }
    if (char === "{") {
      const text = prelude.map((each) => each.char).join("");
      const rules = holdsRules();
      if (rules && !text.trimStart().startsWith("@")) {
        // A selector list: each selector starts at its first character after a top-level comma.
        let depth = 0;
        let begin = 0;
        const flush = (until: number) => {
          const part = prelude.slice(begin, until);
          const first = part.findIndex((each) => !/\s/.test(each.char));
          const at = part[first];
          if (at !== undefined) {
            const text = part
              .slice(first)
              .map((each) => each.char)
              .join("");
            selectors.push({ text, line: at.line, column: at.column });
          }
        };
        prelude.forEach((each, position) => {
          if (each.char === "(" || each.char === "[") depth++;
          else if (each.char === ")" || each.char === "]") depth--;
          else if (each.char === "," && depth === 0) {
            flush(position);
            begin = position + 1;
          }
        });
        flush(prelude.length);
      }
      const name = /^\s*@(-?[\w-]+)/.exec(text)?.[1]?.toLowerCase() ?? "";
      blocks.push(
        rules && /^(?:-\w+-)?(?:media|supports|document|layer|container|scope)$/.test(name),
      );
      prelude = [];
      advance();
      continue;
    }
    if (char === "}" || (char === ";" && holdsRules())) {
      if (char === "}") blocks.pop();
      prelude = [];
      advance();
      continue;
    }
    if (holdsRules()) prelude.push({ char, line, column });
    advance();
  }
  return selectors;
};

// Upstream's findClassName: a class of the selector itself, not one inside a pseudo-class's
// arguments or an attribute selector, compared once unescaped.
const usesClass = (selector: string, name: string) => {
  let depth = 0;
  let top = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth = Math.max(depth - 1, 0);
    else if (depth === 0) top += char;
  }
  const classes = top.matchAll(
    /\.((?:[\w-]|[^\x00-\x7f]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\n0-9a-fA-F]))+)/g,
  );
  return [...classes].some(
    ([, ident = ""]) =>
      ident.replace(
        /\\(?:([0-9a-fA-F]{1,6})\s?|(.))/g,
        (_, hex: string | undefined, char: string) =>
          hex === undefined ? char : String.fromCodePoint(Number.parseInt(hex, 16)),
      ) === name,
  );
};

// A style sheet, or the CSS of a `style` element or attribute (`offset` lines into its document).
export const fromCss = (css: string, path: string, context: Context, offset = 0) => {
  const references: Array<Reference> = [];
  const findings: Array<Finding> = [];
  const checker = Url.checker(path, context);
  let remote = false;
  for (const found of cssUrls(css)) {
    // Fragment-only URLs would point into the document using the style sheet; upstream skips them.
    if (found.url.trim() === "" || found.url.startsWith("#")) continue;
    const line = offset + found.line;
    const { problems, resolved } = checker.check(found.url);
    for (const problem of problems) {
      findings.push({ ...problem, path, line, column: found.column });
    }
    if (resolved === undefined) continue;
    const type = found.kind === "import" ? "stylesheet" : found.fontFace ? "font" : "generic";
    // A remote style sheet is reported anyway (RSC-006); it does not need the property.
    if (type !== "stylesheet" && resolved.target.kind === "remote") remote = true;
    // Upstream looks the font up with its fragment, so a font with one is never checked.
    const mediaType =
      type === "font" && resolved.fragment === undefined
        ? context.mediaTypeOf?.(resolved.target)
        : undefined;
    if (mediaType !== undefined && !isFontType(mediaType, context.version)) {
      findings.push({
        id: "CSS-007",
        args: [Url.nameOf(resolved.target), mediaType],
        path,
        line,
        column: found.column,
      });
    }
    references.push({ ...resolved, type, resource: false, path, line, column: found.column });
  }
  const undeclared = context.undeclaredClasses ?? [];
  for (const selector of undeclared.length === 0 ? [] : cssSelectors(css)) {
    for (const [name, property] of undeclared) {
      if (!usesClass(selector.text, name)) continue;
      const at = { line: offset + selector.line, column: selector.column };
      findings.push({ id: "CSS-029", args: [name, property], path, ...at });
    }
  }
  return { references, findings, remote };
};

// Where a quoted string that starts at `start` ends, past its closing quote.
const stringEnd = (text: string, start: number) => {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote && text[index] !== "\n") {
    index += text[index] === "\\" ? 2 : 1;
  }
  return Math.min(index + 1, text.length);
};

// The text of the block that starts at `start`, up to its closing brace.
const blockAt = (text: string, start: number) => {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") index = stringEnd(text, index) - 1;
    else if (char === "{") depth++;
    else if (char === "}" && depth-- === 0) return text.slice(start, index);
  }
  return text.slice(start);
};

// `text` split at `separator` outside strings and parentheses.
const splitOutside = (text: string, separator: string) => {
  const parts: Array<string> = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") index = stringEnd(text, index) - 1;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
};

// A value's first component, as written: a string with its quotes, or a word.
const firstComponent = (value: string | undefined) => {
  if (value === undefined || value === "") return undefined;
  if (value.startsWith('"') || value.startsWith("'")) return value.slice(0, stringEnd(value, 0));
  return /^[^\s,]+/.exec(value)?.[0];
};

// The `@font-face` rules of a style sheet, as upstream's CSS handler reads them: the first
// component of `font-family`, `font-style` and `font-weight` as written, and the URLs of `src`.
export const fontFaces = (css: string) => {
  // Comments go, strings stay; positions no longer matter.
  let text = "";
  for (let index = 0; index < css.length;) {
    const char = css[index] ?? "";
    if (char === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      index = close < 0 ? css.length : close + 2;
    } else if (char === '"' || char === "'") {
      const end = stringEnd(css, index);
      text += css.slice(index, end);
      index = end;
    } else {
      text += char;
      index++;
    }
  }
  return [...text.matchAll(/@font-face\s*\{/gi)].map((match) => {
    const body = blockAt(text, match.index + match[0].length);
    const declarations = new Map<string, string>();
    for (const declaration of splitOutside(body, ";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      declarations.set(
        name,
        declaration
          .slice(colon + 1)
          .replace(/!\s*important\s*$/i, "")
          .trim(),
      );
    }
    const src = declarations.get("src") ?? "";
    return {
      family: firstComponent(declarations.get("font-family")),
      style: firstComponent(declarations.get("font-style")),
      weight: firstComponent(declarations.get("font-weight")),
      urls: [...src.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)].map(
        (url) => url[1] ?? url[2] ?? url[3] ?? "",
      ),
    };
  });
};

// The URLs an SVG element links to: `xlink:href` in EPUB 2, and `href` too in EPUB 3.
const svgHrefs = (element: Xml.XmlElement, epub3: boolean) => {
  const xlink = Xml.attribute(element, "href", XLINK_NS);
  if (!epub3) return xlink === undefined ? [] : [xlink];
  const href = Xml.attribute(element, "href");
  if (href === undefined) return xlink === undefined ? [] : [xlink];
  return xlink === undefined || xlink === href ? [href] : [href, xlink];
};

// References, URL findings and features of an XHTML or SVG content document.
export const fromDocument = (document: Xml.XmlDocument, path: string, context: Context) => {
  const references: Array<Reference> = [];
  const findings: Array<Finding> = [];
  const urls = Url.checker(path, context);
  const epub3 = context.version === "3";
  const isSvgDocument = document.root.ns === SVG_NS;
  // Upstream lowercases `type`, a case-insensitive attribute, on XHTML elements in EPUB 3 XHTML.
  const typeAttribute = (element: Xml.XmlElement) => {
    const value = Xml.attribute(element, "type");
    return epub3 && !isSvgDocument && element.ns === XHTML_NS ? value?.toLowerCase() : value;
  };
  let scripted = false;
  let scripts = false;
  let svg = false;
  let mathml = false;
  let hasSwitch = false;
  let remoteResources = false;
  let dictionary: Features["dictionary"];
  let index = false;
  let glossary = false;
  let styled = false;
  const remoteStyles: Array<number> = [];

  interface Position {
    readonly line: number;
    readonly column: number;
  }
  // Upstream locates most references at the start tag, and some at the end tag.
  const start = (element: Xml.XmlElement) => ({ line: element.line, column: element.column });
  const end = (element: Xml.XmlElement) => ({ line: element.endLine, column: element.endColumn });
  const check = (url: string | undefined, at: Position) => {
    if (url === undefined) return undefined;
    const { problems, resolved } = urls.check(url);
    for (const problem of problems) findings.push({ ...problem, path, ...at });
    return resolved;
  };
  const register = (
    resolved: Url.Resolved | undefined,
    type: ReferenceType,
    element: Xml.XmlElement,
    at: Position,
    options: { readonly resource?: boolean; readonly intrinsicFallback?: boolean } = {},
  ) => {
    if (resolved === undefined) return;
    const mediaType = typeAttribute(element)?.trim();
    const { resource = false, intrinsicFallback = false } = options;
    references.push({
      ...resolved,
      type,
      mediaType,
      element: element.local,
      resource,
      intrinsicFallback,
      path,
      ...at,
    });
  };
  const mediaTypeOf = (resolved: Url.Resolved | undefined) =>
    resolved === undefined ? undefined : context.mediaTypeOf?.(resolved.target);
  // An element's `type` must agree with the manifest (OPF-013); what applies is the declared type
  // if there is one.
  const typeOf = (
    resolved: Url.Resolved | undefined,
    declared: string | undefined,
    at: Position,
  ) => {
    const actual = mediaTypeOf(resolved);
    if (declared === undefined || actual === undefined || resolved === undefined) return actual;
    const expected = declaredType(declared);
    if (canonical(expected) !== canonical(actual)) {
      const args = [Url.nameOf(resolved.target), declared, actual];
      findings.push({ id: "OPF-013", args, path, ...at });
    }
    return expected;
  };
  let inPicture = false;
  // Upstream's checks of `picture` images: `img` must be a core image type, and `source` too
  // unless it declares its type. Only manifest items are checked, not data URLs.
  const pictureImage = (element: Xml.XmlElement, resolved: Url.Resolved | undefined) => {
    const actual = mediaTypeOf(resolved);
    if (!inPicture || actual === undefined || resolved === undefined) return;
    if (resolved.target.kind === "data") return;
    const args = [Url.nameOf(resolved.target), actual];
    const type = (typeAttribute(element) ?? "").trim();
    if (element.local === "img") {
      if (!BLESSED_IMAGES.has(actual))
        findings.push({ id: "MED-003", args, path, ...start(element) });
    } else if (type === "") {
      if (!BLESSED_IMAGES.has(actual))
        findings.push({ id: "MED-007", args, path, ...start(element) });
    } else typeOf(resolved, type, start(element));
  };
  const images = (element: Xml.XmlElement) => {
    // Upstream checks an image's `src` and `srcset` URLs once each, in sorted order.
    const src = Xml.attribute(element, "src");
    const sources = new Set(srcsetUrls(Xml.attribute(element, "srcset") ?? ""));
    if (src !== undefined) sources.add(src);
    for (const url of [...sources].sort()) {
      const resolved = resource(url, start(element));
      pictureImage(element, resolved);
      register(resolved, "image", element, start(element), {
        resource: true,
        intrinsicFallback: inPicture,
      });
    }
  };
  // Audio and video references take their type from the resource: audio played by a `video`
  // element is audio.
  const media = (
    element: Xml.XmlElement,
    resolved: Url.Resolved | undefined,
    mediaType: string | undefined,
    at: Position,
    intrinsicFallback: boolean,
  ) => {
    const type = mediaType !== undefined && MediaTypes.isAudio(mediaType) ? "audio" : "video";
    register(resolved, type, element, at, { resource: true, intrinsicFallback });
  };
  // Upstream's resource URLs: blank ones are ignored, and remote ones need `remote-resources`.
  const resource = (url: string | undefined, at: Position) => {
    if (url === undefined || url.trim() === "") return undefined;
    const resolved = check(url, at);
    if (resolved?.target.kind === "remote") remoteResources = true;
    return resolved;
  };
  const addResource = (element: Xml.XmlElement, url: string | undefined, type: ReferenceType) =>
    register(resource(url, start(element)), type, element, start(element), { resource: true });
  const hyperlink = (element: Xml.XmlElement, href: string | undefined) => {
    if (href === undefined) return;
    const trimmed = href.trim();
    if (trimmed === "") {
      findings.push({ id: "HTM-045", args: [], path, ...start(element) });
      return;
    }
    if (trimmed === ".") return;
    const resolved = check(trimmed, start(element));
    // Remote hyperlinks are not publication resources.
    if (resolved === undefined || resolved.target.kind === "remote") return;
    register(resolved, "hyperlink", element, start(element));
    if (epub3 && resolved.target.kind === "data") {
      findings.push({ id: "RSC-029", args: [], path, ...start(element) });
    }
  };
  const css = (text: string, line: number) => {
    const offset = Math.max(line - 1, 0);
    const found = fromCss(text, path, context, offset);
    references.push(...found.references);
    findings.push(...found.findings);
    if (found.remote) remoteStyles.push(offset);
  };
  // The sources of an `audio` or `video` element, registered at its end tag, once each.
  const mediaSources = new Map<
    Xml.XmlElement,
    Map<string, { readonly resolved: Url.Resolved; readonly mediaType: string | undefined }>
  >();
  // Whether an element has content other than whitespace, for `object` fallbacks.
  const palpable = new Map<Xml.XmlElement, boolean>();

  const enter = (element: Xml.XmlElement, parent: Xml.XmlElement | undefined) => {
    const base =
      element.ns === XHTML_NS && element.local === "base"
        ? Xml.attribute(element, "href")
        : Xml.attribute(element, "base", XML_NS);
    if (base !== undefined) {
      for (const problem of urls.setBase(base)) {
        findings.push({ ...problem, path, ...start(element) });
      }
    }
    if (element.ns === XHTML_NS) {
      switch (element.local) {
        case "a":
        case "area":
          hyperlink(element, Xml.attribute(element, "href"));
          break;
        case "img": {
          if (!epub3) {
            register(
              check(Xml.attribute(element, "src"), start(element)),
              "image",
              element,
              start(element),
            );
            break;
          }
          images(element);
          break;
        }
        case "object":
          if (!epub3) {
            register(
              check(Xml.attribute(element, "data"), start(element)),
              "object",
              element,
              start(element),
            );
          }
          break;
        case "link": {
          const resolved = check(Xml.attribute(element, "href"), start(element));
          // Other links (icons, alternates, ...) are not publication resources.
          const rel = Xml.attribute(element, "rel")?.toLowerCase();
          if (rel?.includes("stylesheet") === true) {
            register(resolved, "stylesheet", element, start(element));
          }
          break;
        }
        case "script":
          if (isScript(element)) scripted = scripts = true;
          if (epub3) addResource(element, Xml.attribute(element, "src"), "script");
          break;
        case "style":
          // Upstream counts a `style` element as CSS only when it has text.
          if (Xml.textContent(element).length > 0) styled = true;
          css(Xml.textContent(element), element.line);
          break;
        default:
          break;
      }
      if (epub3) {
        switch (element.local) {
          case "form":
            scripted = true;
            break;
          case "audio":
          case "video": {
            if (element.local === "video") {
              addResource(element, Xml.attribute(element, "poster"), "image");
            }
            mediaSources.set(element, new Map());
            const resolved = resource(Xml.attribute(element, "src"), start(element));
            media(element, resolved, mediaTypeOf(resolved), start(element), false);
            break;
          }
          case "picture":
            inPicture = true;
            break;
          case "track":
            addResource(element, Xml.attribute(element, "src"), "track");
            break;
          case "input":
            addResource(element, Xml.attribute(element, "src"), "generic");
            break;
          case "iframe":
            addResource(element, Xml.attribute(element, "src"), "iframe");
            break;
          case "embed": {
            const resolved = resource(Xml.attribute(element, "src"), start(element));
            typeOf(resolved, typeAttribute(element), start(element));
            register(resolved, "embed", element, start(element), { resource: true });
            break;
          }
          case "source": {
            if (parent?.local === "picture") {
              images(element);
              break;
            }
            const sources = parent === undefined ? undefined : mediaSources.get(parent);
            if (sources === undefined) break;
            const src = Xml.attribute(element, "src");
            const resolved = resource(src, start(element));
            const mediaType = typeOf(resolved, typeAttribute(element), start(element));
            if (context.container && src !== undefined && resolved !== undefined) {
              sources.set(src, { resolved, mediaType });
            }
            break;
          }
          case "blockquote":
          case "q":
          case "ins":
          case "del":
            register(
              check(Xml.attribute(element, "cite"), start(element)),
              "cite",
              element,
              start(element),
            );
            break;
          default:
            break;
        }
      }
      const style = Xml.attribute(element, "style");
      if (style !== undefined && style !== "") css(style, element.line);
    } else if (element.ns === SVG_NS) {
      switch (element.local) {
        case "svg":
          if (!isSvgDocument) svg = true;
          break;
        case "a":
          for (const href of svgHrefs(element, epub3)) hyperlink(element, href);
          break;
        case "image":
          for (const href of svgHrefs(element, epub3)) {
            register(check(href, start(element)), "image", element, start(element));
          }
          break;
        case "use":
          for (const href of svgHrefs(element, epub3)) {
            register(check(href, start(element)), "svg-symbol", element, start(element));
          }
          break;
        case "font-face-uri":
          for (const href of svgHrefs(element, epub3)) {
            const resolved = check(href, start(element));
            if (epub3 && resolved?.target.kind === "remote") remoteResources = true;
            register(resolved, "font", element, start(element));
          }
          break;
        case "script":
          if (isScript(element)) scripted = scripts = true;
          // Upstream reads `src`, which SVG scripts do not have, so their `href` is not checked.
          if (epub3) addResource(element, Xml.attribute(element, "src"), "script");
          break;
        case "style":
          // Upstream counts a `style` element as CSS only when it has text.
          if (Xml.textContent(element).length > 0) styled = true;
          css(Xml.textContent(element), element.line);
          break;
        default:
          break;
      }
    } else if (element.ns === MATHML_NS && element.local === "math" && epub3) {
      mathml = true;
      register(
        check(Xml.attribute(element, "altimg"), start(element)),
        "image",
        element,
        start(element),
      );
    } else if (element.ns === OPS_NS && element.local === "switch") {
      hasSwitch = true;
    }
    if (epub3) {
      if (element.attributes.some((attribute) => EVENT_HANDLERS.has(attribute.local.toLowerCase())))
        scripted = scripts = true;
      const types = (Xml.attribute(element, "type", OPS_NS) ?? "").split(/\s+/);
      if (types.includes("dictionary")) dictionary ??= start(element);
      if (types.includes("index")) index = true;
      if (types.includes("glossary")) glossary = true;
    }
  };

  const exit = (element: Xml.XmlElement) => {
    palpable.set(
      element,
      element.children.some((child) =>
        child.kind === "text" ? child.text.trim() !== "" : isPalpable(child, palpable),
      ),
    );
    if (element.ns !== XHTML_NS || !epub3) return;
    if (element.local === "picture") inPicture = false;
    if (element.local === "object") {
      const at = end(element);
      const resolved = resource(Xml.attribute(element, "data"), at);
      typeOf(resolved, typeAttribute(element), at);
      register(resolved, "object", element, at, {
        resource: true,
        intrinsicFallback: palpable.get(element) === true,
      });
    }
    const sources = mediaSources.get(element);
    if (sources === undefined) return;
    // A source of a core media type is a fallback for the others.
    const fallback = [...sources.values()].some(
      ({ mediaType }) => mediaType !== undefined && MediaTypes.isCore(mediaType),
    );
    for (const { resolved, mediaType } of sources.values()) {
      media(element, resolved, mediaType, end(element), fallback);
    }
  };

  // `<?xml-stylesheet href="..."?>` links a style sheet to an SVG document. Saxon's
  // ProcInstParser reads the pseudo-attributes as an element's attributes, so any XML error voids
  // the whole declaration.
  for (const instruction of isSvgDocument ? document.processingInstructions : []) {
    if (instruction.target !== "xml-stylesheet") continue;
    const parsed = Xml.parse(`<e ${instruction.body}/>`);
    if (Result.isFailure(parsed)) continue;
    const type = Xml.attribute(parsed.success.root, "type");
    if (type !== undefined && type.toLowerCase() !== "text/css") continue;
    const at = { line: instruction.line, column: instruction.column };
    const href = Xml.attribute(parsed.success.root, "href");
    const resolved = href === undefined ? undefined : check(href, at);
    if (resolved !== undefined) {
      references.push({ ...resolved, type: "stylesheet", resource: false, path, ...at });
    }
  }

  // Iterative, with end tags: documents can nest deeper than the call stack allows.
  const stack: Array<readonly [Xml.XmlElement, Xml.XmlElement | undefined, boolean]> = [
    [document.root, undefined, false],
  ];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const [element, parent, closing] = next;
    if (closing) {
      exit(element);
      continue;
    }
    enter(element, parent);
    stack.push([element, parent, true]);
    for (const child of Xml.childElements(element).reverse()) stack.push([child, element, false]);
  }

  const features: Features = {
    scripted,
    scripts,
    svg,
    mathml,
    switch: hasSwitch,
    remoteResources,
    dictionary,
    index,
    glossary,
    styled: styled || references.some((reference) => reference.type === "stylesheet"),
    remoteStyles,
  };
  return { references, findings, features };
};

// A Search Key Map Document links search key groups and matches to dictionary content.
export const fromSearchKeyMap = (document: Xml.XmlDocument, path: string, context: Context) => {
  const references: Array<Reference> = [];
  const findings: Array<Finding> = [];
  const urls = Url.checker(path, context);
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const href = Xml.attribute(element, "href");
    if (element.ns !== OPS_NS || href === undefined) continue;
    if (element.local !== "search-key-group" && element.local !== "match") continue;
    const at = { path, line: element.line, column: element.column };
    const { problems, resolved } = urls.check(href);
    for (const problem of problems) findings.push({ ...problem, ...at });
    if (resolved !== undefined) {
      references.push({ ...resolved, type: "search-key", resource: false, ...at });
    }
  }
  return { references, findings };
};

// Upstream's palpable content: embedded content, text, and elements that contain either.
const isPalpable = (element: Xml.XmlElement, palpable: ReadonlyMap<Xml.XmlElement, boolean>) => {
  if (Xml.attribute(element, "hidden") !== undefined) return false;
  if (element.ns === SVG_NS) return element.local === "svg";
  if (element.ns === MATHML_NS) return element.local === "math";
  if (element.ns !== XHTML_NS) return false;
  if (EMBEDDED.has(element.local)) return true;
  if (NOT_PALPABLE.has(element.local)) return false;
  return palpable.get(element) === true;
};
const EMBEDDED = new Set([
  "audio",
  "canvas",
  "embed",
  "iframe",
  "img",
  "object",
  "picture",
  "video",
]);
const NOT_PALPABLE = new Set(["html", "head", "script", "link", "meta", "title", "style"]);

// Each ID's position in document order.
export const idPositions = (document: Xml.XmlDocument) => {
  const positions = new Map<string, number>();
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const id =
      Xml.attribute(element, "id") ??
      Xml.attribute(element, "id", "http://www.w3.org/XML/1998/namespace");
    if (id !== undefined && !positions.has(id.trim())) positions.set(id.trim(), positions.size);
  }
  return positions;
};

// The IDs a fragment can point to.
export const ids = (document: Xml.XmlDocument) => {
  const found = new Set<string>();
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const id = Xml.attribute(element, "id");
    if (id !== undefined) found.add(id.trim());
  }
  return found;
};
