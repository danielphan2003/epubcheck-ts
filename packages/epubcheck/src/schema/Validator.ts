import * as Xml from "../xml/Xml.ts";
import { isWhitespace } from "./Datatypes.ts";
import type { CompiledSchema } from "./Grammar.ts";
import { containsName, Derivatives, type NameClass, type Pattern, type QName } from "./Pattern.ts";

// Validates a parsed document against a compiled RELAX NG schema, reporting errors with the
// wording and recovery of Jing, which upstream EPUBCheck uses (messages from Jing's
// relaxng/pattern/resources/Messages.properties).

export interface SchemaError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

const XMLNS = "http://www.w3.org/2000/xmlns/";

const orList = (items: ReadonlyArray<string>) => {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
};

const andList = (items: ReadonlyArray<string>) => {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
};

type Scope = ReadonlyMap<string, string>;

const scopeOf = (element: Xml.XmlElement, parent: Scope) => {
  const declarations = element.attributes.filter((attribute) => attribute.ns === XMLNS);
  if (declarations.length === 0) return parent;
  const scope = new Map(parent);
  for (const declaration of declarations) {
    scope.set(declaration.prefix === "xmlns" ? declaration.local : "", declaration.value);
  }
  return scope;
};

// Formats schema names relative to the instance's in-scope namespaces, inventing `ns` prefixes
// for undeclared namespaces the way Jing does ("ns1:switch" ... (with xmlns:ns1="...")).
const formatNames = (names: ReadonlyArray<QName>, scope: Scope, attributes: boolean) => {
  const prefixFor = new Map<string, string>();
  for (const [prefix, ns] of scope)
    if (prefix !== "" && !prefixFor.has(ns)) prefixFor.set(ns, prefix);
  const defaultNs = scope.get("") ?? "";
  const unknown = [
    ...new Set(
      names
        .map((name) => name.ns)
        .filter(
          (ns) =>
            ns !== "" && !(ns === defaultNs && !attributes) && !prefixFor.has(ns) && ns !== Xml_NS,
        ),
    ),
  ].sort();
  const generated = new Map(
    unknown.map((ns, index) => [ns, unknown.length === 1 ? "ns" : `ns${index + 1}`]),
  );
  const format = (name: QName) => {
    if (name.ns === "") return `"${name.local}"`;
    if (name.ns === Xml_NS) return `"xml:${name.local}"`;
    if (!attributes && name.ns === defaultNs) return `"${name.local}"`;
    return `"${prefixFor.get(name.ns) ?? generated.get(name.ns) ?? ""}:${name.local}"`;
  };
  const formatted = [...new Set(names.map(format))].sort();
  const suffix =
    generated.size === 0
      ? ""
      : ` (with ${[...generated].map(([ns, prefix]) => `xmlns:${prefix}="${ns}"`).join(" ")})`;
  return { formatted, suffix };
};

const Xml_NS = "http://www.w3.org/XML/1998/namespace";

const nameClassNames = (nc: NameClass, into: Array<QName>): boolean => {
  switch (nc.t) {
    case "name":
      into.push({ ns: nc.ns, local: nc.local });
      return false;
    case "choice": {
      const a = nameClassNames(nc.a, into);
      const b = nameClassNames(nc.b, into);
      return a || b;
    }
    default:
      return true;
  }
};

const hasNsName = (nc: NameClass): boolean =>
  nc.t === "nsName" || (nc.t === "choice" && (hasNsName(nc.a) || hasNsName(nc.b)));

interface Possible {
  readonly names: Array<QName>;
  wildcard: boolean;
}

const collect = (
  p: Pattern,
  kind: "element" | "attribute",
  into: Possible,
  seen = new Set<number>(),
) => {
  if (seen.has(p.id)) return;
  seen.add(p.id);
  switch (p.t) {
    case "choice":
    case "interleave":
      collect(p.a, kind, into, seen);
      collect(p.b, kind, into, seen);
      break;
    case "group":
      collect(p.a, kind, into, seen);
      if (p.a.nullable || kind === "attribute") collect(p.b, kind, into, seen);
      break;
    case "after":
      collect(p.a, kind, into, seen);
      break;
    case "oneOrMore":
      collect(p.p, kind, into, seen);
      break;
    case "element":
      // Jing mentions "an element from another namespace" only for namespace wildcards.
      if (kind === "element" && nameClassNames(p.nc, into.names) && hasNsName(p.nc))
        into.wildcard = true;
      break;
    case "attribute":
      if (kind === "attribute" && nameClassNames(p.nc, into.names)) into.wildcard = true;
      break;
    default:
      break;
  }
};

const possible = (p: Pattern, kind: "element" | "attribute") => {
  const into: Possible = { names: [], wildcard: false };
  collect(p, kind, into);
  return into;
};

const nameKey = (name: QName) => `{${name.ns}}${name.local}`;

// Element names every completion of `p` must contain (Jing's "missing required element").
const requiredElements = (
  p: Pattern,
  memo = new Map<number, ReadonlyMap<string, QName>>(),
): ReadonlyMap<string, QName> => {
  const cached = memo.get(p.id);
  if (cached !== undefined) return cached;
  memo.set(p.id, new Map());
  let result: ReadonlyMap<string, QName>;
  switch (p.t) {
    case "choice": {
      const a = requiredElements(p.a, memo);
      const b = requiredElements(p.b, memo);
      result = new Map([...a].filter(([key]) => b.has(key)));
      break;
    }
    case "group":
    case "interleave":
      result = new Map([...requiredElements(p.a, memo), ...requiredElements(p.b, memo)]);
      break;
    case "oneOrMore":
      result = requiredElements(p.p, memo);
      break;
    case "after":
      result = requiredElements(p.a, memo);
      break;
    case "element":
      result =
        p.nc.t === "name"
          ? new Map([[nameKey(p.nc), { ns: p.nc.ns, local: p.nc.local }]])
          : new Map();
      break;
    default:
      result = new Map();
  }
  memo.set(p.id, result);
  return result;
};

const requiredAttributes = (p: Pattern): ReadonlyMap<string, QName> => {
  switch (p.t) {
    case "choice": {
      const a = requiredAttributes(p.a);
      const b = requiredAttributes(p.b);
      return new Map([...a].filter(([key]) => b.has(key)));
    }
    case "group":
    case "interleave":
      return new Map([...requiredAttributes(p.a), ...requiredAttributes(p.b)]);
    case "oneOrMore":
      return requiredAttributes(p.p);
    case "after":
      return requiredAttributes(p.a);
    case "attribute":
      return p.nc.t === "name"
        ? new Map([[nameKey(p.nc), { ns: p.nc.ns, local: p.nc.local }]])
        : new Map();
    default:
      return new Map();
  }
};

// Collects the data and value patterns text could match, for "must be ..." details.
const textTargets = (p: Pattern, into: Array<Pattern>, seen = new Set<number>()) => {
  if (seen.has(p.id)) return;
  seen.add(p.id);
  switch (p.t) {
    case "choice":
    case "interleave":
      textTargets(p.a, into, seen);
      textTargets(p.b, into, seen);
      break;
    case "group":
      textTargets(p.a, into, seen);
      if (p.a.nullable) textTargets(p.b, into, seen);
      break;
    case "after":
      textTargets(p.a, into, seen);
      break;
    case "oneOrMore":
    case "list":
      textTargets(p.p, into, seen);
      break;
    case "data":
    case "value":
      into.push(p);
      break;
    default:
      break;
  }
};

const textDetail = (p: Pattern, value: string) => {
  const targets: Array<Pattern> = [];
  textTargets(p, targets);
  const values = targets.flatMap((target) => (target.t === "value" ? [`"${target.value}"`] : []));
  const failures = targets.flatMap((target) => {
    if (target.t !== "data") return [];
    const failure = target.dt.validate(value, { resolve: () => undefined });
    return failure === undefined ? [] : [failure];
  });
  if (values.length > 0 && failures.length === 0) return `; must be equal to ${orList(values)}`;
  if (failures.length > 0) return `; ${[...new Set(failures)].join(", ")}`;
  return "";
};

const hasTextTarget = (p: Pattern) => {
  const targets: Array<Pattern> = [];
  textTargets(p, targets);
  return targets.length > 0;
};

const allowsText = (p: Pattern, seen = new Set<number>()): boolean => {
  if (seen.has(p.id)) return false;
  seen.add(p.id);
  switch (p.t) {
    case "text":
    case "data":
    case "value":
    case "list":
      return true;
    case "choice":
    case "interleave":
      return allowsText(p.a, seen) || allowsText(p.b, seen);
    case "group":
      return allowsText(p.a, seen) || (p.a.nullable && allowsText(p.b, seen));
    case "after":
      return allowsText(p.a, seen);
    case "oneOrMore":
      return allowsText(p.p, seen);
    default:
      return false;
  }
};

export class SchemaValidator {
  private readonly derivatives: Derivatives;
  private allElements: ReadonlyArray<Pattern & { readonly t: "element" }> | undefined;

  private readonly schema: CompiledSchema;

  constructor(schema: CompiledSchema) {
    this.schema = schema;
    this.derivatives = new Derivatives(schema.builder);
  }

  // Every element pattern, wildcards included, whose name class contains `name`.
  private declarations(name: QName) {
    return this.elementsInSchema().filter((candidate) => containsName(candidate.nc, name));
  }

  private anyTextContent() {
    const b = this.schema.builder;
    return b.interleave(
      b.text,
      b.zeroOrMore(b.attribute({ t: "anyName", except: undefined }, b.text)),
    );
  }

  private elementsInSchema() {
    if (this.allElements !== undefined) return this.allElements;
    const found: Array<Pattern & { readonly t: "element" }> = [];
    const seen = new Set<number>();
    const stack: Array<Pattern> = [this.schema.start];
    while (stack.length > 0) {
      const p = stack.pop();
      if (p === undefined || seen.has(p.id)) continue;
      seen.add(p.id);
      switch (p.t) {
        case "choice":
        case "interleave":
        case "group":
        case "after":
          stack.push(p.a, p.b);
          break;
        case "oneOrMore":
        case "list":
        case "attribute":
          stack.push(p.p);
          break;
        case "data":
          if (p.except !== undefined) stack.push(p.except);
          break;
        case "element":
          found.push(p);
          stack.push(p.content());
          break;
        default:
          break;
      }
    }
    this.allElements = found;
    return found;
  }

  validate(document: Xml.XmlDocument) {
    const errors: Array<SchemaError> = [];
    const report = (message: string, element: Xml.XmlElement) =>
      errors.push({ message, line: element.line, column: element.column });
    // Errors found at the end tag, such as incomplete content, are located there.
    const reportAtEnd = (message: string, element: Xml.XmlElement) =>
      errors.push({ message, line: element.endLine, column: element.endColumn });
    const d = this.derivatives;
    const b = this.schema.builder;

    const expected = (p: Pattern, scope: Scope, includeEnd: boolean) => {
      const items: Array<string> = [];
      if (includeEnd && d.endTag(p).t !== "notAllowed") items.push("the element end-tag");
      if (allowsText(p)) items.push("text");
      const elements = possible(p, "element");
      if (elements.names.length > 0) {
        const { formatted, suffix } = formatNames(elements.names, scope, false);
        items.push(`element ${orList(formatted)}${suffix}`);
      }
      if (elements.wildcard) items.push("an element from another namespace");
      return items.length === 0 ? "" : `; expected ${orList(items)}`;
    };

    const elementName = (element: Xml.XmlElement) => `"${element.name}"`;

    const startTagError = (
      p: Pattern,
      element: Xml.XmlElement,
      scope: Scope,
      unknownParent: boolean,
    ) => {
      const name = { ns: element.ns, local: element.local };
      const anywhere = this.declarations(name).length > 0;
      // Inside an undeclared element, Jing stays silent about other undeclared elements.
      if (!anywhere && unknownParent) return undefined;
      if (!anywhere && element !== document.root) {
        report(
          `element ${elementName(element)} not allowed anywhere${expected(p, scope, true)}`,
          element,
        );
        return undefined;
      }
      const missing = [...requiredElements(p).values()];
      for (const required of missing) {
        const afterRequired = skipElement(p, required);
        const resumed = d.startTagOpen(afterRequired, name);
        if (resumed.t !== "notAllowed") {
          const { formatted } = formatNames([required], scope, false);
          report(
            `element ${elementName(element)} not allowed yet; missing required element ${formatted[0] ?? ""}`,
            element,
          );
          // Jing resumes as if the missing element had been there.
          return resumed;
        }
      }
      const nextNames = possible(p, "element").names;
      const allowedLater = nextNames.some(
        (next) => d.startTagOpen(skipElement(p, next), name).t !== "notAllowed",
      );
      if (allowedLater) {
        report(
          `element ${elementName(element)} not allowed yet${expected(p, scope, false)}`,
          element,
        );
        return undefined;
      }
      report(
        `element ${elementName(element)} not allowed here${expected(p, scope, true)}`,
        element,
      );
      return undefined;
    };

    // The state after a complete `name` element, whatever its content.
    const skipElement = (p: Pattern, name: QName) =>
      d.forceEndTag(d.startTagClose(d.forceAttributes(d.startTagOpen(p, name))));

    const validateChildren = (
      p: Pattern,
      element: Xml.XmlElement,
      scope: Scope,
      unknown: boolean,
    ): Pattern => {
      let state = p;
      const children = element.children;
      if (children.length === 0) {
        const withEmpty = d.text(state, "");
        return b.choice(state, withEmpty);
      }
      for (const child of children) {
        if (child.kind === "element") {
          state = validateElement(state, child, scope, unknown);
          continue;
        }
        if (isWhitespace(child.text)) {
          state = b.choice(state, d.text(state, child.text));
          continue;
        }
        const next = d.text(state, child.text);
        if (next.t === "notAllowed") {
          const onlyText = children.every((other) => other.kind === "text");
          if (onlyText && hasTextTarget(state)) {
            report(
              `character content of element ${elementName(element)} invalid${textDetail(state, child.text)}`,
              element,
            );
          } else {
            report(`text not allowed here${expected(state, scope, true)}`, element);
          }
          continue;
        }
        state = next;
      }
      return state;
    };

    const validateAttributes = (p: Pattern, element: Xml.XmlElement, scope: Scope) => {
      let state = p;
      for (const attribute of element.attributes) {
        if (attribute.ns === XMLNS) continue;
        const name = { ns: attribute.ns, local: attribute.local };
        const next = d.attribute(state, name, attribute.value);
        if (next.t !== "notAllowed") {
          state = next;
          continue;
        }
        const candidates = possible(state, "attribute");
        const known = candidates.names.some(
          (candidate) => candidate.ns === name.ns && candidate.local === name.local,
        );
        if (known) {
          const values = d.attributeValuePatterns(state, name);
          report(
            `value of attribute "${attribute.name}" is invalid${textDetail(values, attribute.value)}`,
            element,
          );
          state = d.attribute(state, name, undefined);
        } else if (candidates.names.length === 0 && !candidates.wildcard) {
          report(`found attribute "${attribute.name}", but no attributes allowed here`, element);
        } else {
          const { formatted, suffix } = formatNames(candidates.names, scope, true);
          const list = formatted.length === 0 ? "" : `attribute ${orList(formatted)}${suffix}`;
          const detail =
            list === ""
              ? ""
              : candidates.wildcard
                ? `; expected ${list} or an attribute from another namespace`
                : `; expected ${list}`;
          report(`attribute "${attribute.name}" not allowed here${detail}`, element);
        }
      }
      return state;
    };

    const validateElement = (
      p: Pattern,
      element: Xml.XmlElement,
      parentScope: Scope,
      unknownParent: boolean,
    ): Pattern => {
      const scope = scopeOf(element, parentScope);
      const name = { ns: element.ns, local: element.local };
      const opened = d.startTagOpen(p, name);
      if (opened.t === "notAllowed") {
        const resumed = startTagError(p, element, parentScope, unknownParent);
        if (resumed !== undefined) return validateContent(resumed, element, scope, false);
        // Recover like Jing: check the element against every declaration of its name (or, if
        // there is none, allow only text and attributes), then carry on as if it were absent.
        const declarations = this.declarations(name);
        const content =
          declarations.length > 0
            ? declarations.map((candidate) => candidate.content()).reduce((x, y) => b.choice(x, y))
            : this.anyTextContent();
        validateContent(b.after(content, b.empty), element, scope, declarations.length === 0);
        return p;
      }
      return validateContent(opened, element, scope, false);
    };

    const validateContent = (
      opened: Pattern,
      element: Xml.XmlElement,
      scope: Scope,
      unknown: boolean,
    ) => {
      const attributed = validateAttributes(opened, element, scope);
      let closed = d.startTagClose(attributed);
      if (closed.t === "notAllowed") {
        const missing = [...requiredAttributes(attributed).values()];
        const { formatted } = formatNames(missing, scope, true);
        if (formatted.length === 1) {
          report(
            `element ${elementName(element)} missing required attribute ${formatted[0] ?? ""}`,
            element,
          );
        } else if (formatted.length > 1) {
          report(
            `element ${elementName(element)} missing required attributes ${andList(formatted)}`,
            element,
          );
        } else {
          report(
            `element ${elementName(element)} missing one or more required attributes`,
            element,
          );
        }
        closed = d.startTagClose(d.forceAttributes(attributed));
      }
      const content = validateChildren(closed, element, scope, unknown);
      const ended = d.endTag(content);
      if (ended.t !== "notAllowed") return ended;
      const missing = [...requiredElements(content).values()];
      const childElements = element.children.some((child) => child.kind === "element");
      if (!childElements && hasTextTarget(content) && missing.length === 0) {
        const text = Xml.textContent(element);
        reportAtEnd(
          `character content of element ${elementName(element)} invalid${textDetail(content, text)}`,
          element,
        );
      } else if (missing.length === 1) {
        const { formatted } = formatNames(missing, scope, false);
        reportAtEnd(
          `element ${elementName(element)} incomplete; missing required element ${formatted[0] ?? ""}`,
          element,
        );
      } else if (missing.length > 1) {
        const { formatted } = formatNames(missing, scope, false);
        reportAtEnd(
          `element ${elementName(element)} incomplete; missing required elements ${andList(formatted)}`,
          element,
        );
      } else {
        reportAtEnd(
          `element ${elementName(element)} incomplete${expected(content, scope, false)}`,
          element,
        );
      }
      return d.forceEndTag(content);
    };

    const rootScope: Scope = new Map([["", ""]]);
    validateElement(this.schema.start, document.root, rootScope, false);
    return errors;
  }
}
