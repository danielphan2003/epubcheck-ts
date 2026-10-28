import type * as PackageDocument from "../opf/PackageDocument.ts";

// The schemas upstream adds for EPUB 3 profiles and extension specifications: Dictionaries and
// Glossaries, EDUPUB, Indexes, Previews, and Data Navigation documents.

export type Profile = "default" | "edupub" | "dict" | "idx" | "preview";

const DC_TYPES: Readonly<Record<string, Profile>> = {
  dictionary: "dict",
  edupub: "edupub",
  index: "idx",
  preview: "preview",
};

// The default profile defers to the publication's `dc:type`; an explicit profile wins.
export const effective = (requested: Profile, metadata: PackageDocument.Metadata | undefined) => {
  if (requested !== "default") return requested;
  for (const type of metadata?.types ?? []) {
    const profile = DC_TYPES[type];
    if (profile !== undefined) return profile;
  }
  return requested;
};

export const packageSchemas = (profile: Profile) => {
  switch (profile) {
    case "dict":
      return ["30/dict/dict-opf.sch"];
    case "edupub":
      return ["30/edupub/edu-opf.sch"];
    case "preview":
      return ["30/previews/preview-pub-opf.sch"];
    default:
      return [];
  }
};

// Where an XHTML content document sits in its publication; undefined in single-document mode.
export interface ItemContext {
  readonly properties: ReadonlyArray<string>;
  readonly collectionRoles: ReadonlySet<string>;
  // A linear, reflowable spine item: EDUPUB's sectioning rules apply only to those.
  readonly structured: boolean;
}

export const xhtmlSchemas = (profile: Profile, item: ItemContext | undefined) => {
  const properties = item?.properties ?? [];
  const roles = item?.collectionRoles ?? new Set<string>();
  const schemas: Array<string> = [];
  if (profile === "dict" || properties.includes("dictionary") || roles.has("dictionary")) {
    schemas.push("30/dict/dict-xhtml.sch");
  }
  if (profile === "edupub") {
    if (item === undefined || item.structured) schemas.push("30/edupub/edu-structure.sch");
    schemas.push("30/edupub/edu-semantics.sch");
  }
  // A whole-publication index (the idx profile) makes every content document an index.
  if (profile === "idx" || properties.includes("index") || roles.has("index")) {
    schemas.push("30/idx/idx-xhtml.sch", "30/idx/idx-xhtml-index.sch");
  }
  if (properties.includes("data-nav")) schemas.push("30/datanav/datanav-xhtml.sch");
  return schemas;
};

// The collection roles that include each container path.
export const collectionRoles = (collections: ReadonlyArray<PackageDocument.Collection>) => {
  const roles = new Map<string, Set<string>>();
  for (const collection of collections) {
    for (const path of collection.allPaths) {
      const existing = roles.get(path) ?? new Set<string>();
      for (const role of collection.roles) existing.add(role);
      roles.set(path, existing);
    }
  }
  return roles;
};
