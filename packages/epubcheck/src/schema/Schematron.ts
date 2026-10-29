import * as Result from "effect/Result";
// fontoxpath ships CommonJS without an exports map, so Node only exposes a default export.
import fontoxpath from "fontoxpath";
import * as slimdom from "slimdom";

import * as Xml from "../xml/Xml.ts";
import type { SchemaError } from "./Validator.ts";

// ISO Schematron with the XSLT 2 query binding, evaluated with fontoxpath over a slimdom copy
// of the document. Supports what upstream's schemas use: includes, abstract patterns with
// parameters, lets, asserts, reports, and value-of/name in messages.

const SCH_NS = "http://purl.oclc.org/dsdl/schematron";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
// Schematron 1.5, which upstream's EPUB 2 NCX and XHTML schemas still use.
const SCH15_NS = "http://www.ascc.net/xml/schematron";
const isSchematron = (ns: string) => ns === SCH_NS || ns === SCH15_NS;
const XSL_NS = "http://www.w3.org/1999/XSL/Transform";
const EXTENSIONS_NS = "urn:epubcheck-ts:xpath";

type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value-of"; readonly select: string }
  // `<name/>`: the name of the context node, or of the first node `path` selects.
  | { readonly kind: "name"; readonly path: string | undefined };

interface Let {
  readonly name: string;
  readonly value: string;
}

interface Check {
  readonly kind: "assert" | "report";
  readonly test: string;
  readonly message: ReadonlyArray<MessagePart>;
}

interface Rule {
  readonly context: string;
  readonly lets: ReadonlyArray<Let>;
  readonly checks: ReadonlyArray<Check>;
}

interface PatternDef {
  readonly id: string | undefined;
  readonly lets: ReadonlyArray<Let>;
  readonly rules: ReadonlyArray<Rule>;
}

export interface SchematronSchema {
  readonly namespaces: Readonly<Record<string, string>>;
  readonly lets: ReadonlyArray<Let>;
  readonly patterns: ReadonlyArray<PatternDef>;
}

const {
  evaluateXPath,
  evaluateXPathToBoolean,
  evaluateXPathToNodes,
  evaluateXPathToString,
  registerCustomXPathFunction,
} = fontoxpath;

// XPath's whitespace is space, tab, CR and LF; JavaScript's `\s` and `trim` also take NBSP.
const normalizeSpace = (value: string) => value.replace(/[ \t\n\r]+/g, " ").replace(/^ | $/g, "");

let extensionsRegistered = false;
const registerExtensions = () => {
  if (extensionsRegistered) return;
  extensionsRegistered = true;
  // XSLT's current() is the rule's context node, passed through fontoxpath's currentContext.
  registerCustomXPathFunction(
    { namespaceURI: EXTENSIONS_NS, localName: "current" },
    [],
    "item()?",
    ({ currentContext }: { readonly currentContext: { readonly node: unknown } }) =>
      currentContext.node,
  );
  const resolve = (base: string, relative: string | null) => {
    if (relative === null) return null;
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  };
  // fontoxpath lacks the three-argument fn:matches; XPath regexes are close enough to JavaScript's.
  // XPath allows escapes like `\-` that JavaScript rejects in Unicode mode, so retry without it.
  const matches = (input: string | null, pattern: string, flags = "") => {
    const options = flags.replace(/[^ims]/g, "");
    for (const mode of [`u${options}`, options]) {
      try {
        return new RegExp(pattern, mode).test(input ?? "");
      } catch {
        // Try the next mode.
      }
    }
    return false;
  };
  registerCustomXPathFunction(
    { namespaceURI: EXTENSIONS_NS, localName: "matches" },
    ["xs:string?", "xs:string"],
    "xs:boolean",
    (_: unknown, input: string | null, pattern: string) => matches(input, pattern),
  );
  registerCustomXPathFunction(
    { namespaceURI: EXTENSIONS_NS, localName: "matches" },
    ["xs:string?", "xs:string", "xs:string"],
    "xs:boolean",
    (_: unknown, input: string | null, pattern: string, flags: string) =>
      matches(input, pattern, flags),
  );
  // fontoxpath's normalize-space strips JavaScript whitespace, NBSP included.
  registerCustomXPathFunction(
    { namespaceURI: EXTENSIONS_NS, localName: "normalize-space" },
    ["xs:string?"],
    "xs:string",
    (_: unknown, value: string | null) => normalizeSpace(value ?? ""),
  );
  registerCustomXPathFunction(
    { namespaceURI: EXTENSIONS_NS, localName: "resolve-uri" },
    ["xs:string?"],
    "xs:string?",
    (
      { currentContext }: { readonly currentContext: { readonly base: string } },
      relative: string | null,
    ) => resolve(currentContext.base, relative),
  );
  registerCustomXPathFunction(
    { namespaceURI: EXTENSIONS_NS, localName: "resolve-uri" },
    ["xs:string?", "xs:string"],
    "xs:string?",
    (_: unknown, relative: string | null, base: string) => resolve(base, relative),
  );
};

// Applies `transform` to the parts of an XPath expression outside string literals.
const outsideLiterals = (expression: string, transform: (code: string) => string) =>
  expression
    .split(/("[^"]*"|'[^']*')/)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join("");

// fontoxpath turns JavaScript arrays into XPath arrays, so Schematron lets (always arrays
// here) are referenced as `($name?*)` to get the sequence back. XPath's own `for`/`some`
// variables are left alone.
const rewrite = (expression: string, lets: Readonly<Record<string, unknown>> = {}) =>
  outsideLiterals(expression, (code) =>
    code
      .replace(/(?<![\w:-])current\(\s*\)/g, `Q{${EXTENSIONS_NS}}current()`)
      .replace(/(?<![\w:-])resolve-uri\(/g, `Q{${EXTENSIONS_NS}}resolve-uri(`)
      .replace(/(?<![\w:-])matches\(/g, `Q{${EXTENSIONS_NS}}matches(`)
      // Upstream's processor takes the first text node here, as XPath 1.0 would; XPath 2.0
      // rejects a sequence of several.
      .replace(/(?<![\w:-])normalize-space\(text\(\)\)/g, "normalize-space(text()[1])")
      .replace(
        /(?<![\w:}-])normalize-space\(\s*\)/g,
        `Q{${EXTENSIONS_NS}}normalize-space(string(.))`,
      )
      .replace(/(?<![\w:}-])normalize-space\(/g, `Q{${EXTENSIONS_NS}}normalize-space(`)
      // fontoxpath binds `math` to its math functions before asking the resolver; the schemas
      // only use it for MathML names.
      .replace(/(?<![\w:.-])math:(?=[A-Za-z_*])/g, `Q{${MATHML_NS}}`)
      .replace(/\$([A-Za-z_][\w.-]*)/g, (match, name: string) =>
        name in lets ? `($${name}?*)` : match,
      ),
  );

const substituteParams = (text: string, params: ReadonlyMap<string, string>) => {
  if (params.size === 0) return text;
  const names = [...params.keys()].sort((a, b) => b.length - a.length);
  return text.replace(
    new RegExp(
      `\\$(${names.map((name) => name.replace(/[.\\-]/g, "\\$&")).join("|")})(?![\\w.-])`,
      "g",
    ),
    (_, name: string) => params.get(name) ?? "",
  );
};

const parseMessage = (element: Xml.XmlElement, params: ReadonlyMap<string, string>) => {
  const parts: Array<MessagePart> = [];
  const visit = (node: Xml.XmlNode) => {
    if (node.kind === "text") {
      parts.push({ kind: "text", text: node.text });
      return;
    }
    if ((isSchematron(node.ns) || node.ns === XSL_NS) && node.local === "value-of") {
      parts.push({
        kind: "value-of",
        select: substituteParams(Xml.attribute(node, "select") ?? "", params),
      });
      return;
    }
    if (isSchematron(node.ns) && node.local === "name") {
      const path = Xml.attribute(node, "path");
      parts.push({
        kind: "name",
        path: path === undefined ? undefined : substituteParams(path, params),
      });
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return parts;
};

const childrenNamed = (element: Xml.XmlElement, local: string) =>
  Xml.childElements(element).filter((child) => isSchematron(child.ns) && child.local === local);

const parseLets = (element: Xml.XmlElement, params: ReadonlyMap<string, string>) =>
  childrenNamed(element, "let").map((child) => ({
    name: Xml.attribute(child, "name") ?? "",
    value: substituteParams(Xml.attribute(child, "value") ?? "", params),
  }));

const parsePattern = (
  element: Xml.XmlElement,
  params: ReadonlyMap<string, string>,
): PatternDef => ({
  id: Xml.attribute(element, "id"),
  lets: parseLets(element, params),
  rules: childrenNamed(element, "rule").map((rule) => ({
    context: substituteParams(Xml.attribute(rule, "context") ?? "", params),
    lets: parseLets(rule, params),
    checks: Xml.childElements(rule)
      .filter(
        (child) => isSchematron(child.ns) && (child.local === "assert" || child.local === "report"),
      )
      .map((child) => ({
        kind: child.local === "assert" ? ("assert" as const) : ("report" as const),
        test: substituteParams(Xml.attribute(child, "test") ?? "", params),
        message: parseMessage(child, params),
      })),
  })),
});

export const parse = (source: string, file: string, read: (path: string) => string | undefined) => {
  const document = Xml.parse(source);
  if (Result.isFailure(document)) return Result.fail(`${file}: ${document.failure.message}`);
  const namespaces: Record<string, string> = {};
  const lets: Array<Let> = [];
  const abstract = new Map<string, Xml.XmlElement>();
  const concrete: Array<Xml.XmlElement> = [];
  const errors: Array<string> = [];

  const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const resolveHref = (href: string) => {
    const parts: Array<string> = [];
    for (const part of `${directory}${href}`.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== "." && part !== "") parts.push(part);
    }
    return parts.join("/");
  };

  const collect = (element: Xml.XmlElement) => {
    for (const child of Xml.childElements(element)) {
      if (!isSchematron(child.ns)) continue;
      switch (child.local) {
        case "ns":
          namespaces[Xml.attribute(child, "prefix") ?? ""] = Xml.attribute(child, "uri") ?? "";
          break;
        case "let":
          lets.push({
            name: Xml.attribute(child, "name") ?? "",
            value: Xml.attribute(child, "value") ?? "",
          });
          break;
        case "pattern":
          if (Xml.attribute(child, "abstract") === "true")
            abstract.set(Xml.attribute(child, "id") ?? "", child);
          else concrete.push(child);
          break;
        case "include": {
          const href = resolveHref(Xml.attribute(child, "href") ?? "");
          const included = read(href);
          const parsed = included === undefined ? undefined : Xml.parse(included);
          if (parsed === undefined || Result.isFailure(parsed)) {
            errors.push(`cannot include ${href}`);
            break;
          }
          if (parsed.success.root.local === "pattern") concrete.push(parsed.success.root);
          else collect(parsed.success.root);
          break;
        }
        default:
          break;
      }
    }
  };
  collect(document.success.root);
  if (errors.length > 0) return Result.fail(errors.join("; "));

  const patterns = concrete.map((element) => {
    const base = Xml.attribute(element, "is-a");
    if (base === undefined) return parsePattern(element, new Map());
    const params = new Map(
      childrenNamed(element, "param").map((param) => [
        Xml.attribute(param, "name") ?? "",
        Xml.attribute(param, "value") ?? "",
      ]),
    );
    const template = abstract.get(base);
    return template === undefined
      ? { id: Xml.attribute(element, "id"), lets: [], rules: [] }
      : { ...parsePattern(template, params), id: Xml.attribute(element, "id") };
  });
  return Result.succeed({ namespaces, lets, patterns } satisfies SchematronSchema);
};

// Splits an XSLT match pattern on top-level `|` and makes each alternative a descendant search.
const patternToXPath = (pattern: string, lets: Readonly<Record<string, unknown>>) => {
  const alternatives: Array<string> = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === "|" && depth === 0) {
      alternatives.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(pattern.slice(start));
  return alternatives
    .map((alternative) => alternative.trim())
    .map((alternative) => (alternative.startsWith("/") ? alternative : `//${alternative}`))
    .map((alternative) => `(${rewrite(alternative, lets)})`)
    .join(" | ");
};

interface Built {
  readonly document: slimdom.Document;
  readonly origin: WeakMap<slimdom.Node, Xml.XmlElement>;
}

const build = (source: Xml.XmlDocument): Built => {
  const document = new slimdom.Document();
  const origin = new WeakMap<slimdom.Node, Xml.XmlElement>();
  const convert = (element: Xml.XmlElement): slimdom.Element => {
    const node = document.createElementNS(element.ns === "" ? null : element.ns, element.name);
    origin.set(node, element);
    for (const attribute of element.attributes) {
      if (attribute.ns === "http://www.w3.org/2000/xmlns/") continue;
      node.setAttributeNS(
        attribute.ns === "" ? null : attribute.ns,
        attribute.name,
        attribute.value,
      );
    }
    for (const child of element.children) {
      node.appendChild(
        child.kind === "text" ? document.createTextNode(child.text) : convert(child),
      );
    }
    return node;
  };
  document.appendChild(convert(source.root));
  return { document, origin };
};

const locate = (node: slimdom.Node | null, built: Built, fallback: Xml.XmlElement) => {
  let current: slimdom.Node | null = node;
  while (current !== null) {
    if (current instanceof slimdom.Attr) current = current.ownerElement;
    const found = current === null ? undefined : built.origin.get(current);
    if (found !== undefined) return found;
    current = current?.parentNode ?? null;
  }
  return fallback;
};

// Upstream's duplicate-ID idiom, `count($set[@a = current()/@a]) = 1` with both sides optionally
// normalize-space()d, takes quadratic time in fontoxpath; it is answered from value counts.
const UNIQUENESS =
  /^count\(\$([\w.-]+)\[(normalize-space\()?@([\w-]+)\)?\s*=\s*(normalize-space\()?current\(\)\/@([\w-]+)\)?\]\)\s*=\s*1$/;
const uniqueness = new Map<
  string,
  { readonly variable: string; readonly attribute: string; readonly normalize: boolean } | undefined
>();
const valueCounts = new WeakMap<object, Map<string, Map<string, number>>>();

const attributeValue = (node: unknown, attribute: string, normalize: boolean) => {
  if (!(node instanceof slimdom.Element)) return undefined;
  const value = node.getAttribute(attribute);
  if (value === null) return normalize ? "" : undefined;
  return normalize ? normalizeSpace(value) : value;
};

// Undefined when the test is not the idiom, or its variable is not a bound node list.
const isUnique = (test: string, node: unknown, variables: Readonly<Record<string, unknown>>) => {
  if (!uniqueness.has(test)) {
    const match = UNIQUENESS.exec(test.trim());
    const [, variable, left, attribute, right, current] = match ?? [];
    uniqueness.set(
      test,
      variable !== undefined &&
        attribute !== undefined &&
        attribute === current &&
        (left === undefined) === (right === undefined)
        ? { variable, attribute, normalize: left !== undefined }
        : undefined,
    );
  }
  const idiom = uniqueness.get(test);
  const set = idiom === undefined ? undefined : variables[idiom.variable];
  if (idiom === undefined || !Array.isArray(set)) return undefined;
  const key = `${idiom.attribute}|${idiom.normalize}`;
  const byKey = valueCounts.get(set) ?? new Map<string, Map<string, number>>();
  valueCounts.set(set, byKey);
  let counts = byKey.get(key);
  if (counts === undefined) {
    counts = new Map<string, number>();
    for (const member of set) {
      const value = attributeValue(member, idiom.attribute, idiom.normalize);
      if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    byKey.set(key, counts);
  }
  const value = attributeValue(node, idiom.attribute, idiom.normalize);
  return value !== undefined && counts.get(value) === 1;
};

// Upstream's lookup of an item by ID, `/path[normalize-space(@a) = $v]`, scans the path once per
// context node in fontoxpath; it is answered from an index of the path built once per document.
const KEYED_LOOKUP = /^(\/[^[\]$()|]+)\[normalize-space\(@([\w-]+)\)\s*=\s*\$([\w.-]+)\]$/;
const keyedLookups = new Map<
  string,
  { readonly path: string; readonly attribute: string; readonly variable: string } | undefined
>();

// Upstream's repeated-itemref check, `normalize-space(./@a) = preceding-sibling::p/normalize-space(@b)`,
// is quadratic in fontoxpath; it is answered from one pass over the siblings.
const REPEATED =
  /^normalize-space\(\.\/@([\w-]+)\)\s*=\s*preceding-sibling::(?:([\w.-]+):)?([\w.-]+)\/normalize-space\(@([\w-]+)\)$/;
const repetitions = new Map<
  string,
  | {
      readonly attribute: string;
      readonly prefix: string | undefined;
      readonly local: string;
      readonly siblingAttribute: string;
    }
  | undefined
>();

export const validate = (schema: SchematronSchema, source: Xml.XmlDocument, baseUrl: string) => {
  registerExtensions();
  const built = build(source);
  const errors: Array<SchemaError> = [];
  const namespaceResolver = (prefix: string | null) =>
    prefix === null ? null : (schema.namespaces[prefix] ?? null);
  const options = (node: unknown) => ({
    namespaceResolver,
    currentContext: { node, base: baseUrl },
  });

  const indexes = new Map<string, Map<string, Array<slimdom.Node>>>();
  const keyedLookup = (expression: string, variables: Readonly<Record<string, unknown>>) => {
    if (!keyedLookups.has(expression)) {
      const [, path, attribute, variable] = KEYED_LOOKUP.exec(expression.trim()) ?? [];
      keyedLookups.set(
        expression,
        path !== undefined && attribute !== undefined && variable !== undefined
          ? { path, attribute, variable }
          : undefined,
      );
    }
    const idiom = keyedLookups.get(expression);
    const value = idiom === undefined ? undefined : variables[idiom.variable];
    const [key, ...rest] = Array.isArray(value) ? value : [value];
    if (idiom === undefined || typeof key !== "string" || rest.length > 0) return undefined;
    const indexKey = `${idiom.path}|${idiom.attribute}`;
    let index = indexes.get(indexKey);
    if (index === undefined) {
      index = new Map<string, Array<slimdom.Node>>();
      const nodes = evaluateXPathToNodes<slimdom.Node>(
        idiom.path,
        built.document,
        null,
        {},
        options(built.document),
      );
      for (const node of nodes) {
        const value = attributeValue(node, idiom.attribute, true) ?? "";
        index.set(value, [...(index.get(value) ?? []), node]);
      }
      indexes.set(indexKey, index);
    }
    return index.get(key) ?? [];
  };

  const answers = new Map<string, WeakMap<slimdom.Node, boolean>>();
  const isRepeated = (test: string, node: unknown) => {
    if (!repetitions.has(test)) {
      const [, attribute, prefix, local, siblingAttribute] = REPEATED.exec(test.trim()) ?? [];
      repetitions.set(
        test,
        attribute !== undefined && local !== undefined && siblingAttribute !== undefined
          ? { attribute, prefix, local, siblingAttribute }
          : undefined,
      );
    }
    const idiom = repetitions.get(test);
    const parent = node instanceof slimdom.Element ? node.parentElement : null;
    if (idiom === undefined || parent === null || !(node instanceof slimdom.Element)) {
      return undefined;
    }
    const ns = idiom.prefix === undefined ? null : namespaceResolver(idiom.prefix);
    if (idiom.prefix !== undefined && ns === null) return undefined;
    const byNode = answers.get(test) ?? new WeakMap<slimdom.Node, boolean>();
    answers.set(test, byNode);
    if (!byNode.has(node)) {
      const seen = new Set<string>();
      for (const sibling of parent.children) {
        byNode.set(sibling, seen.has(attributeValue(sibling, idiom.attribute, true) ?? ""));
        if (sibling.namespaceURI === ns && sibling.localName === idiom.local) {
          seen.add(attributeValue(sibling, idiom.siblingAttribute, true) ?? "");
        }
      }
    }
    return byNode.get(node);
  };

  const bind = (lets: ReadonlyArray<Let>, context: unknown, variables: Record<string, unknown>) => {
    const bound = { ...variables };
    for (const binding of lets) {
      try {
        bound[binding.name] =
          keyedLookup(binding.value, bound) ??
          evaluateXPath(
            rewrite(binding.value, bound),
            context,
            null,
            bound,
            evaluateXPath.ALL_RESULTS_TYPE,
            options(context),
          );
      } catch {
        bound[binding.name] = [];
      }
    }
    return bound;
  };

  const message = (
    parts: ReadonlyArray<MessagePart>,
    node: slimdom.Node,
    variables: Record<string, unknown>,
  ) =>
    normalizeSpace(
      parts
        .map((part) => {
          if (part.kind === "text") return part.text;
          if (part.kind === "name") {
            if (part.path === undefined)
              return node instanceof slimdom.Element ? node.nodeName : "";
            try {
              return evaluateXPathToString(
                `name((${rewrite(part.path, variables)})[1])`,
                node,
                null,
                variables,
                options(node),
              );
            } catch {
              return "";
            }
          }
          try {
            return evaluateXPathToString(
              rewrite(part.select, variables),
              node,
              null,
              variables,
              options(node),
            );
          } catch {
            return "";
          }
        })
        .join(""),
    );

  // Document order, with attributes right after their element.
  const order = new Map<slimdom.Node, number>();
  const pending: Array<slimdom.Node> = [built.document];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    order.set(node, order.size);
    if (node instanceof slimdom.Element) {
      for (const attribute of node.attributes) order.set(attribute, order.size);
    }
    for (let index = node.childNodes.length - 1; index >= 0; index--) {
      const child = node.childNodes[index];
      if (child !== undefined) pending.push(child);
    }
  }

  // Like Jing, one pass in document order: at each node, every pattern fires the first of its
  // rules whose context matches.
  const globals = bind(schema.lets, built.document, {});
  const firings: Array<{
    readonly node: slimdom.Node;
    readonly pattern: number;
    readonly rule: Rule;
    readonly variables: Record<string, unknown>;
  }> = [];
  for (const [index, pattern] of schema.patterns.entries()) {
    const patternVariables = bind(pattern.lets, built.document, globals);
    const handled = new Set<slimdom.Node>();
    for (const rule of pattern.rules) {
      let nodes: ReadonlyArray<slimdom.Node>;
      try {
        nodes = evaluateXPathToNodes<slimdom.Node>(
          patternToXPath(rule.context, patternVariables),
          built.document,
          null,
          patternVariables,
          options(built.document),
        );
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (handled.has(node)) continue;
        handled.add(node);
        firings.push({ node, pattern: index, rule, variables: patternVariables });
      }
    }
  }
  firings.sort(
    (left, right) =>
      (order.get(left.node) ?? 0) - (order.get(right.node) ?? 0) || left.pattern - right.pattern,
  );
  for (const { node, rule, variables: patternVariables } of firings) {
    const variables = bind(rule.lets, node, patternVariables);
    for (const check of rule.checks) {
      let outcome: boolean;
      try {
        outcome =
          isUnique(check.test, node, variables) ??
          isRepeated(check.test, node) ??
          evaluateXPathToBoolean(
            rewrite(check.test, variables),
            node,
            null,
            variables,
            options(node),
          );
      } catch {
        continue;
      }
      if (check.kind === "assert" ? outcome : !outcome) continue;
      const element = locate(node, built, source.root);
      errors.push({
        message: message(check.message, node, variables),
        line: element.line,
        column: element.column,
      });
    }
  }
  return errors;
};

// Static errors (unknown functions, syntax) in a schema's expressions, which validation would
// otherwise skip silently.
export const staticErrors = (schema: SchematronSchema) => {
  registerExtensions();
  const document = new slimdom.Document();
  const namespaceResolver = (prefix: string | null) =>
    prefix === null ? null : (schema.namespaces[prefix] ?? `urn:undeclared:${prefix}`);
  const errors: Array<string> = [];
  const probe = (expression: string, lets: Readonly<Record<string, unknown>>) => {
    try {
      evaluateXPath(expression, document, null, lets, evaluateXPath.ALL_RESULTS_TYPE, {
        namespaceResolver,
        currentContext: { node: document, base: "file:///" },
      });
    } catch (cause) {
      const message = String(cause).split("\n")[0] ?? "";
      if (/XPST\d{4}/.test(message)) errors.push(`${expression}: ${message}`);
    }
  };
  const bind = (lets: ReadonlyArray<Let>, scope: Record<string, unknown>) => {
    const bound = { ...scope };
    for (const binding of lets) {
      probe(rewrite(binding.value, bound), bound);
      bound[binding.name] = [];
    }
    return bound;
  };
  const globals = bind(schema.lets, {});
  for (const pattern of schema.patterns) {
    const patternLets = bind(pattern.lets, globals);
    for (const rule of pattern.rules) {
      probe(patternToXPath(rule.context, patternLets), patternLets);
      const ruleLets = bind(rule.lets, patternLets);
      for (const check of rule.checks) {
        probe(rewrite(check.test, ruleLets), ruleLets);
        for (const part of check.message)
          if (part.kind === "value-of") probe(rewrite(part.select, ruleLets), ruleLets);
      }
    }
  }
  return errors;
};
