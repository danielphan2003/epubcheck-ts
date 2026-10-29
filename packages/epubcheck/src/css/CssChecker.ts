import { formatMessage, type MessageId } from "../messages/MessageCatalog.ts";
import type { Finding } from "../references/Collect.ts";
import * as Xml from "../xml/Xml.ts";
import { bundles } from "./strings.generated.ts";

// EPUB style sheet rules: the syntax errors upstream's CSS parser reports (CSS-008, worded from
// its bundles), forbidden properties, `@font-face` declarations, prefixed `-epub-` properties,
// and the encoding of style sheet files.

interface Token {
  readonly kind:
    | "ident"
    | "at"
    | "string"
    | "url"
    | "function"
    | "delim"
    | "space"
    | "{"
    | "}"
    | "("
    | ")"
    | "["
    | "]"
    | ":"
    | ";"
    | ",";
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

const NAME_CHAR = /[\w\u00a0-\uffff-]/;
const NAME_START = /[a-zA-Z_\u00a0-\uffff]/;

const PUNCTUATION: Readonly<Record<string, Token["kind"]>> = {
  "{": "{",
  "}": "}",
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  ":": ":",
  ";": ";",
  ",": ",",
};

const tokenize = (css: string) => {
  const tokens: Array<Token> = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const advance = (count: number) => {
    for (let step = 0; step < count && index < css.length; step++) {
      if (css[index] === "\n") {
        line++;
        column = 1;
      } else column++;
      index++;
    }
  };
  const readName = (from: number) => {
    let end = from;
    while (end < css.length) {
      if (css[end] === "\\") end += 2;
      else if (NAME_CHAR.test(css[end] ?? "")) end++;
      else break;
    }
    return end;
  };
  const isNameStart = (at: number) =>
    NAME_START.test(css[at] ?? "") ||
    css[at] === "\\" ||
    (css[at] === "-" && (NAME_START.test(css[at + 1] ?? "") || css[at + 1] === "-"));
  while (index < css.length) {
    const start = { line, column };
    const char = css[index] ?? "";
    let end = index + 1;
    let kind: Token["kind"] = "delim";
    if (css.startsWith("/*", index)) {
      const close = css.indexOf("*/", index + 2);
      advance((close < 0 ? css.length : close + 2) - index);
      continue;
    }
    if (/\s/.test(char)) {
      while (end < css.length && /\s/.test(css[end] ?? "")) end++;
      kind = "space";
    } else if (char === '"' || char === "'") {
      while (end < css.length && css[end] !== char && css[end] !== "\n")
        end += css[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, css.length);
      kind = "string";
    } else if (char === "@" && isNameStart(index + 1)) {
      end = readName(index + 1);
      kind = "at";
    } else if (
      (char === "." || char === "#") &&
      (isNameStart(index + 1) || NAME_CHAR.test(css[index + 1] ?? ""))
    ) {
      // Upstream's scanner reads class names and hashes as single tokens.
      end = readName(index + 1);
      kind = "delim";
    } else if (isNameStart(index)) {
      end = readName(index);
      kind = "ident";
      if (css[end] === "(") {
        if (/^url$/i.test(css.slice(index, end))) {
          let close = end + 1;
          let quote: string | undefined;
          while (close < css.length && (quote !== undefined || css[close] !== ")")) {
            const current = css[close] ?? "";
            if (quote === undefined && (current === '"' || current === "'")) quote = current;
            else if (current === quote) quote = undefined;
            close += current === "\\" ? 2 : 1;
          }
          end = Math.min(close + 1, css.length);
          kind = "url";
        } else {
          end++;
          kind = "function";
        }
      }
    } else kind = PUNCTUATION[char] ?? "delim";
    const text = css.slice(index, end);
    advance(end - index);
    tokens.push({
      kind,
      text,
      line: start.line,
      column: start.column,
      endLine: line,
      endColumn: column,
    });
  }
  return tokens;
};

// Java's MessageFormat: `{n}` arguments, and quotes that make text literal (`''` is a quote).
const messageFormat = (pattern: string, args: ReadonlyArray<string>) => {
  let result = "";
  let quoted = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    if (char === "'") {
      if (pattern[index + 1] === "'") {
        result += "'";
        index++;
      } else quoted = !quoted;
    } else if (char === "{" && !quoted) {
      const close = pattern.indexOf("}", index);
      const argument = args[Number(pattern.slice(index + 1, close))];
      result += argument ?? pattern.slice(index, close + 1);
      index = close;
    } else result += char;
  }
  return result;
};

const text = (locale: string | undefined, key: string, ...args: ReadonlyArray<string>) => {
  const candidates = [locale, locale?.split(/[-_]/)[0], "default"].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  for (const candidate of candidates) {
    const pattern = bundles[candidate]?.[key];
    if (pattern !== undefined) return messageFormat(pattern, args);
  }
  return key;
};

export interface Origin {
  readonly path: string;
  // Where the style sheet text starts in its document; style sheet files start at 1:1.
  readonly line: number;
  readonly column: number;
}

const FORBIDDEN = new Set(["direction", "unicode-bidi"]);
const NESTED_RULES = new Set([
  "media",
  "supports",
  "document",
  "-moz-document",
  "layer",
  "container",
  "scope",
]);
const DECLARATION_RULES = new Set([
  "font-face",
  "page",
  "viewport",
  "-ms-viewport",
  "counter-style",
]);

// `inline` parses a `style` attribute: a declaration list without braces.
const parse = (css: string, origin: Origin, locale: string | undefined, inline: boolean) => {
  const findings: Array<Finding> = [];
  const position = (line: number, column: number) =>
    line === 1
      ? { line: origin.line, column: origin.column + column - 1 }
      : { line: origin.line + line - 1, column };
  const report = (
    at: { readonly line: number; readonly column: number },
    id: MessageId,
    ...args: ReadonlyArray<string>
  ) => findings.push({ id, args, path: origin.path, ...position(at.line, at.column) });
  const syntaxError = (at: { readonly line: number; readonly column: number }, detail: string) =>
    report(at, "CSS-008", formatMessage("CSS-008", [detail], locale));

  const tokens = tokenize(css).filter((token) => token.kind !== "space");
  let index = 0;
  const peek = () => tokens[index];
  const last = () => tokens[index - 1];
  const endOfInput = () => {
    const previous = last();
    return previous === undefined
      ? { line: 1, column: 1 }
      : { line: previous.endLine, column: previous.endColumn };
  };
  // Upstream recovers from an error in a block by skipping to the next `}`, nesting aside.
  const skipToBlockEnd = () => {
    while (index < tokens.length && peek()?.kind !== "}") index++;
    index++;
  };
  const or = text(locale, "or");

  const declarations = (inFontFace: boolean, rule: Token | undefined) => {
    let count = 0;
    for (;;) {
      const token = peek();
      if (token === undefined) {
        if (!inline) {
          syntaxError(endOfInput(), text(locale, "css.grammar.prematureEOF", `';' ${or} '}'`));
        }
        return;
      }
      index++;
      if (token.kind === "}") break;
      if (token.kind === ";") continue;
      if (token.kind !== "ident") {
        syntaxError(
          token,
          text(locale, "css.grammar.token.expecting", token.text, text(locale, "a_property_name")),
        );
        skipToBlockEnd();
        return;
      }
      const colon = peek();
      if (colon === undefined) {
        syntaxError(token, text(locale, "css.grammar.prematureEOF", ":"));
        return;
      }
      if (colon.kind !== ":") {
        syntaxError(token, text(locale, "css.grammar.token.expecting", colon.text, ":"));
        skipToBlockEnd();
        return;
      }
      index++;
      const value: Array<Token> = [];
      let depth = 0;
      while (peek() !== undefined) {
        const next = peek();
        if (next === undefined) break;
        if (depth === 0 && (next.kind === ";" || next.kind === "}")) break;
        if (next.kind === "(" || next.kind === "function" || next.kind === "[") depth++;
        if (next.kind === ")" || next.kind === "]") depth = Math.max(0, depth - 1);
        value.push(next);
        index++;
      }
      count++;
      declaration(token, value, inFontFace);
    }
    if (inFontFace && count === 0 && rule !== undefined) report(rule, "CSS-019");
  };

  const declaration = (name: Token, value: ReadonlyArray<Token>, inFontFace: boolean) => {
    const property = name.text.toLowerCase();
    if (FORBIDDEN.has(property)) report(name, "CSS-001", name.text);
    if (property.startsWith("-epub-")) report(name, "OBS-001", "css-prefixed-property", name.text);
    for (const token of value) {
      if (token.kind === "ident" && token.text.toLowerCase().startsWith("-epub-")) {
        report(name, "OBS-001", "css-prefixed-value", token.text);
      }
    }
    if (inFontFace) {
      report(name, "CSS-028");
      const empty = value.some(
        (token) => token.kind === "url" && /^url\(\s*(?:""|''|)\s*\)$/i.test(token.text),
      );
      if (property === "src" && empty) report(name, "CSS-002");
    }
  };

  const rules = (nested: boolean) => {
    while (index < tokens.length) {
      const token = peek();
      if (token === undefined) return;
      if (token.kind === "}" && nested) {
        index++;
        return;
      }
      if (token.kind === "at") {
        index++;
        const name = token.text.slice(1).toLowerCase();
        while (peek() !== undefined && peek()?.kind !== ";" && peek()?.kind !== "{") index++;
        const end = peek();
        if (end === undefined) return;
        index++;
        if (end.kind === ";") continue;
        if (NESTED_RULES.has(name)) rules(true);
        else if (DECLARATION_RULES.has(name)) declarations(name === "font-face", token);
        else skipBalanced();
        continue;
      }
      // A qualified rule: a selector, then a declaration block.
      while (peek() !== undefined && peek()?.kind !== "{") index++;
      if (peek() === undefined) return;
      index++;
      declarations(false, undefined);
    }
  };
  const skipBalanced = () => {
    let depth = 1;
    while (index < tokens.length && depth > 0) {
      const token = peek();
      if (token?.kind === "{") depth++;
      if (token?.kind === "}") depth--;
      index++;
    }
  };
  if (inline) declarations(false, undefined);
  else rules(false);
  return findings;
};

export const check = (css: string, origin: Origin, locale: string | undefined) =>
  parse(css, origin, locale, false);

export const checkStyleAttribute = (css: string, origin: Origin, locale: string | undefined) =>
  parse(css, origin, locale, true);

// A style sheet file's encoding: UTF-8 is expected, UTF-16 tolerated (CSS-003, CSS-004).
export const encodingFindings = (bytes: Uint8Array, path: string) => {
  const [b0, b1] = bytes;
  const at = { path, line: -1, column: -1 };
  if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0xff && b1 === 0xfe)) {
    return [{ id: "CSS-003" as const, args: [], ...at }];
  }
  const charset = /^@charset\s+"([^"]*)"/i.exec(
    new TextDecoder("latin1").decode(bytes.subarray(0, 100)),
  )?.[1];
  const declared = charset?.toLowerCase();
  if (declared === undefined || declared === "utf-8") return [];
  if (declared.startsWith("utf-16")) return [{ id: "CSS-003" as const, args: [], ...at }];
  return [{ id: "CSS-004" as const, args: [declared], ...at }];
};

// A style sheet file's text, decoded by its byte order mark.
export const decode = (bytes: Uint8Array) => {
  const [b0, b1] = bytes;
  if (b0 === 0xfe && b1 === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (b0 === 0xff && b1 === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  return new TextDecoder().decode(bytes);
};

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// The style sheets of an XHTML or SVG document: `style` elements and `style` attributes.
export const checkDocument = (
  document: Xml.XmlDocument,
  path: string,
  locale: string | undefined,
) =>
  [document.root, ...Xml.descendants(document.root)].flatMap((element) => {
    const findings: Array<Finding> = [];
    if ((element.ns === XHTML_NS || element.ns === SVG_NS) && element.local === "style") {
      findings.push(
        ...check(
          Xml.textContent(element),
          { path, line: element.line, column: element.column },
          locale,
        ),
      );
    }
    const style = Xml.attribute(element, "style");
    if (style !== undefined) {
      findings.push(...checkStyleAttribute(style, { path, line: element.line, column: 1 }, locale));
    }
    return findings;
  });
