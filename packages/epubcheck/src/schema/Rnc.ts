import * as Result from "effect/Result";

import type { Ast, Combine, Component, NameClassAst, Param } from "./Ast.ts";

// A parser for the RELAX NG compact syntax (https://relaxng.org/compact-20021121.html),
// producing the unsimplified tree in Ast.ts. Annotations and documentation are skipped.

export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const XSD_LIBRARY = "http://www.w3.org/2001/XMLSchema-datatypes";

const KEYWORDS = new Set([
  "attribute",
  "default",
  "datatypes",
  "div",
  "element",
  "empty",
  "external",
  "grammar",
  "include",
  "inherit",
  "list",
  "mixed",
  "namespace",
  "notAllowed",
  "parent",
  "start",
  "string",
  "text",
  "token",
]);

type Token =
  | { readonly t: "ident"; readonly value: string; readonly escaped: boolean }
  | { readonly t: "cname"; readonly prefix: string; readonly local: string }
  | { readonly t: "nsname"; readonly prefix: string }
  | { readonly t: "literal"; readonly value: string }
  | { readonly t: "op"; readonly value: string }
  | { readonly t: "eof" };

export interface RncError {
  readonly file: string;
  readonly message: string;
}

const NAME_START = /[A-Za-z_À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_.\-·À-￿]/;

const tokenize = (source: string) => {
  const text = source.replace(/\\x\{([0-9a-fA-F]+)\}/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
  const tokens: Array<Token> = [];
  let index = 0;
  const readName = () => {
    const start = index;
    while (index < text.length && NAME_CHAR.test(text[index] ?? "")) index++;
    return text.slice(start, index);
  };
  while (index < text.length) {
    const char = text[index] ?? "";
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "#") {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index++;
      continue;
    }
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), index);
      const quote = triple ? char.repeat(3) : char;
      const end = text.indexOf(quote, index + quote.length);
      if (end < 0) return Result.fail("unterminated literal");
      tokens.push({ t: "literal", value: text.slice(index + quote.length, end) });
      index = end + quote.length;
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (pair === "|=" || pair === "&=" || pair === ">>") {
      tokens.push({ t: "op", value: pair });
      index += 2;
      continue;
    }
    if ("={}()[],&|?*+-~".includes(char)) {
      tokens.push({ t: "op", value: char });
      index++;
      continue;
    }
    const escaped = char === "\\";
    if (escaped) index++;
    if (!NAME_START.test(text[index] ?? "")) return Result.fail(`unexpected character "${char}"`);
    const name = readName();
    if (!escaped && text[index] === ":") {
      if (text[index + 1] === "*") {
        tokens.push({ t: "nsname", prefix: name });
        index += 2;
        continue;
      }
      if (NAME_START.test(text[index + 1] ?? "")) {
        index++;
        tokens.push({ t: "cname", prefix: name, local: readName() });
        continue;
      }
    }
    tokens.push({ t: "ident", value: name, escaped });
  }
  tokens.push({ t: "eof" });
  return Result.succeed(tokens);
};

export interface ParseContext {
  readonly file: string;
  readonly inheritedNamespace: string;
}

class Parser {
  private index = 0;
  private readonly namespaces = new Map<string, string>([["xml", XML_NS]]);
  private readonly datatypes = new Map<string, string>([["xsd", XSD_LIBRARY]]);
  private defaultNamespace: string;
  error: string | undefined;

  private readonly tokens: ReadonlyArray<Token>;
  private readonly context: ParseContext;

  constructor(tokens: ReadonlyArray<Token>, context: ParseContext) {
    this.tokens = tokens;
    this.context = context;
    this.defaultNamespace = context.inheritedNamespace;
  }

  private get token(): Token {
    return this.tokens[this.index] ?? { t: "eof" };
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.index + offset] ?? { t: "eof" };
  }

  private fail(message: string) {
    this.error ??= message;
    this.index = this.tokens.length - 1;
  }

  private isOp(value: string, token = this.token) {
    return token.t === "op" && token.value === value;
  }

  private isKeyword(value: string, token = this.token) {
    return token.t === "ident" && !token.escaped && token.value === value;
  }

  private expectOp(value: string) {
    if (this.isOp(value)) this.index++;
    else this.fail(`expected "${value}"`);
  }

  private literal() {
    let value = "";
    let first = true;
    while (first || this.isOp("~")) {
      if (!first) this.index++;
      first = false;
      const token = this.token;
      if (token.t !== "literal") {
        this.fail("expected a literal");
        return value;
      }
      value += token.value;
      this.index++;
    }
    return value;
  }

  private identifierOrKeyword() {
    const token = this.token;
    if (token.t !== "ident") {
      this.fail("expected an identifier");
      return "";
    }
    this.index++;
    return token.value;
  }

  // Skips `[ ... ]` annotations, which carry no validation semantics.
  private skipAnnotations() {
    while (this.isOp("[")) {
      let depth = 0;
      do {
        if (this.isOp("[")) depth++;
        else if (this.isOp("]")) depth--;
        else if (this.token.t === "eof") return this.fail("unterminated annotation");
        this.index++;
      } while (depth > 0);
    }
  }

  private skipFollowAnnotations() {
    while (this.isOp(">>")) {
      this.index++;
      this.index++; // the annotation element name
      this.skipAnnotations();
    }
  }

  private resolvePrefix(prefix: string) {
    const ns = this.namespaces.get(prefix);
    if (ns === undefined) this.fail(`undeclared prefix "${prefix}"`);
    return ns ?? "";
  }

  preamble() {
    for (;;) {
      this.skipAnnotations();
      if (this.isKeyword("namespace")) {
        this.index++;
        const prefix = this.identifierOrKeyword();
        this.expectOp("=");
        const uri = this.isKeyword("inherit")
          ? (this.index++, this.context.inheritedNamespace)
          : this.literal();
        this.namespaces.set(prefix, uri);
      } else if (this.isKeyword("default") && this.isKeyword("namespace", this.peekAt(1))) {
        this.index += 2;
        const prefix = this.token.t === "ident" ? this.identifierOrKeyword() : undefined;
        this.expectOp("=");
        const uri = this.isKeyword("inherit")
          ? (this.index++, this.context.inheritedNamespace)
          : this.literal();
        this.defaultNamespace = uri;
        if (prefix !== undefined) this.namespaces.set(prefix, uri);
      } else if (this.isKeyword("datatypes")) {
        this.index++;
        const prefix = this.identifierOrKeyword();
        this.expectOp("=");
        this.datatypes.set(prefix, this.literal());
      } else {
        return;
      }
    }
  }

  topLevel(): Ast {
    this.preamble();
    const isGrammar =
      this.token.t === "eof" ||
      this.isKeyword("start") ||
      this.isKeyword("div") ||
      this.isKeyword("include") ||
      (this.token.t === "ident" &&
        (this.isOp("=", this.peekAt(1)) ||
          this.isOp("|=", this.peekAt(1)) ||
          this.isOp("&=", this.peekAt(1))));
    if (isGrammar) return { kind: "grammar", components: this.components("eof") };
    const pattern = this.pattern();
    if (this.index < this.tokens.length - 1) this.fail("unexpected content after the pattern");
    return pattern;
  }

  private components(until: "eof" | "}"): ReadonlyArray<Component> {
    const components: Array<Component> = [];
    for (;;) {
      this.skipAnnotations();
      if (until === "eof" ? this.token.t === "eof" : this.isOp("}")) return components;
      if (this.error !== undefined) return components;
      const token = this.token;
      if (this.isKeyword("start")) {
        this.index++;
        const combine = this.assignOperator();
        components.push({ kind: "start", combine, body: this.pattern() });
      } else if (this.isKeyword("div")) {
        this.index++;
        this.expectOp("{");
        components.push({ kind: "div", components: this.components("}") });
        this.expectOp("}");
      } else if (this.isKeyword("include")) {
        this.index++;
        const href = this.literal();
        const inherited = this.inherit();
        let body: ReadonlyArray<Component> = [];
        if (this.isOp("{")) {
          this.index++;
          body = this.components("}");
          this.expectOp("}");
        }
        components.push({ kind: "include", href, defaultNamespace: inherited, components: body });
      } else if (token.t === "ident") {
        this.index++;
        const combine = this.assignOperator();
        components.push({ kind: "define", name: token.value, combine, body: this.pattern() });
      } else if (token.t === "cname") {
        // A grammar-level annotation element such as `a:documentation [ ... ]`.
        this.index++;
        this.skipAnnotations();
      } else {
        this.fail("expected a grammar component");
      }
    }
  }

  private assignOperator(): Combine {
    if (this.isOp("=")) {
      this.index++;
      return undefined;
    }
    if (this.isOp("|=")) {
      this.index++;
      return "choice";
    }
    if (this.isOp("&=")) {
      this.index++;
      return "interleave";
    }
    this.fail('expected "=", "|=" or "&="');
    return undefined;
  }

  private inherit() {
    if (this.isKeyword("inherit") && this.isOp("=", this.peekAt(1))) {
      this.index += 2;
      return this.resolvePrefix(this.identifierOrKeyword());
    }
    return this.defaultNamespace;
  }

  pattern(): Ast {
    const first = this.particle();
    const operator =
      this.token.t === "op" && [",", "&", "|"].includes(this.token.value)
        ? this.token.value
        : undefined;
    if (operator === undefined) return first;
    const items = [first];
    while (this.isOp(operator)) {
      this.index++;
      items.push(this.particle());
    }
    if (this.token.t === "op" && [",", "&", "|"].includes(this.token.value)) {
      this.fail("mixing operators requires parentheses");
    }
    return { kind: operator === "," ? "group" : operator === "&" ? "interleave" : "choice", items };
  }

  private particle(): Ast {
    this.skipAnnotations();
    const primary = this.primary();
    this.skipFollowAnnotations();
    if (this.isOp("?") || this.isOp("*") || this.isOp("+")) {
      const operator = this.token.t === "op" ? this.token.value : "";
      this.index++;
      this.skipFollowAnnotations();
      return {
        kind: operator === "?" ? "optional" : operator === "*" ? "zeroOrMore" : "oneOrMore",
        body: primary,
      };
    }
    return primary;
  }

  private primary(): Ast {
    this.skipAnnotations();
    const token = this.token;
    if (this.isOp("(")) {
      this.index++;
      const inner = this.pattern();
      this.expectOp(")");
      return inner;
    }
    if (token.t === "literal") {
      return this.valuePattern("", "token");
    }
    if (token.t === "cname") {
      this.index++;
      const library = this.datatypes.get(token.prefix);
      if (library === undefined) {
        this.fail(`undeclared datatype prefix "${token.prefix}"`);
        return { kind: "notAllowed" };
      }
      if (this.token.t === "literal") return this.valuePattern(library, token.local);
      return this.dataPattern(library, token.local);
    }
    if (token.t !== "ident") {
      this.fail("expected a pattern");
      return { kind: "notAllowed" };
    }
    if (token.escaped) {
      this.index++;
      return { kind: "ref", name: token.value };
    }
    switch (token.value) {
      case "element":
      case "attribute": {
        this.index++;
        const name = this.nameClass(token.value === "attribute");
        this.expectOp("{");
        const body = this.pattern();
        this.expectOp("}");
        return { kind: token.value, name, body };
      }
      case "mixed":
      case "list": {
        this.index++;
        this.expectOp("{");
        const body = this.pattern();
        this.expectOp("}");
        return { kind: token.value, body };
      }
      case "empty":
      case "text":
      case "notAllowed":
        this.index++;
        return { kind: token.value };
      case "string":
      case "token":
        this.index++;
        if (this.token.t === "literal") return this.valuePattern("", token.value);
        return this.dataPattern("", token.value);
      case "external": {
        this.index++;
        const href = this.literal();
        return { kind: "externalRef", href, defaultNamespace: this.inherit() };
      }
      case "grammar": {
        this.index++;
        this.expectOp("{");
        const components = this.components("}");
        this.expectOp("}");
        return { kind: "grammar", components };
      }
      case "parent":
        this.index++;
        return { kind: "parentRef", name: this.identifierOrKeyword() };
      default:
        this.index++;
        return { kind: "ref", name: token.value };
    }
  }

  private valuePattern(library: string, type: string): Ast {
    return {
      kind: "value",
      library,
      type,
      value: this.literal(),
      namespaces: Object.fromEntries([...this.namespaces, ["", this.defaultNamespace]]),
    };
  }

  private dataPattern(library: string, type: string): Ast {
    const params: Array<Param> = [];
    if (this.isOp("{")) {
      this.index++;
      while (!this.isOp("}") && this.error === undefined) {
        this.skipAnnotations();
        const name = this.identifierOrKeyword();
        this.expectOp("=");
        params.push({ name, value: this.literal() });
      }
      this.expectOp("}");
    }
    let except: Ast | undefined;
    if (this.isOp("-")) {
      this.index++;
      except = this.primary();
    }
    return { kind: "data", library, type, params, except };
  }

  private nameClass(isAttribute: boolean): NameClassAst {
    const first = this.nameClassPrimary(isAttribute);
    if (!this.isOp("|")) return first;
    const items = [first];
    while (this.isOp("|")) {
      this.index++;
      items.push(this.nameClassPrimary(isAttribute));
    }
    return { kind: "choice", items };
  }

  private nameClassPrimary(isAttribute: boolean): NameClassAst {
    this.skipAnnotations();
    const token = this.token;
    if (this.isOp("(")) {
      this.index++;
      const inner = this.nameClass(isAttribute);
      this.expectOp(")");
      return inner;
    }
    if (this.isOp("*")) {
      this.index++;
      return { kind: "anyName", except: this.nameClassExcept(isAttribute) };
    }
    if (token.t === "nsname") {
      this.index++;
      return {
        kind: "nsName",
        ns: this.resolvePrefix(token.prefix),
        except: this.nameClassExcept(isAttribute),
      };
    }
    if (token.t === "cname") {
      this.index++;
      return { kind: "name", ns: this.resolvePrefix(token.prefix), local: token.local };
    }
    if (token.t === "ident") {
      this.index++;
      return { kind: "name", ns: isAttribute ? "" : this.defaultNamespace, local: token.value };
    }
    this.fail("expected a name class");
    return { kind: "anyName", except: undefined };
  }

  private nameClassExcept(isAttribute: boolean) {
    if (!this.isOp("-")) return undefined;
    this.index++;
    return this.nameClassPrimary(isAttribute);
  }
}

export const parse = (source: string, context: ParseContext) => {
  const tokens = tokenize(source);
  if (Result.isFailure(tokens)) return Result.fail({ file: context.file, message: tokens.failure });
  const parser = new Parser(tokens.success, context);
  const ast = parser.topLevel();
  if (parser.error !== undefined) return Result.fail({ file: context.file, message: parser.error });
  return Result.succeed(ast);
};

export const isKeyword = (name: string) => KEYWORDS.has(name);
