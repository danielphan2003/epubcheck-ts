import type { Datatype, NamespaceContext } from "./Datatypes.ts";
import { isWhitespace } from "./Datatypes.ts";

// RELAX NG patterns and the derivative algorithm from James Clark's "An algorithm for RELAX NG
// validation". Patterns are hash-consed so equal patterns share one object, which keeps the
// memo tables effective and choice normalization cheap.

export type NameClass =
  | { readonly t: "name"; readonly ns: string; readonly local: string }
  | { readonly t: "anyName"; readonly except: NameClass | undefined }
  | { readonly t: "nsName"; readonly ns: string; readonly except: NameClass | undefined }
  | { readonly t: "choice"; readonly a: NameClass; readonly b: NameClass };

export interface QName {
  readonly ns: string;
  readonly local: string;
}

export const containsName = (nc: NameClass, name: QName): boolean => {
  switch (nc.t) {
    case "name":
      return nc.ns === name.ns && nc.local === name.local;
    case "anyName":
      return nc.except === undefined || !containsName(nc.except, name);
    case "nsName":
      return nc.ns === name.ns && (nc.except === undefined || !containsName(nc.except, name));
    case "choice":
      return containsName(nc.a, name) || containsName(nc.b, name);
  }
};

// How specifically a name class matches `name`: 2 by name, 1 by namespace, 0 by any name, and
// -1 when it does not match.
export const nameSpecificity = (nc: NameClass, name: QName): number => {
  if (!containsName(nc, name)) return -1;
  switch (nc.t) {
    case "name":
      return 2;
    case "nsName":
      return 1;
    case "anyName":
      return 0;
    case "choice":
      return Math.max(nameSpecificity(nc.a, name), nameSpecificity(nc.b, name));
  }
};

export const nameClassKey = (nc: NameClass): string => {
  switch (nc.t) {
    case "name":
      return `{${nc.ns}}${nc.local}`;
    case "anyName":
      return `*${nc.except === undefined ? "" : `-(${nameClassKey(nc.except)})`}`;
    case "nsName":
      return `{${nc.ns}}*${nc.except === undefined ? "" : `-(${nameClassKey(nc.except)})`}`;
    case "choice":
      return `(${nameClassKey(nc.a)}|${nameClassKey(nc.b)})`;
  }
};

interface Node {
  readonly id: number;
  readonly nullable: boolean;
}

export type Pattern =
  | (Node & { readonly t: "empty" })
  | (Node & { readonly t: "notAllowed" })
  | (Node & { readonly t: "text" })
  | (Node & { readonly t: "choice"; readonly a: Pattern; readonly b: Pattern })
  | (Node & { readonly t: "interleave"; readonly a: Pattern; readonly b: Pattern })
  | (Node & { readonly t: "group"; readonly a: Pattern; readonly b: Pattern })
  | (Node & { readonly t: "after"; readonly a: Pattern; readonly b: Pattern })
  | (Node & { readonly t: "oneOrMore"; readonly p: Pattern })
  | (Node & { readonly t: "list"; readonly p: Pattern })
  | (Node & { readonly t: "data"; readonly dt: Datatype; readonly except: Pattern | undefined })
  | (Node & {
      readonly t: "value";
      readonly dt: Datatype;
      readonly value: string;
      readonly context: NamespaceContext;
    })
  | (Node & { readonly t: "attribute"; readonly nc: NameClass; readonly p: Pattern })
  | (Node & { readonly t: "element"; readonly nc: NameClass; readonly content: () => Pattern });

type Distribute<T> = T extends unknown ? Omit<T, "id" | "nullable"> : never;
type Shape = Distribute<Pattern>;

export class PatternBuilder {
  private readonly table = new Map<string, Pattern>();
  private readonly choiceMemo = new Map<string, Pattern>();
  private next = 0;
  readonly empty: Pattern;
  readonly notAllowed: Pattern;
  readonly text: Pattern;

  constructor() {
    this.empty = this.intern("empty", { t: "empty" }, true);
    this.notAllowed = this.intern("notAllowed", { t: "notAllowed" }, false);
    this.text = this.intern("text", { t: "text" }, true);
  }

  private intern(key: string, shape: Shape, nullable: boolean): Pattern {
    const existing = this.table.get(key);
    if (existing !== undefined) return existing;
    const pattern = { ...shape, id: this.next++, nullable } as Pattern;
    this.table.set(key, pattern);
    return pattern;
  }

  choice(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed") return b;
    if (b.t === "notAllowed") return a;
    if (a === b) return a;
    const memoKey = `${a.id},${b.id}`;
    const memo = this.choiceMemo.get(memoKey);
    if (memo !== undefined) return memo;
    // Normalize to a right-nested, id-sorted, duplicate-free list of alternatives.
    const alternatives = new Map<number, Pattern>();
    const collect = (pattern: Pattern) => {
      if (pattern.t === "choice") {
        collect(pattern.a);
        collect(pattern.b);
      } else alternatives.set(pattern.id, pattern);
    };
    collect(a);
    collect(b);
    const sorted = [...alternatives.values()].sort((left, right) => right.id - left.id);
    let result = sorted[0] ?? this.notAllowed;
    for (const pattern of sorted.slice(1)) {
      result = this.intern(
        `choice(${pattern.id},${result.id})`,
        { t: "choice", a: pattern, b: result },
        pattern.nullable || result.nullable,
      );
    }
    this.choiceMemo.set(memoKey, result);
    return result;
  }

  group(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed" || b.t === "notAllowed") return this.notAllowed;
    if (a.t === "empty") return b;
    if (b.t === "empty") return a;
    return this.intern(`group(${a.id},${b.id})`, { t: "group", a, b }, a.nullable && b.nullable);
  }

  interleave(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed" || b.t === "notAllowed") return this.notAllowed;
    if (a.t === "empty") return b;
    if (b.t === "empty") return a;
    const [first, second] = a.id <= b.id ? [a, b] : [b, a];
    return this.intern(
      `interleave(${first.id},${second.id})`,
      { t: "interleave", a: first, b: second },
      a.nullable && b.nullable,
    );
  }

  after(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed" || b.t === "notAllowed") return this.notAllowed;
    return this.intern(`after(${a.id},${b.id})`, { t: "after", a, b }, false);
  }

  oneOrMore(p: Pattern): Pattern {
    if (p.t === "notAllowed" || p.t === "empty") return p;
    return this.intern(`oneOrMore(${p.id})`, { t: "oneOrMore", p }, p.nullable);
  }

  list(p: Pattern): Pattern {
    if (p.t === "notAllowed") return p;
    return this.intern(`list(${p.id})`, { t: "list", p }, false);
  }

  data(dt: Datatype, except: Pattern | undefined): Pattern {
    return this.intern(`data(${dt.key},${except?.id ?? ""})`, { t: "data", dt, except }, false);
  }

  value(dt: Datatype, value: string, context: NamespaceContext): Pattern {
    const normalized = dt.normalize(value);
    // Context-dependent values (QNames) cannot share one interned node across contexts.
    const key = dt.contextDependent
      ? `value#${this.next}`
      : `value(${dt.key},${JSON.stringify(normalized)})`;
    return this.intern(key, { t: "value", dt, value: normalized, context }, false);
  }

  attribute(nc: NameClass, p: Pattern): Pattern {
    return this.intern(`attribute(${nameClassKey(nc)},${p.id})`, { t: "attribute", nc, p }, false);
  }

  // Elements are created once per schema element pattern; `content` resolves recursion lazily.
  element(nc: NameClass, content: () => Pattern): Pattern {
    return this.intern(`element#${this.next}`, { t: "element", nc, content }, false);
  }

  optional(p: Pattern): Pattern {
    return this.choice(p, this.empty);
  }

  zeroOrMore(p: Pattern): Pattern {
    return this.optional(this.oneOrMore(p));
  }
}

// Derivatives, memoized per builder.
export class Derivatives {
  private readonly startTagMemo = new Map<string, Pattern>();
  private readonly closeMemo = new Map<number, Pattern>();
  private readonly endMemo = new Map<number, Pattern>();
  private readonly attributeMemo = new Map<string, Pattern>();
  private readonly leavesMemo = new Map<
    string,
    ReadonlyArray<Pattern & { readonly t: "attribute" }>
  >();
  private readonly forceAttributesMemo = new Map<number, Pattern>();

  readonly builder: PatternBuilder;
  constructor(builder: PatternBuilder) {
    this.builder = builder;
  }

  private applyAfter(p: Pattern, f: (pattern: Pattern) => Pattern): Pattern {
    switch (p.t) {
      case "after":
        return this.builder.after(p.a, f(p.b));
      case "choice":
        return this.builder.choice(this.applyAfter(p.a, f), this.applyAfter(p.b, f));
      default:
        return this.builder.notAllowed;
    }
  }

  startTagOpen(p: Pattern, name: QName): Pattern {
    const key = `${p.id}{${name.ns}}${name.local}`;
    const memo = this.startTagMemo.get(key);
    if (memo !== undefined) return memo;
    const b = this.builder;
    let result: Pattern;
    switch (p.t) {
      case "choice":
        result = b.choice(this.startTagOpen(p.a, name), this.startTagOpen(p.b, name));
        break;
      case "element":
        result = containsName(p.nc, name) ? b.after(p.content(), b.empty) : b.notAllowed;
        break;
      case "interleave":
        result = b.choice(
          this.applyAfter(this.startTagOpen(p.a, name), (x) => b.interleave(x, p.b)),
          this.applyAfter(this.startTagOpen(p.b, name), (x) => b.interleave(p.a, x)),
        );
        break;
      case "oneOrMore":
        result = this.applyAfter(this.startTagOpen(p.p, name), (x) =>
          b.group(x, b.choice(p, b.empty)),
        );
        break;
      case "group": {
        const first = this.applyAfter(this.startTagOpen(p.a, name), (x) => b.group(x, p.b));
        result = p.a.nullable ? b.choice(first, this.startTagOpen(p.b, name)) : first;
        break;
      }
      case "after":
        result = this.applyAfter(this.startTagOpen(p.a, name), (x) => b.after(x, p.b));
        break;
      default:
        result = b.notAllowed;
    }
    this.startTagMemo.set(key, result);
    return result;
  }

  // `value` undefined matches any value: Jing consumes a known attribute even when its value
  // is invalid, so the attribute is not also reported as missing. The value matters only through
  // which `attribute` patterns for `name` accept it, so that set, not the value, keys the memo:
  // memoizing on values would grow without bound across documents.
  attribute(p: Pattern, name: QName, value: string | undefined): Pattern {
    const leaves = this.attributeLeaves(p, name);
    const accepted = leaves
      .filter((leaf) => value === undefined || this.valueMatches(leaf.p, value))
      .map((leaf) => leaf.id);
    return this.attributeAccepting(p, name, new Set(accepted), accepted.join(","));
  }

  // The `attribute` patterns in `p` whose name class contains `name`.
  private attributeLeaves(
    p: Pattern,
    name: QName,
  ): ReadonlyArray<Pattern & { readonly t: "attribute" }> {
    const key = `${p.id}{${name.ns}}${name.local}`;
    const memo = this.leavesMemo.get(key);
    if (memo !== undefined) return memo;
    const leaves = new Map<number, Pattern & { readonly t: "attribute" }>();
    const pending: Array<Pattern> = [p];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || seen.has(current.id)) continue;
      seen.add(current.id);
      switch (current.t) {
        case "after":
        case "choice":
        case "group":
        case "interleave":
          pending.push(current.a, current.b);
          break;
        case "oneOrMore":
          pending.push(current.p);
          break;
        case "attribute":
          if (containsName(current.nc, name)) leaves.set(current.id, current);
          break;
        default:
          break;
      }
    }
    const result = [...leaves.values()].sort((left, right) => left.id - right.id);
    this.leavesMemo.set(key, result);
    return result;
  }

  private attributeAccepting(
    p: Pattern,
    name: QName,
    accepted: ReadonlySet<number>,
    acceptedKey: string,
  ): Pattern {
    const key = `${p.id}{${name.ns}}${name.local}=${acceptedKey}`;
    const memo = this.attributeMemo.get(key);
    if (memo !== undefined) return memo;
    const b = this.builder;
    const next = (child: Pattern) => this.attributeAccepting(child, name, accepted, acceptedKey);
    let result: Pattern;
    switch (p.t) {
      case "after":
        result = b.after(next(p.a), p.b);
        break;
      case "choice":
        result = b.choice(next(p.a), next(p.b));
        break;
      case "group":
        result = b.choice(b.group(next(p.a), p.b), b.group(p.a, next(p.b)));
        break;
      case "interleave":
        result = b.choice(b.interleave(next(p.a), p.b), b.interleave(p.a, next(p.b)));
        break;
      case "oneOrMore":
        result = b.group(next(p.p), b.choice(p, b.empty));
        break;
      case "attribute":
        result = accepted.has(p.id) ? b.empty : b.notAllowed;
        break;
      default:
        result = b.notAllowed;
    }
    this.attributeMemo.set(key, result);
    return result;
  }

  valueMatches(p: Pattern, value: string): boolean {
    return (p.nullable && isWhitespace(value)) || this.text(p, value).nullable;
  }

  text(p: Pattern, value: string): Pattern {
    const b = this.builder;
    switch (p.t) {
      case "choice":
        return b.choice(this.text(p.a, value), this.text(p.b, value));
      case "interleave":
        return b.choice(
          b.interleave(this.text(p.a, value), p.b),
          b.interleave(p.a, this.text(p.b, value)),
        );
      case "group": {
        const first = b.group(this.text(p.a, value), p.b);
        return p.a.nullable ? b.choice(first, this.text(p.b, value)) : first;
      }
      case "after":
        return b.after(this.text(p.a, value), p.b);
      case "oneOrMore":
        return b.group(this.text(p.p, value), b.choice(p, b.empty));
      case "text":
        return p;
      case "value":
        return p.dt.normalize(value) === p.value && p.dt.validate(value, p.context) === undefined
          ? b.empty
          : b.notAllowed;
      case "data":
        if (p.dt.validate(value, emptyContext) !== undefined) return b.notAllowed;
        return p.except !== undefined && this.text(p.except, value).nullable
          ? b.notAllowed
          : b.empty;
      case "list": {
        const tokens = value.split(/[\t\n\r ]+/).filter((token) => token !== "");
        let state = p.p;
        for (const token of tokens) state = this.text(state, token);
        return state.nullable ? b.empty : b.notAllowed;
      }
      default:
        return b.notAllowed;
    }
  }

  startTagClose(p: Pattern): Pattern {
    const memo = this.closeMemo.get(p.id);
    if (memo !== undefined) return memo;
    const b = this.builder;
    let result: Pattern;
    switch (p.t) {
      case "after":
        result = b.after(this.startTagClose(p.a), p.b);
        break;
      case "choice":
        result = b.choice(this.startTagClose(p.a), this.startTagClose(p.b));
        break;
      case "group":
        result = b.group(this.startTagClose(p.a), this.startTagClose(p.b));
        break;
      case "interleave":
        result = b.interleave(this.startTagClose(p.a), this.startTagClose(p.b));
        break;
      case "oneOrMore":
        result = b.oneOrMore(this.startTagClose(p.p));
        break;
      case "attribute":
        result = b.notAllowed;
        break;
      default:
        result = p;
    }
    this.closeMemo.set(p.id, result);
    return result;
  }

  // Recovery for missing required attributes: drop every attribute pattern still pending.
  forceAttributes(p: Pattern): Pattern {
    const memo = this.forceAttributesMemo.get(p.id);
    if (memo !== undefined) return memo;
    const b = this.builder;
    let result: Pattern;
    switch (p.t) {
      case "after":
        result = b.after(this.forceAttributes(p.a), p.b);
        break;
      case "choice":
        result = b.choice(this.forceAttributes(p.a), this.forceAttributes(p.b));
        break;
      case "group":
        result = b.group(this.forceAttributes(p.a), this.forceAttributes(p.b));
        break;
      case "interleave":
        result = b.interleave(this.forceAttributes(p.a), this.forceAttributes(p.b));
        break;
      case "oneOrMore":
        result = b.oneOrMore(this.forceAttributes(p.p));
        break;
      case "attribute":
        result = b.empty;
        break;
      default:
        result = p;
    }
    this.forceAttributesMemo.set(p.id, result);
    return result;
  }

  // The value patterns of the attribute declarations matching `name` that `p` still allows.
  attributeValuePatterns(p: Pattern, name: QName): Pattern {
    const b = this.builder;
    switch (p.t) {
      case "choice":
      case "group":
      case "interleave":
        return b.choice(
          this.attributeValuePatterns(p.a, name),
          this.attributeValuePatterns(p.b, name),
        );
      case "after":
        return this.attributeValuePatterns(p.a, name);
      case "oneOrMore":
        return this.attributeValuePatterns(p.p, name);
      case "attribute":
        return containsName(p.nc, name) ? p.p : b.notAllowed;
      default:
        return b.notAllowed;
    }
  }

  endTag(p: Pattern): Pattern {
    const memo = this.endMemo.get(p.id);
    if (memo !== undefined) return memo;
    const b = this.builder;
    let result: Pattern;
    switch (p.t) {
      case "choice":
        result = b.choice(this.endTag(p.a), this.endTag(p.b));
        break;
      case "after":
        result = p.a.nullable ? p.b : b.notAllowed;
        break;
      default:
        result = b.notAllowed;
    }
    this.endMemo.set(p.id, result);
    return result;
  }

  // Recovery for incomplete content: accept the end tag regardless of what is still required.
  forceEndTag(p: Pattern): Pattern {
    const b = this.builder;
    switch (p.t) {
      case "choice":
        return b.choice(this.forceEndTag(p.a), this.forceEndTag(p.b));
      case "after":
        return p.b;
      default:
        return b.notAllowed;
    }
  }
}

const emptyContext: NamespaceContext = { resolve: () => undefined };
