// The unsimplified schema tree that the compact-syntax and XML-syntax parsers produce.

export type NameClassAst =
  | { readonly kind: "name"; readonly ns: string; readonly local: string }
  | { readonly kind: "anyName"; readonly except: NameClassAst | undefined }
  | { readonly kind: "nsName"; readonly ns: string; readonly except: NameClassAst | undefined }
  | { readonly kind: "choice"; readonly items: ReadonlyArray<NameClassAst> };

export interface Param {
  readonly name: string;
  readonly value: string;
}

export type Ast =
  | { readonly kind: "element"; readonly name: NameClassAst; readonly body: Ast }
  | { readonly kind: "attribute"; readonly name: NameClassAst; readonly body: Ast }
  | { readonly kind: "group" | "interleave" | "choice"; readonly items: ReadonlyArray<Ast> }
  | {
      readonly kind: "optional" | "zeroOrMore" | "oneOrMore" | "mixed" | "list";
      readonly body: Ast;
    }
  | { readonly kind: "ref" | "parentRef"; readonly name: string }
  | { readonly kind: "empty" | "text" | "notAllowed" }
  | {
      readonly kind: "data";
      readonly library: string;
      readonly type: string;
      readonly params: ReadonlyArray<Param>;
      readonly except: Ast | undefined;
    }
  | {
      readonly kind: "value";
      readonly library: string;
      readonly type: string;
      readonly value: string;
      readonly namespaces: Readonly<Record<string, string>>;
    }
  | { readonly kind: "grammar"; readonly components: ReadonlyArray<Component> }
  | { readonly kind: "externalRef"; readonly href: string; readonly defaultNamespace: string };

export type Combine = "choice" | "interleave" | undefined;

export type Component =
  | {
      readonly kind: "define";
      readonly name: string;
      readonly combine: Combine;
      readonly body: Ast;
    }
  | { readonly kind: "start"; readonly combine: Combine; readonly body: Ast }
  | {
      readonly kind: "include";
      readonly href: string;
      readonly defaultNamespace: string;
      readonly components: ReadonlyArray<Component>;
    }
  | { readonly kind: "div"; readonly components: ReadonlyArray<Component> };
