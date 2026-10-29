import * as Result from "effect/Result";

import type { Ast, Combine, Component, NameClassAst } from "./Ast.ts";
import * as Datatypes from "./Datatypes.ts";
import { PatternBuilder, type NameClass, type Pattern } from "./Pattern.ts";
import * as Rnc from "./Rnc.ts";

// Resolves a parsed schema (includes, overrides, combined definitions, nested grammars) into one
// pattern graph. Element contents compile lazily, which is what makes recursive grammars finite.

export interface SchemaSources {
  readonly read: (path: string) => string | undefined;
}

export interface CompiledSchema {
  readonly builder: PatternBuilder;
  readonly start: Pattern;
  readonly warnings: ReadonlyArray<string>;
}

interface Definition {
  readonly combine: Combine;
  readonly body: Ast;
}

class Scope {
  readonly definitions = new Map<string, Array<Definition>>();
  readonly compiled = new Map<string, Pattern>();
  readonly inProgress = new Set<string>();
  readonly parent: Scope | undefined;
  constructor(parent: Scope | undefined) {
    this.parent = parent;
  }
}

const START = "\u0000start";

const resolveHref = (base: string, href: string) => {
  const directory = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  const parts: Array<string> = [];
  for (const part of `${directory}${href}`.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
};

export const compile = (
  sources: SchemaSources,
  entry: string,
  libraries: Datatypes.Libraries,
  parseXmlSchema?: (
    source: string,
    file: string,
    inheritedNamespace: string,
  ) => Result.Result<Ast, string>,
) => {
  const builder = new PatternBuilder();
  const warnings: Array<string> = [];
  const errors: Array<string> = [];
  const loaded = new Map<string, Ast>();

  const load = (file: string, inheritedNamespace: string): Ast => {
    const key = `${file}\u0000${inheritedNamespace}`;
    const cached = loaded.get(key);
    if (cached !== undefined) return cached;
    const source = sources.read(file);
    if (source === undefined) {
      errors.push(`schema file not found: ${file}`);
      return { kind: "notAllowed" };
    }
    const parsed = file.endsWith(".rng")
      ? (parseXmlSchema?.(source, file, inheritedNamespace) ?? Result.fail("no XML-syntax parser"))
      : Result.mapError(Rnc.parse(source, { file, inheritedNamespace }), (error) => error.message);
    if (Result.isFailure(parsed)) {
      errors.push(`${file}: ${parsed.failure}`);
      return { kind: "notAllowed" };
    }
    // Remember which file each nested include is relative to.
    const ast = relativize(parsed.success, file);
    loaded.set(key, ast);
    return ast;
  };

  // Rewrites include/externalRef hrefs to be relative to the schema root.
  const relativize = (ast: Ast, file: string): Ast => {
    const fixComponents = (components: ReadonlyArray<Component>): ReadonlyArray<Component> =>
      components.map((component) => {
        switch (component.kind) {
          case "include":
            return {
              ...component,
              href: resolveHref(file, component.href),
              components: fixComponents(component.components),
            };
          case "div":
            return { ...component, components: fixComponents(component.components) };
          default:
            return { ...component, body: fix(component.body) };
        }
      });
    const fix = (node: Ast): Ast => {
      switch (node.kind) {
        case "externalRef":
          return { ...node, href: resolveHref(file, node.href) };
        case "grammar":
          return { ...node, components: fixComponents(node.components) };
        case "element":
        case "attribute":
        case "optional":
        case "zeroOrMore":
        case "oneOrMore":
        case "mixed":
        case "list":
          return { ...node, body: fix(node.body) };
        case "group":
        case "interleave":
        case "choice":
          return { ...node, items: node.items.map(fix) };
        case "data":
          return node.except === undefined ? node : { ...node, except: fix(node.except) };
        default:
          return node;
      }
    };
    return fix(ast);
  };

  // Includes being expanded, to reject an include of itself, directly or not.
  const including = new Set<string>();
  const addComponents = (scope: Scope, components: ReadonlyArray<Component>) => {
    for (const component of components) {
      switch (component.kind) {
        case "define":
          addDefinition(scope, component.name, component.combine, component.body);
          break;
        case "start":
          addDefinition(scope, START, component.combine, component.body);
          break;
        case "div":
          addComponents(scope, component.components);
          break;
        case "include": {
          if (including.has(component.href)) {
            errors.push(`recursive inclusion of URL "${component.href}"`);
            break;
          }
          const included = load(component.href, component.defaultNamespace);
          if (included.kind !== "grammar") {
            errors.push(`included file is not a grammar: ${component.href}`);
            break;
          }
          const overridden = new Set<string>();
          const collectNames = (list: ReadonlyArray<Component>) => {
            for (const item of list) {
              if (item.kind === "define") overridden.add(item.name);
              else if (item.kind === "start") overridden.add(START);
              else if (item.kind === "div") collectNames(item.components);
            }
          };
          collectNames(component.components);
          const filtered = new Scope(scope.parent);
          including.add(component.href);
          addComponents(filtered, included.components);
          including.delete(component.href);
          for (const [name, definitions] of filtered.definitions) {
            if (overridden.has(name)) continue;
            for (const definition of definitions)
              addDefinition(scope, name, definition.combine, definition.body);
          }
          addComponents(scope, component.components);
          break;
        }
      }
    }
  };

  const addDefinition = (scope: Scope, name: string, combine: Combine, body: Ast) => {
    const list = scope.definitions.get(name) ?? [];
    list.push({ combine, body });
    scope.definitions.set(name, list);
  };

  const resolve = (scope: Scope | undefined, name: string): Pattern => {
    if (scope === undefined) {
      errors.push(`reference to "${name}" outside a grammar`);
      return builder.notAllowed;
    }
    const cached = scope.compiled.get(name);
    if (cached !== undefined) return cached;
    const definitions = scope.definitions.get(name);
    if (definitions === undefined || definitions.length === 0) {
      errors.push(`reference to undefined pattern "${name === START ? "start" : name}"`);
      return builder.notAllowed;
    }
    if (scope.inProgress.has(name)) {
      errors.push(`bad recursive reference to pattern "${name}"`);
      return builder.notAllowed;
    }
    scope.inProgress.add(name);
    const combine = definitions.find((definition) => definition.combine !== undefined)?.combine;
    const patterns = definitions.map((definition) => compileAst(definition.body, scope));
    const combined = patterns
      .slice(1)
      .reduce(
        (left, right) =>
          combine === "interleave" ? builder.interleave(left, right) : builder.choice(left, right),
        patterns[0] ?? builder.notAllowed,
      );
    scope.inProgress.delete(name);
    scope.compiled.set(name, combined);
    return combined;
  };

  const nameClass = (ast: NameClassAst): NameClass => {
    switch (ast.kind) {
      case "name":
        return { t: "name", ns: ast.ns, local: ast.local };
      case "anyName":
        return {
          t: "anyName",
          except: ast.except === undefined ? undefined : nameClass(ast.except),
        };
      case "nsName":
        return {
          t: "nsName",
          ns: ast.ns,
          except: ast.except === undefined ? undefined : nameClass(ast.except),
        };
      case "choice": {
        const [first, ...rest] = ast.items.map(nameClass);
        return rest.reduce<NameClass>(
          (left, right) => ({ t: "choice", a: left, b: right }),
          first ?? { t: "anyName", except: undefined },
        );
      }
    }
  };

  const datatype = (library: string, type: string, params: ReadonlyArray<Datatypes.Param>) => {
    const found = Datatypes.lookup(library, type, params, libraries);
    if (found !== undefined) return found;
    warnings.push(
      `datatype "${type}" from library "${library}" not recognized; treated as a string`,
    );
    return (
      Datatypes.lookup("", "string", [], libraries) ?? {
        key: "string",
        contextDependent: false,
        normalize: (value: string) => value,
        validate: () => undefined,
      }
    );
  };

  const compileAst = (ast: Ast, scope: Scope | undefined): Pattern => {
    switch (ast.kind) {
      case "element": {
        let content: Pattern | undefined;
        return builder.element(
          nameClass(ast.name),
          () => (content ??= compileAst(ast.body, scope)),
        );
      }
      case "attribute":
        return builder.attribute(nameClass(ast.name), compileAst(ast.body, scope));
      case "group":
        return ast.items
          .map((item) => compileAst(item, scope))
          .reduce((a, b) => builder.group(a, b), builder.empty);
      case "interleave":
        return ast.items
          .map((item) => compileAst(item, scope))
          .reduce((a, b) => builder.interleave(a, b), builder.empty);
      case "choice":
        return ast.items
          .map((item) => compileAst(item, scope))
          .reduce((a, b) => builder.choice(a, b), builder.notAllowed);
      case "optional":
        return builder.optional(compileAst(ast.body, scope));
      case "zeroOrMore":
        return builder.zeroOrMore(compileAst(ast.body, scope));
      case "oneOrMore":
        return builder.oneOrMore(compileAst(ast.body, scope));
      case "mixed":
        return builder.interleave(compileAst(ast.body, scope), builder.text);
      case "list":
        return builder.list(compileAst(ast.body, scope));
      case "ref":
        return resolve(scope, ast.name);
      case "parentRef":
        return resolve(scope?.parent, ast.name);
      case "empty":
        return builder.empty;
      case "text":
        return builder.text;
      case "notAllowed":
        return builder.notAllowed;
      case "data":
        return builder.data(
          datatype(ast.library, ast.type, ast.params),
          ast.except === undefined ? undefined : compileAst(ast.except, scope),
        );
      case "value": {
        const namespaces = ast.namespaces;
        return builder.value(datatype(ast.library, ast.type, []), ast.value, {
          resolve: (prefix) => namespaces[prefix],
        });
      }
      case "grammar": {
        const nested = new Scope(scope);
        addComponents(nested, ast.components);
        return resolve(nested, START);
      }
      case "externalRef":
        return compileAst(load(ast.href, ast.defaultNamespace), undefined);
    }
  };

  const start = compileAst(load(entry, ""), undefined);
  if (errors.length > 0) return Result.fail(errors);
  return Result.succeed({ builder, start, warnings } satisfies CompiledSchema);
};
