import { lookupIn } from "../messages/MessageCatalog.ts";
import { trimBy } from "../util/JavaText.ts";
import { bundles } from "./strings.generated.ts";

// Upstream's CSS scanner and parser, as EPUBCheck reads style sheets: the tokens it sees, the
// errors it reports and where, how it recovers from them, and the rules and declarations it
// hands to its CSS handler. Its quirks are kept, since its errors are reported verbatim.

const TAB = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const BACKSLASH = 0x5c;

export const isWhitespace = (c: number) =>
  c === 0x20 || c === TAB || c === LF || c === CR || c === FF;
const isNameStart = (c: number) =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c >= 0x80;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isNameChar = (c: number) => isNameStart(c) || isDigit(c) || c === 0x2d;
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
export const isQuote = (c: number) => c === 0x22 || c === 0x27;
const isQuantityStart = (c: number) => isNameStart(c) || c === 0x25;
const isNumberChar = (c: number) => isDigit(c) || c === 0x2e;
const isUnary = (c: number) => c === 0x2b || c === 0x2d;
const isRangeStart = (c: number) => isHex(c) || c === 0x3f;
const isRangeChar = (c: number) => isRangeStart(c) || c === 0x2d;
const isTerminator = (c: number) => c === 0x3b || c === 0x7d || c === 0x7b;

const lowerAscii = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
const asciiLowerCase = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const sameAscii = (chars: ReadonlyArray<number>, text: string) =>
  chars.length === text.length &&
  chars.every((c, index) => c !== -1 && lowerAscii(c) === text.charCodeAt(index));
const char = (c: number) => String.fromCharCode(c & 0xffff);

export type TokenKind =
  | "space"
  | "comment"
  | "cdo"
  | "cdc"
  | "ident"
  | "function"
  | "at-keyword"
  | "number"
  | "percentage"
  | "dimension"
  | "string"
  | "uri"
  | "hash"
  | "class"
  | "urange"
  | "includes"
  | "dash-match"
  | "prefix-match"
  | "suffix-match"
  | "substring-match"
  | "only"
  | "not"
  | "and"
  | "important"
  | "char";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

export interface ParseError {
  readonly kind: "error";
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

// Upstream's reader: a line break is LF, CR or CRLF, not FF; a position is the last character
// read, and a column does not advance past a NUL. Reading again after the end is a failure.
const reader = (text: string) => {
  let pos = 0;
  let cur = 0;
  let prev = 0;
  let line = 1;
  let column = 1;
  let prevLine = 1;
  let failed = false;
  const next = () => {
    if (cur === -1) {
      failed = true;
      return -1;
    }
    prev = cur;
    cur = pos < text.length ? text.charCodeAt(pos) : -1;
    pos++;
    if (cur === CR || cur === LF) {
      if (!(cur === LF && prev === CR)) {
        prevLine = line;
        line++;
      }
    } else if (prevLine < line) {
      column = 1;
      prevLine = line;
    } else if (prev !== 0) column++;
    return cur;
  };
  const mark = () => [pos, cur, prev, line, column, prevLine] as const;
  const reset = (at: ReturnType<typeof mark>) => {
    [pos, cur, prev, line, column, prevLine] = at;
  };
  const ahead = (count: number) => {
    const at = mark();
    const chars: Array<number> = [];
    for (let index = 0; index < count; index++) chars.push(chars.at(-1) === -1 ? -1 : next());
    reset(at);
    return chars;
  };
  return {
    next,
    mark,
    reset,
    ahead,
    peek: () => ahead(1)[0] ?? -1,
    // The character `count` places ahead, or the end if it comes first.
    at: (count: number) => ahead(count).find((c, index) => c === -1 || index === count - 1) ?? -1,
    // Skips to the next character `stop` accepts that is not escaped, or to the end.
    forwardTo: (stop: (c: number) => boolean) => {
      for (;;) {
        const at = mark();
        next();
        if (cur === -1 || (stop(cur) && prev !== BACKSLASH)) {
          reset(at);
          return;
        }
      }
    },
    forward: (count: number) => {
      for (let index = 0; index < count; index++) {
        const at = mark();
        if (next() === -1) {
          reset(at);
          return;
        }
      }
    },
    get cur() {
      return cur;
    },
    get prev() {
      return prev;
    },
    get line() {
      return line;
    },
    get column() {
      return column;
    },
    get failed() {
      return failed;
    },
  };
};

// Java's MessageFormat: `{n}` arguments, and quotes that make text literal (`''` is a quote).
const messageFormat = (pattern: string, args: ReadonlyArray<string>) => {
  let result = "";
  let quoted = false;
  for (let index = 0; index < pattern.length; index++) {
    const c = pattern[index] ?? "";
    if (c === "'") {
      if (pattern[index + 1] === "'") {
        result += "'";
        index++;
      } else quoted = !quoted;
    } else if (c === "{" && !quoted) {
      const close = pattern.indexOf("}", index);
      if (close < 0) return result + pattern.slice(index);
      result += args[Number(pattern.slice(index + 1, close))] ?? pattern.slice(index, close + 1);
      index = close;
    } else result += c;
  }
  return result;
};

const messages = (locale: string | undefined) => {
  const raw = (key: string) => lookupIn(bundles, key, locale) ?? key;
  return {
    raw,
    format: (key: string, ...args: ReadonlyArray<string>) => messageFormat(raw(key), args),
  };
};

type Messages = ReturnType<typeof messages>;

interface Escape {
  readonly sequence: string;
  readonly character: number;
}

// The units upstream's scanner names; it spells a known unit in lowercase.
const UNITS =
  "dpcm dppx grad turn vmin vmax deg khz rad rem dpi em cm px mm in pt pc ch vw vh ex ms hz % q s".split(
    " ",
  );

// Every token of a style sheet, its errors reported as they are found. Upstream scans the whole
// sheet before parsing it, so these errors come first.
const scan = (css: string, text: Messages, errors: Array<ParseEvent>) => {
  const r = reader(css);
  const tokens: Array<Token> = [];
  for (;;) {
    const cur = r.next();
    if (cur === -1 || r.failed) break;
    const token: { kind: TokenKind; text: string; readonly line: number; readonly column: number } =
      { kind: "char", text: "", line: r.line, column: r.column };
    let tokenErrors = 0;
    const error = (key: string, ...args: ReadonlyArray<string>) => {
      tokenErrors++;
      errors.push({
        kind: "error",
        message: text.format(key, ...args),
        line: r.line,
        column: r.column,
      });
    };

    // At a backslash just read: the escape it starts, if any.
    const escapeHere = () => {
      const eight = r.ahead(8);
      const first = eight[0] ?? -1;
      if (first === -1) {
        prematureEnd();
        return undefined;
      }
      if (first === LF || first === CR || first === FF) return undefined;
      if (!isHex(first)) return { sequence: `\\${char(first)}`, character: first };
      let digits = "";
      let seenSpace = false;
      for (const c of eight) {
        if (c === -1) break;
        const hex = isHex(c);
        const space = isWhitespace(c);
        if (!hex && !space) break;
        if (hex && !seenSpace && digits.length < 6) digits += char(c);
        if (space) {
          if (seenSpace) {
            if (c === FF) digits += char(c);
            break;
          }
          digits += char(c);
          if (c !== CR) break;
          seenSpace = true;
        }
      }
      return {
        sequence: `\\${digits}`,
        character: Number.parseInt(trimBy(digits, isWhitespace, false), 16),
      };
    };
    const prematureEnd = () => error("css.scanner.prematureEOF");
    // Escapes `offset` characters ahead, computed once per token as upstream memoizes them.
    const memo = new Map<number, Escape | undefined>();
    const escapeAhead = (offset: number) => {
      if (memo.has(offset)) return memo.get(offset);
      const at = r.mark();
      let found: Escape | undefined;
      let ended = false;
      for (let index = 0; index < offset; index++) {
        if (r.next() === -1) {
          ended = true;
          break;
        }
      }
      if (!ended && r.cur === BACKSLASH) found = escapeHere();
      r.reset(at);
      memo.set(offset, found);
      return found;
    };
    // An escape is written as its character when `literal` accepts it, else as written.
    const render = (escape: Escape, literal: (c: number) => boolean, into: { text: string }) => {
      const c = escape.character & 0xffff;
      into.text += literal(c) ? char(c) : escape.sequence;
      return escape.sequence.length - 1;
    };
    const append = (accept: (c: number) => boolean, into: { text: string }) => {
      for (;;) {
        const at = r.mark();
        const c = r.next();
        if (c > -1 && accept(c)) into.text += char(c);
        else if (c === BACKSLASH) {
          const escape = escapeHere();
          if (escape === undefined) {
            r.reset(at);
            return;
          }
          r.forward(render(escape, accept, into));
        } else {
          r.reset(at);
          return;
        }
      }
    };
    const nextIsEscape = () => {
      const at = r.mark();
      const found = r.next() === BACKSLASH && escapeHere() !== undefined;
      r.reset(at);
      return found;
    };
    // `!` and `important`, with any whitespace between, in any case.
    const important = () => {
      const at = r.mark();
      const word = "important";
      let read = "";
      let seen = false;
      for (;;) {
        const c = r.next();
        if (c === -1) break;
        if (isWhitespace(c)) {
          if (seen) read += char(c);
        } else {
          seen = true;
          read += char(c);
          if (lowerAscii(read.charCodeAt(read.length - 1)) !== word.charCodeAt(read.length - 1)) {
            break;
          }
        }
        if (read.length === word.length) {
          if (read.toLowerCase() === word) return true;
          break;
        }
      }
      r.reset(at);
      return false;
    };
    const string = () => {
      token.kind = "string";
      const quote = r.cur;
      for (;;) {
        const at = r.mark();
        const c = r.next();
        if (c === -1) {
          prematureEnd();
          r.reset(at);
          return;
        }
        if (c === LF || c === CR || c === FF) {
          error("css.scanner.token.syntax.char", "NEWLINE", "STRING");
          r.forwardTo(isTerminator);
          return;
        }
        if (c === BACKSLASH) {
          const [first = -1, second = -1] = r.ahead(2);
          const newline =
            first === CR && second === LF
              ? 2
              : first === LF || first === CR || first === FF
                ? 1
                : 0;
          if (newline > 0) {
            r.forward(newline);
            continue;
          }
        } else if (c === quote && r.prev !== BACKSLASH) return;
        token.text += char(c);
      }
    };
    const quantity = () => {
      token.kind = "dimension";
      const suffix = { text: "" };
      append(isQuantityStart, suffix);
      if (!suffix.text.endsWith("%")) append(isNameChar, suffix);
      const lower = asciiLowerCase(suffix.text);
      const unit = suffix.text.length <= 4 && UNITS.includes(lower) ? lower : undefined;
      if (unit === "%") token.kind = "percentage";
      token.text += unit ?? suffix.text;
    };

    const next = r.peek();
    if (isWhitespace(cur)) {
      token.kind = "space";
      token.text = " ";
      r.forwardTo((c) => !isWhitespace(c));
    } else if (cur === 0x2d && sameAscii(r.ahead(2), "->")) {
      token.kind = "cdc";
      token.text = "-->";
      r.forward(2);
    } else if (lowerAscii(cur) === 0x6f && matchesOrEnd(r.at(4)) && sameAscii(r.ahead(3), "nly")) {
      token.kind = "only";
      token.text = "only";
      r.forward(3);
    } else if (lowerAscii(cur) === 0x6e && matchesOrEnd(r.at(3)) && sameAscii(r.ahead(2), "ot")) {
      token.kind = "not";
      token.text = "not";
      r.forward(2);
    } else if (lowerAscii(cur) === 0x61 && matchesOrEnd(r.at(3)) && sameAscii(r.ahead(2), "nd")) {
      token.kind = "and";
      token.text = "and";
      r.forward(2);
    } else if (lowerAscii(cur) === 0x75 && sameAscii(r.ahead(3), "rl(")) {
      token.kind = "uri";
      token.text = "url(";
      r.forward(3);
      r.forwardTo((c) => !isWhitespace(c));
      const start = r.next();
      if (start === -1) prematureEnd();
      else if (isQuote(start)) {
        token.text += "'";
        string();
        token.text += "'";
        r.forwardTo((c) => !isWhitespace(c));
        if (r.peek() > -1) r.next();
      } else {
        token.text += char(start);
        let body = "";
        for (;;) {
          const at = r.mark();
          const c = r.next();
          if (c === -1) {
            prematureEnd();
            r.reset(at);
            break;
          }
          if (c === 0x29) break;
          body += char(c);
        }
        token.text += trimBy(body, isWhitespace, false);
      }
      token.text += ")";
      token.kind = "uri";
      // MessageFormat prints the character's code as a number, in the JVM's default locale.
      if (r.cur !== 0x29 && tokenErrors === 0) {
        error("css.scanner.token.syntax", r.cur.toLocaleString("en-US"));
      }
    } else if (
      lowerAscii(cur) === 0x75 &&
      next === 0x2b &&
      (r.at(2) === -1 || isRangeStart(r.at(2)))
    ) {
      token.kind = "urange";
      r.next();
      let range = "";
      let count = 0;
      for (;;) {
        const at = r.mark();
        const c = r.next();
        if (c === -1 || !isRangeChar(c)) {
          r.reset(at);
          break;
        }
        count = c === 0x2d ? 0 : count + 1;
        if (count === 7) error("css.scanner.token.syntax.urange", `U+${range}${char(c)}`);
        range += char(c);
      }
      token.text = `U+${range}`;
    } else if (
      isNameStart(cur) ||
      (cur === 0x2d && (isNameStart(next) || next === 0x2d || escapeAhead(1) !== undefined)) ||
      escapeAhead(0) !== undefined
    ) {
      token.kind = "ident";
      const escape = escapeAhead(0);
      if (escape === undefined) token.text += char(cur);
      else r.forward(render(escape, isNameStart, token));
      if (cur === 0x2d || escape?.character === 0x2d) {
        // Upstream forwards from the hyphen, not past the backslash it found.
        const second = escapeAhead(1);
        if (second === undefined) token.text += char(r.next());
        else r.forward(render(second, isNameStart, token));
      }
      append(isNameChar, token);
      if (r.peek() === 0x28) {
        token.kind = "function";
        token.text += char(r.next());
      }
    } else if (
      cur === 0x40 &&
      (isNameStart(next) ||
        escapeAhead(1) !== undefined ||
        (next === 0x2d && isNameStart(r.at(2))) ||
        escapeAhead(2) !== undefined)
    ) {
      token.kind = "at-keyword";
      token.text = "@";
      append(isNameStart, token);
      append(isNameChar, token);
    } else if (
      isDigit(cur) ||
      ((isNumberChar(cur) || isUnary(cur)) && isDigit(next)) ||
      (isUnary(cur) && next === 0x2e && isDigit(r.at(2)))
    ) {
      token.kind = "number";
      token.text = char(cur);
      for (;;) {
        const at = r.mark();
        const c = r.next();
        if (c === -1) {
          if (token.text === ".") token.kind = "char";
          r.reset(at);
          break;
        }
        if (!isNumberChar(c) || (c === 0x2e && !isDigit(r.peek()))) {
          r.reset(at);
          break;
        }
        token.text += char(c);
      }
      const following = r.peek();
      if ((following > -1 && isQuantityStart(following)) || nextIsEscape()) quantity();
    } else if (cur === 0x3c && sameAscii(r.ahead(3), "!--")) {
      token.kind = "cdo";
      token.text = "<!--";
      r.forward(3);
    } else if (cur === 0x2f && next === 0x2a) {
      token.kind = "comment";
      r.next();
      for (;;) {
        const at = r.mark();
        const c = r.next();
        if (c === -1) {
          prematureEnd();
          r.reset(at);
          break;
        }
        if (c === 0x2a && r.peek() === 0x2f) {
          r.next();
          break;
        }
        token.text += char(c);
      }
    } else if (isQuote(cur)) string();
    else if ((cur === 0x23 || cur === 0x2e) && (isNameChar(next) || escapeAhead(1) !== undefined)) {
      token.kind = cur === 0x23 ? "hash" : "class";
      token.text = char(cur);
      append(isNameChar, token);
    } else if (cur === 0x21 && important()) {
      token.kind = "important";
      token.text = "!important";
    } else if (next === 0x3d && MATCHERS[cur] !== undefined) {
      token.kind = MATCHERS[cur] ?? "char";
      token.text = `${char(cur)}=`;
      r.next();
    } else token.text = char(cur);
    if (r.failed) return undefined;
    tokens.push(token);
  }
  return r.failed ? undefined : tokens;
};

const matchesOrEnd = (c: number) => c === -1 || isWhitespace(c);

const MATCHERS: Readonly<Record<number, TokenKind>> = {
  0x7e: "includes",
  0x7c: "dash-match",
  0x5e: "prefix-match",
  0x24: "suffix-match",
  0x2a: "substring-match",
};

// What upstream's grammar builds from tokens. Function, at-rule and declaration names are in
// lowercase; a string's value has no quotes.
export type Construct =
  | {
      readonly type:
        | "keyword"
        | "string"
        | "uri"
        | "urange"
        | "hash"
        | "class"
        | "quantity"
        | "symbol"
        | "type-selector"
        | "attribute-match"
        | "combinator";
      readonly value: string;
      readonly line: number;
      readonly column: number;
    }
  | {
      readonly type:
        | "function"
        | "paren"
        | "bracket"
        | "attribute-selector"
        | "selector"
        | "sequence";
      readonly name: string;
      readonly components: Array<Construct>;
      readonly line: number;
      readonly column: number;
    }
  | {
      readonly type: "pseudo";
      readonly name: string | undefined;
      readonly function: Construct | undefined;
      readonly line: number;
      readonly column: number;
    };

// A construct as upstream's toCssString writes it.
export const cssText = (construct: Construct): string => {
  switch (construct.type) {
    case "string":
      return `'${construct.value}'`;
    case "function":
      return `${construct.name}(${construct.components.map(cssText).join("")})`;
    case "paren":
    case "bracket": {
      // Upstream drops the last character, which is the opening one when there is no component.
      const open = construct.type === "paren" ? "(" : "[";
      const close = construct.type === "paren" ? ")" : "]";
      return `${`${open}${construct.components.map((each) => `${cssText(each)} `).join("")}`.slice(0, -1)}${close}`;
    }
    case "attribute-selector":
      return `[${construct.components.map(cssText).join("")}]`;
    case "selector":
    case "sequence":
      return construct.components.map(cssText).join("");
    case "pseudo":
      return construct.function === undefined
        ? (construct.name ?? "null")
        : cssText(construct.function);
    default:
      return construct.value;
  }
};

// A URL's text: `url(`, its quotes, the whitespace around it and the closing parenthesis go.
export const uriText = (value: string) => {
  let result = "";
  let started = false;
  for (let index = 4; index < value.length - 1; index++) {
    const c = value.charCodeAt(index);
    if (isQuote(c) || isWhitespace(c)) {
      if (started) result += value[index];
    } else {
      started = true;
      result += value[index];
    }
  }
  return trimBy(result, (c) => isQuote(c) || isWhitespace(c), false);
};

export interface AtRule {
  readonly name: string;
  readonly components: Array<Construct>;
  readonly line: number;
  readonly column: number;
}

export interface Declaration {
  readonly name: string;
  readonly components: Array<Construct>;
  important: boolean;
  readonly line: number;
  readonly column: number;
}

export type ParseEvent =
  | ParseError
  | { readonly kind: "at-rule"; readonly rule: AtRule }
  | { readonly kind: "end-at-rule"; readonly name: string }
  | { readonly kind: "selectors"; readonly selectors: ReadonlyArray<Construct> }
  | { readonly kind: "declaration"; readonly declaration: Declaration }
  // The end of the sheet, which upstream's parser does not reach after some errors.
  | { readonly kind: "end" }
  // Upstream's scanner fails when it reads past the end; its errors so far are reported.
  | { readonly kind: "failure" };

const isChar = (token: Token | undefined, c: string) => token?.kind === "char" && token.text === c;
type TokenFilter = (token: Token) => boolean;
const significant: TokenFilter = (token) => token.kind !== "space" && token.kind !== "comment";
const topLevel: TokenFilter = (token) =>
  significant(token) && token.kind !== "cdo" && token.kind !== "cdc";
const anyToken: TokenFilter = () => true;
const semiOrClose: TokenFilter = (token) => isChar(token, ";") || isChar(token, "}");
const semiOrOpen: TokenFilter = (token) => isChar(token, ";") || isChar(token, "{");

// Upstream unwinds with exceptions at the end of the tokens and after reporting a premature end;
// they never leave this module.
class EndOfTokens extends Error {}
class PrematureEnd extends Error {}

type Permitted = (construct: Construct) => boolean;
const anything: Permitted = () => true;
const attributeValue: Permitted = (construct) =>
  construct.type === "keyword" || construct.type === "string";
const pseudoArgument: Permitted = (construct) =>
  construct.type === "keyword" ||
  construct.type === "string" ||
  construct.type === "quantity" ||
  (construct.type === "symbol" && (construct.value === "+" || construct.value === "-"));

const ATOMIC: Partial<
  Record<TokenKind, "keyword" | "string" | "uri" | "urange" | "hash" | "class">
> = {
  ident: "keyword",
  and: "keyword",
  not: "keyword",
  only: "keyword",
  uri: "uri",
  string: "string",
  urange: "urange",
  hash: "hash",
  class: "class",
};

// A style sheet, or with `styleAttribute` a `style` attribute's declarations.
export const parse = (css: string, styleAttribute: boolean, locale: string | undefined) => {
  const text = messages(locale);
  const events: Array<ParseEvent> = [];
  const tokens = scan(css, text, events);
  if (tokens === undefined) {
    events.push({ kind: "failure" });
    return events;
  }

  // Upstream's token iterator: the index of the next token, of the last one read (filtered out
  // or not), and the last one returned.
  let cursor = 0;
  let index = -1;
  let last: Token = { kind: "space", text: " ", line: 1, column: 1 };
  const next = (filter: TokenFilter = significant) => {
    for (;;) {
      const at = cursor;
      const token = tokens[at];
      if (token === undefined) throw new EndOfTokens();
      cursor = at + 1;
      index = at;
      if (filter(token)) {
        last = token;
        return token;
      }
    }
  };
  const hasNext = (filter: TokenFilter = significant) => {
    for (let at = cursor; at < tokens.length; at++) {
      const token = tokens[at];
      if (token !== undefined && filter(token)) return true;
    }
    return false;
  };
  const peek = (filter: TokenFilter = significant) => {
    const saved = [cursor, index, last] as const;
    const token = next(filter);
    [cursor, index, last] = saved;
    return token;
  };

  type Sink = (message: string, at: Token | Construct) => void;
  const report: Sink = (message, at) =>
    events.push({ kind: "error", message, line: at.line, column: at.column });
  const forgiving: Sink = () => undefined;
  const unexpected = (sink: Sink, at: Token | Construct, token: string) =>
    sink(text.format("css.grammar.token.unexpected", token), at);
  const expecting = (sink: Sink, at: Token | Construct, token: string, wanted: string) =>
    sink(text.format("css.grammar.token.expecting", token, wanted), at);
  const prematureEnd = (wanted: string) =>
    report(text.format("css.grammar.prematureEOF", wanted), last);
  const or = text.raw("or");

  // The grammar's builders are annotated, as they recurse into one another.
  const construct = (
    start: Token,
    limit: TokenFilter,
    permitted: Permitted,
  ): Construct | undefined => {
    const at = { line: start.line, column: start.column };
    if (start.kind === "function" || isChar(start, "(") || isChar(start, "[")) {
      const type =
        start.kind === "function" ? "function" : start.text === "(" ? "paren" : "bracket";
      const end = type === "bracket" ? "]" : ")";
      const name = type === "function" ? asciiLowerCase(start.text.slice(0, -1)) : "";
      const group: Construct = { type, name, components: [], ...at };
      for (let token = next(); !isChar(token, end); token = next()) {
        if (limit(token)) return undefined;
        const component = construct(token, limit, anything);
        if (component === undefined || !permitted(component)) return undefined;
        group.components.push(component);
      }
      return type === "function" || permitted(group) ? group : undefined;
    }
    let built: Construct | undefined;
    const atomic = ATOMIC[start.kind];
    if (atomic !== undefined) built = { type: atomic, value: start.text, ...at };
    else if (start.kind === "number" || start.kind === "percentage" || start.kind === "dimension") {
      built = { type: "quantity", value: start.text, ...at };
    } else if (start.kind === "char" && !["{", "}", ";"].includes(start.text)) {
      built = { type: "symbol", value: start.text, ...at };
    }
    return built !== undefined && permitted(built) ? built : undefined;
  };

  // Selectors.
  const typeSelector = (start: Token, sink: Sink): Construct | undefined => {
    if (start.kind !== "ident" && !isChar(start, "*") && !isChar(start, "|")) {
      expecting(sink, start, start.text, text.raw("a_type_or_universal_selector"));
      return undefined;
    }
    let value = start.text;
    if (isChar(start, "|")) {
      const name = peek(anyToken);
      if (name.kind !== "ident") {
        expecting(sink, name, name.text, text.raw("a_type_or_universal_selector"));
        return undefined;
      }
      value += next().text;
    } else if (isChar(peek(anyToken), "|")) {
      value += next().text;
      const name = next(anyToken);
      if (name.kind !== "ident" && !isChar(name, "*")) {
        expecting(sink, start, name.text, text.raw("a_type_or_universal_selector"));
        return undefined;
      }
      value += name.text;
    } else if (peek(anyToken).kind === "ident") value += next().text;
    return { type: "type-selector", value, line: start.line, column: start.column };
  };
  const attributeSelector = (start: Token, sink: Sink): Construct | undefined => {
    const selector: Construct = {
      type: "attribute-selector",
      name: "",
      components: [],
      line: start.line,
      column: start.column,
    };
    const name = typeSelector(start, sink);
    if (name === undefined) return undefined;
    selector.components.push(name);
    let token = next();
    if (isChar(token, "]")) return selector;
    if (
      !isChar(token, "=") &&
      !["includes", "dash-match", "prefix-match", "suffix-match", "substring-match"].includes(
        token.kind,
      )
    ) {
      expecting(sink, token, token.text, text.raw("an_attribute_value_matcher"));
      return undefined;
    }
    selector.components.push({
      type: "attribute-match",
      value: token.text,
      line: token.line,
      column: token.column,
    });
    token = next();
    const value = construct(token, (each) => isChar(each, "]"), attributeValue);
    if (value === undefined) {
      expecting(sink, token, token.text, text.raw("a_string_or_dentifier"));
      return undefined;
    }
    selector.components.push(value);
    next();
    return selector;
  };
  const pseudoSelector = (start: Token, sink: Sink): Construct | undefined => {
    let prefix = start.text;
    let token = next(anyToken);
    if (isChar(token, ":")) {
      prefix += token.text;
      token = next(anyToken);
    }
    const at = { line: start.line, column: start.column };
    if (token.kind === "ident") {
      return { type: "pseudo", name: prefix + token.text, function: undefined, ...at };
    }
    if (token.kind !== "function")
      return { type: "pseudo", name: undefined, function: undefined, ...at };
    const name = asciiLowerCase(prefix + token.text.slice(0, -1));
    const fn: Construct = {
      type: "function",
      name,
      components: [],
      line: token.line,
      column: token.column,
    };
    let built: Construct | undefined = fn;
    const kind = asciiLowerCase(token.text);
    if (kind === "not(" || kind === "is(" || kind === "where(" || kind === "has(") {
      const listed = selectorList(next(), sink, kind !== "not(", kind === "has(", (each) =>
        isChar(each, ")"),
      );
      if (listed === undefined) built = undefined;
      else fn.components.push(...listed);
    } else {
      for (let each = next(); !isChar(each, ")"); each = next()) {
        const component = isChar(each, "{")
          ? undefined
          : construct(each, (t) => isChar(t, "{"), pseudoArgument);
        if (component === undefined) {
          built = undefined;
          break;
        }
        fn.components.push(component);
      }
    }
    if (built === undefined) {
      unexpected(sink, last, last.text);
      return undefined;
    }
    return { type: "pseudo", name: undefined, function: fn, ...at };
  };
  const simpleSelector = (start: Token, sink: Sink): Construct | undefined => {
    if (start.kind === "ident" || isChar(start, "*") || isChar(start, "|"))
      return typeSelector(start, sink);
    if (start.kind === "hash" || start.kind === "class") {
      return { type: start.kind, value: start.text, line: start.line, column: start.column };
    }
    if (isChar(start, "[")) return attributeSelector(next(), sink);
    if (isChar(start, ":")) return pseudoSelector(start, sink);
    // A keyframe selector.
    if (start.kind === "percentage") {
      const at = { line: start.line, column: start.column };
      return {
        type: "selector",
        name: "",
        components: [{ type: "quantity", value: start.text, ...at }],
        ...at,
      };
    }
    unexpected(sink, start, start.text);
    return undefined;
  };
  const sequence = (start: Token, sink: Sink): Construct | undefined => {
    const result: Construct = {
      type: "sequence",
      name: "",
      components: [],
      line: start.line,
      column: start.column,
    };
    let item = simpleSelector(start, sink);
    for (;;) {
      if (item === undefined) return undefined;
      result.components.push(item);
      const following = peek(anyToken);
      if (
        following.kind === "space" ||
        isChar(following, ",") ||
        isChar(following, "{") ||
        isChar(following, ")") ||
        isChar(following, ">") ||
        isChar(following, "+") ||
        isChar(following, "~")
      ) {
        return result;
      }
      item = simpleSelector(next(anyToken), sink);
    }
  };
  const selectorList = (
    first: Token,
    sink: Sink,
    lenient: boolean,
    relativeList: boolean,
    end: TokenFilter,
  ): Array<Construct> | undefined => {
    const selectors: Array<Construct> = [];
    let start = first;
    let relative = relativeList;
    for (;;) {
      const selector: Construct = {
        type: "selector",
        name: "",
        components: [],
        line: start.line,
        column: start.column,
      };
      const selectorIndex = index;
      let ended = false;
      for (;;) {
        if (!relative || index > selectorIndex) {
          const found = sequence(start, lenient ? forgiving : sink);
          if (found === undefined) return undefined;
          selector.components.push(found);
          start = next();
        }
        const at = index;
        if (end(start)) {
          ended = true;
          break;
        }
        if (isChar(start, ",")) break;
        if (isChar(start, ">") || isChar(start, "+") || isChar(start, "~")) {
          selector.components.push({
            type: "combinator",
            value: start.text,
            line: start.line,
            column: start.column,
          });
          start = next();
        } else if (tokens[at - 1]?.kind === "space" || tokens[at - 1]?.kind === "function") {
          selector.components.push({
            type: "combinator",
            value: " ",
            line: start.line,
            column: start.column,
          });
          relative = false;
        } else {
          unexpected(sink, last, last.text);
          return undefined;
        }
      }
      selectors.push(selector);
      if (ended) return selectors;
      start = next();
    }
  };

  // Rules.
  const declaration = (name: Token, inAttribute: boolean) => {
    if (name.kind !== "ident") {
      expecting(report, name, name.text, text.raw("a_property_name"));
      return undefined;
    }
    const found: Declaration = {
      name: asciiLowerCase(name.text),
      components: [],
      important: false,
      line: name.line,
      column: name.column,
    };
    try {
      if (!isChar(next(), ":")) {
        expecting(report, name, last.text, ":");
        return undefined;
      }
    } catch (error) {
      if (!(error instanceof EndOfTokens)) throw error;
      prematureEnd(":");
      throw new PrematureEnd();
    }
    try {
      for (;;) {
        let value = next();
        if (semiOrClose(value)) {
          if (found.components.length > 0 || found.name.startsWith("--")) return found;
          expecting(report, last, value.text, text.raw("a_property_value"));
          return undefined;
        }
        // The value's components, up to a `;`, or a `}` outside an attribute.
        for (;;) {
          if (value.kind === "important") found.important = true;
          else {
            const component = construct(value, semiOrClose, anything);
            if (component === undefined) {
              unexpected(report, last, last.text);
              return undefined;
            }
            found.components.push(component);
          }
          if (
            (inAttribute && !hasNext()) ||
            isChar(peek(), ";") ||
            (!inAttribute && isChar(peek(), "}"))
          )
            break;
          value = next();
        }
        if (found.components.length === 0) {
          unexpected(report, last, last.text);
          return undefined;
        }
        if (inAttribute && !hasNext()) return found;
      }
    } catch (error) {
      if (!(error instanceof EndOfTokens)) throw error;
      prematureEnd(`';' ${or} '}'`);
      throw new PrematureEnd();
    }
  };
  const declarationBlock = (first: Token) => {
    let start = first;
    for (;;) {
      if (isChar(start, "}")) return;
      if (isChar(start, ";")) {
        start = next();
        continue;
      }
      const found = declaration(start, false);
      try {
        if (found !== undefined) {
          events.push({ kind: "declaration", declaration: found });
          if (isChar(last, "}")) return;
          if (isChar(last, ";") && isChar(peek(), "}")) {
            next();
            return;
          }
          start = next();
        } else {
          start = next(semiOrClose);
          if (isChar(start, ";")) start = next();
        }
      } catch (error) {
        if (!(error instanceof EndOfTokens)) throw error;
        prematureEnd(`';' ${or} '}'`);
        throw new PrematureEnd();
      }
    }
  };
  const ruleSet = (start: Token) => {
    let wanted = "'{'";
    try {
      const selectors = selectorList(start, report, false, false, (token) => isChar(token, "{"));
      wanted = "'}'";
      if (selectors === undefined) {
        next((token) => isChar(token, "}"));
        return;
      }
      if (isChar(last, ")")) {
        unexpected(report, last, last.text);
        next((token) => isChar(token, "}"));
        return;
      }
      events.push({ kind: "selectors", selectors });
      declarationBlock(next());
    } catch (error) {
      if (!(error instanceof EndOfTokens)) throw error;
      prematureEnd(wanted);
      throw new PrematureEnd();
    }
  };
  // A block holds rules when a `{` comes before any `;` or `}`.
  const holdsRules = () => {
    for (let at = index + 1; at < tokens.length; at++) {
      const token = tokens[at];
      if (isChar(token, "{")) return true;
      if (token !== undefined && semiOrClose(token)) return false;
    }
    return false;
  };
  const atRule = (start: Token) => {
    const rule: AtRule = {
      name: asciiLowerCase(start.text),
      components: [],
      line: start.line,
      column: start.column,
    };
    let block = false;
    try {
      for (;;) {
        const token = next();
        if (semiOrOpen(token)) {
          block = token.text === "{";
          break;
        }
        const component = construct(token, semiOrOpen, anything);
        if (component === undefined) {
          unexpected(report, last, last.text);
          // Upstream skips to the rule's end: a `;`, or the `}` closing its first block.
          let depth = 0;
          for (;;) {
            const skipped = next();
            if (isChar(skipped, ";") && depth === 0) return;
            if (isChar(skipped, "{")) depth++;
            else if (isChar(skipped, "}")) {
              if (depth === 1) return;
              depth--;
            }
          }
        }
        rule.components.push(component);
      }
    } catch (error) {
      if (!(error instanceof EndOfTokens)) throw error;
      events.push({ kind: "at-rule", rule });
      prematureEnd(`';' ${or} '{'`);
      events.push({ kind: "end-at-rule", name: rule.name });
      throw new PrematureEnd();
    }
    events.push({ kind: "at-rule", rule });
    if (block) {
      try {
        if (holdsRules()) {
          while (!isChar(next(), "}")) {
            if (last.kind === "at-keyword") atRule(last);
            else ruleSet(last);
          }
        } else declarationBlock(next());
      } catch (error) {
        if (!(error instanceof EndOfTokens)) throw error;
        prematureEnd("'}'");
        events.push({ kind: "end-at-rule", name: rule.name });
        throw new PrematureEnd();
      }
    }
    events.push({ kind: "end-at-rule", name: rule.name });
  };

  try {
    if (styleAttribute) {
      while (hasNext()) {
        const token = next();
        if (isChar(token, ";")) continue;
        const found = declaration(token, true);
        if (found === undefined) return events;
        events.push({ kind: "declaration", declaration: found });
      }
    } else {
      while (hasNext(topLevel)) {
        const token = next(topLevel);
        if (token.kind === "at-keyword") atRule(token);
        else ruleSet(token);
      }
    }
  } catch (error) {
    // Nesting deeper than the stack allows aborts the sheet, as upstream's parser does.
    if (error instanceof RangeError) {
      events.push({ kind: "failure" });
      return events;
    }
    if (!(error instanceof PrematureEnd)) throw error;
  }
  events.push({ kind: "end" });
  return events;
};
