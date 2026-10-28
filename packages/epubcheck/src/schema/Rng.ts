import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import type { Ast, Combine, Component, NameClassAst, Param } from "./Ast.ts";

// A parser for the RELAX NG XML syntax, producing the same tree as the compact-syntax parser.
// `ns` and `datatypeLibrary` inherit down the tree; foreign-namespace annotations are skipped.

const RNG_NS = "http://relaxng.org/ns/structure/1.0";

interface Context {
  readonly ns: string;
  readonly library: string;
  readonly prefixes: Readonly<Record<string, string>>;
}

const rngChildren = (element: Xml.XmlElement) =>
  Xml.childElements(element).filter((child) => child.ns === RNG_NS);

const contextFor = (element: Xml.XmlElement, parent: Context): Context => {
  const declared = element.attributes.filter(
    (attribute) => attribute.ns === "http://www.w3.org/2000/xmlns/",
  );
  const prefixes =
    declared.length === 0
      ? parent.prefixes
      : {
          ...parent.prefixes,
          ...Object.fromEntries(
            declared.map((attribute) => [
              attribute.prefix === "xmlns" ? attribute.local : "",
              attribute.value,
            ]),
          ),
        };
  return {
    ns: Xml.attribute(element, "ns") ?? parent.ns,
    library: Xml.attribute(element, "datatypeLibrary") ?? parent.library,
    prefixes,
  };
};

const qname = (text: string, context: Context, isAttribute: boolean): NameClassAst => {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return { kind: "name", ns: isAttribute ? "" : context.ns, local: trimmed };
  return {
    kind: "name",
    ns: context.prefixes[trimmed.slice(0, colon)] ?? "",
    local: trimmed.slice(colon + 1),
  };
};

const nameClass = (
  element: Xml.XmlElement,
  parent: Context,
  isAttribute: boolean,
): NameClassAst => {
  const context = contextFor(element, parent);
  const except = () => {
    const exceptElement = rngChildren(element).find((child) => child.local === "except");
    if (exceptElement === undefined) return undefined;
    const items = rngChildren(exceptElement).map((child) => nameClass(child, context, isAttribute));
    return items.length === 1 ? items[0] : { kind: "choice" as const, items };
  };
  switch (element.local) {
    case "name":
      return qname(Xml.textContent(element), context, isAttribute);
    case "anyName":
      return { kind: "anyName", except: except() };
    case "nsName":
      return { kind: "nsName", ns: context.ns, except: except() };
    default:
      return {
        kind: "choice",
        items: rngChildren(element).map((child) => nameClass(child, context, isAttribute)),
      };
  }
};

const group = (items: ReadonlyArray<Ast>): Ast =>
  items.length === 1 ? (items[0] ?? { kind: "empty" }) : { kind: "group", items };

const patterns = (element: Xml.XmlElement, context: Context) =>
  rngChildren(element).map((child) => pattern(child, context));

const pattern = (element: Xml.XmlElement, parent: Context): Ast => {
  const context = contextFor(element, parent);
  switch (element.local) {
    case "element":
    case "attribute": {
      const isAttribute = element.local === "attribute";
      const nameAttribute = Xml.attribute(element, "name");
      const children = rngChildren(element);
      // A `name` attribute on `attribute` takes only an explicit `ns`, never an inherited one.
      const name =
        nameAttribute === undefined
          ? nameClass(children[0] ?? element, context, isAttribute)
          : isAttribute && Xml.attribute(element, "ns") !== undefined
            ? qname(nameAttribute, context, false)
            : qname(nameAttribute, context, isAttribute);
      const bodyElements = nameAttribute === undefined ? children.slice(1) : children;
      const body = bodyElements.map((child) => pattern(child, context));
      return {
        kind: element.local,
        name,
        body: body.length === 0 && isAttribute ? { kind: "text" } : group(body),
      };
    }
    case "group":
    case "interleave":
    case "choice":
      return { kind: element.local, items: patterns(element, context) };
    case "optional":
    case "zeroOrMore":
    case "oneOrMore":
    case "mixed":
    case "list":
      return { kind: element.local, body: group(patterns(element, context)) };
    case "ref":
    case "parentRef":
      return { kind: element.local, name: (Xml.attribute(element, "name") ?? "").trim() };
    case "empty":
    case "text":
    case "notAllowed":
      return { kind: element.local };
    case "data": {
      const params: Array<Param> = rngChildren(element)
        .filter((child) => child.local === "param")
        .map((child) => ({
          name: Xml.attribute(child, "name") ?? "",
          value: Xml.textContent(child),
        }));
      const exceptElement = rngChildren(element).find((child) => child.local === "except");
      return {
        kind: "data",
        library: context.library,
        type: (Xml.attribute(element, "type") ?? "").trim(),
        params,
        except:
          exceptElement === undefined
            ? undefined
            : { kind: "choice", items: patterns(exceptElement, context) },
      };
    }
    case "value": {
      const type = Xml.attribute(element, "type");
      return {
        kind: "value",
        library: type === undefined ? "" : context.library,
        type: type?.trim() ?? "token",
        value: Xml.textContent(element),
        namespaces: { ...context.prefixes, "": context.ns },
      };
    }
    case "grammar":
      return { kind: "grammar", components: components(element, context) };
    case "externalRef":
      return {
        kind: "externalRef",
        href: Xml.attribute(element, "href") ?? "",
        defaultNamespace: context.ns,
      };
    default:
      return { kind: "notAllowed" };
  }
};

const components = (element: Xml.XmlElement, parent: Context): ReadonlyArray<Component> =>
  rngChildren(element).flatMap((child): ReadonlyArray<Component> => {
    const context = contextFor(child, parent);
    const combineAttribute = Xml.attribute(child, "combine")?.trim();
    const combine: Combine =
      combineAttribute === "choice" || combineAttribute === "interleave"
        ? combineAttribute
        : undefined;
    switch (child.local) {
      case "start":
        return [{ kind: "start", combine, body: group(patterns(child, context)) }];
      case "define":
        return [
          {
            kind: "define",
            name: (Xml.attribute(child, "name") ?? "").trim(),
            combine,
            body: group(patterns(child, context)),
          },
        ];
      case "div":
        return [{ kind: "div", components: components(child, context) }];
      case "include":
        return [
          {
            kind: "include",
            href: Xml.attribute(child, "href") ?? "",
            defaultNamespace: context.ns,
            components: components(child, context),
          },
        ];
      default:
        return [];
    }
  });

export const parse = (source: string, _file: string, inheritedNamespace: string) => {
  const document = Xml.parse(source);
  if (Result.isFailure(document)) return Result.fail(document.failure.message);
  const root = document.success.root;
  const context: Context = {
    ns: inheritedNamespace,
    library: "",
    prefixes: { xml: "http://www.w3.org/XML/1998/namespace" },
  };
  if (root.ns !== RNG_NS) return Result.fail("not a RELAX NG schema");
  return Result.succeed(pattern(root, context));
};
