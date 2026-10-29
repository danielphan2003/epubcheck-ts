import type * as PackageDocument from "../opf/PackageDocument.ts";

// The schemas upstream adds for EPUB 3 profiles and extension specifications: Dictionaries and
// Glossaries, EDUPUB, Indexes, Previews, and Data Navigation documents.

export type Profile = "default" | "edupub" | "dict" | "idx" | "preview";

// The `dc:type` values upstream knows, by the profile each implies, in the order they win.
const TYPES = [
  ["DICTIONARY", "dict"],
  ["EDUPUB", "edupub"],
  ["INDEX", "idx"],
  ["PREVIEW", "preview"],
] as const;

// What a publication is checked as: its profile, and its known `dc:type` values, uppercased.
export interface Selection {
  readonly profile: Profile;
  readonly types: ReadonlySet<string>;
}

export const DEFAULT: Selection = { profile: "default", types: new Set() };

// Upstream's PublicationType: known values, matched case-insensitively.
export const knownTypes = (types: ReadonlyArray<string>) =>
  new Set(
    types
      .map((type) => type.toUpperCase())
      .filter((type) => type === "EPUB" || TYPES.some(([known]) => known === type)),
  );

// EPUBProfile.makeTypeCompatible: a known `dc:type` overrides the requested profile.
export const effective = (requested: Profile, types: ReadonlySet<string>) =>
  TYPES.find(([type]) => types.has(type))?.[1] ?? requested;

// EPUBProfile.matchingType, as OPF-064 names it.
export const typeOf = (profile: Profile) =>
  TYPES.find(([, implied]) => implied === profile)?.[0].toLowerCase() ?? "epub";

// Upstream applies a profile's schemas for the profile or for its `dc:type`.
const is = (selection: Selection, profile: Profile) =>
  selection.profile === profile ||
  TYPES.some(([type, implied]) => implied === profile && selection.types.has(type));

export const isDictionary = (selection: Selection) => is(selection, "dict");

export const packageSchemas = (selection: Selection) => [
  ...(is(selection, "dict") ? ["30/dict/dict-opf.sch"] : []),
  ...(is(selection, "edupub") ? ["30/edupub/edu-opf.sch"] : []),
  ...(is(selection, "preview") ? ["30/previews/preview-pub-opf.sch"] : []),
];

// Where a content document sits in its publication; undefined in single-document mode.
export interface ItemContext {
  readonly properties: ReadonlyArray<string>;
  // Linked from an index collection, or a nested index group.
  readonly inIndex: boolean;
  // Neither fixed-layout nor non-linear (outside the spine counts as non-linear).
  readonly structured: boolean;
}

// Upstream's ValidatorMap: each schema once, where it was first listed, if any rule for it holds.
const schemasOf = (rules: ReadonlyArray<readonly [string, boolean]>) => {
  const applies = new Map<string, boolean>();
  for (const [schema, rule] of rules) applies.set(schema, (applies.get(schema) ?? false) || rule);
  return [...applies].flatMap(([schema, rule]) => (rule ? [schema] : []));
};

// OPSChecker's schemas for an XHTML content document.
export const xhtmlSchemas = (selection: Selection, item: ItemContext | undefined) => {
  const properties = item?.properties ?? [];
  const edupub = is(selection, "edupub") && (item?.structured ?? true);
  const index = is(selection, "idx") || properties.includes("index") || item?.inIndex === true;
  return schemasOf([
    ["30/dict/dict-xhtml.sch", is(selection, "dict")],
    ["30/edupub/edu-structure.sch", edupub],
    ["30/edupub/edu-semantics.sch", edupub],
    ["30/idx/idx-xhtml.sch", edupub],
    ["30/idx/idx-xhtml.sch", index],
    ["30/idx/idx-xhtml-index.sch", index],
    ["30/datanav/datanav-xhtml.sch", properties.includes("data-nav")],
  ]);
};

// NavChecker's schemas: an index profile alone does not make the navigation document an index.
export const navSchemas = (selection: Selection, item: ItemContext | undefined) => {
  const edupub = is(selection, "edupub") && (item?.structured ?? true);
  const index = item?.properties.includes("index") === true || item?.inIndex === true;
  return schemasOf([
    ["30/edupub/edu-structure.sch", edupub],
    ["30/edupub/edu-semantics.sch", edupub],
    ["30/idx/idx-xhtml.sch", edupub],
    ["30/dict/dict-xhtml.sch", is(selection, "dict")],
    ["30/idx/idx-xhtml.sch", index],
    ["30/idx/idx-xhtml-index.sch", index],
  ]);
};

// The container paths an index collection links, with those of its nested index groups.
export const indexPaths = (collections: ReadonlyArray<PackageDocument.Collection>) => {
  const paths = new Set<string>();
  const visit = (collection: PackageDocument.Collection) => {
    if (!collection.roles.includes("index") && !collection.roles.includes("index-group")) return;
    for (const { path } of collection.links) if (path !== undefined) paths.add(path);
    for (const child of collection.collections) visit(child);
  };
  for (const collection of collections) if (collection.roles.includes("index")) visit(collection);
  return paths;
};
