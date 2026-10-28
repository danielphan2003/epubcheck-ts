import type { MessageId } from "../messages/MessageCatalog.ts";
import { isNCName } from "../schema/Datatypes.ts";

// Property vocabularies of the package document (EPUB 3 "Vocabulary association mechanisms"):
// default vocabularies per attribute, reserved prefixes, and `prefix` declarations.

export type Status = "allowed" | "deprecated" | "outdated";

// `terms` undefined means any term is accepted (a vocabulary we do not check).
export interface Vocab {
  readonly uri: string;
  readonly terms: ReadonlyMap<string, Status> | undefined;
}

export type PropertyContext = "meta" | "scheme" | "item" | "itemref" | "link-rel" | "link";

const terms = (allowed: ReadonlyArray<string>, other: Readonly<Record<string, Status>> = {}) =>
  new Map<string, Status>([
    ...allowed.map((term) => [term, "allowed"] as const),
    ...Object.entries(other),
  ]);

const META_URI = "http://idpf.org/epub/vocab/package/meta/#";
const ITEM_URI = "http://idpf.org/epub/vocab/package/item/#";
const ITEMREF_URI = "http://idpf.org/epub/vocab/package/itemref/#";
const LINK_URI = "http://idpf.org/epub/vocab/package/link/#";

const DEFAULT_VOCABS: Readonly<Record<PropertyContext, Vocab>> = {
  meta: {
    uri: META_URI,
    terms: terms(
      [
        "alternate-script",
        "authority",
        "belongs-to-collection",
        "collection-type",
        "display-seq",
        "dictionary-type",
        "file-as",
        "group-position",
        "identifier-type",
        "meta-auth",
        "pageBreakSource",
        "role",
        "source-language",
        "target-language",
        "term",
        "title-type",
      ],
      { "source-of": "outdated" },
    ),
  },
  scheme: { uri: "", terms: new Map() },
  item: {
    uri: ITEM_URI,
    terms: terms([
      "cover-image",
      "data-nav",
      "dictionary",
      "glossary",
      "index",
      "mathml",
      "nav",
      "remote-resources",
      "scripted",
      "search-key-map",
      "svg",
      "switch",
    ]),
  },
  itemref: { uri: ITEMREF_URI, terms: terms(["page-spread-left", "page-spread-right"]) },
  "link-rel": {
    uri: LINK_URI,
    terms: terms(["acquire", "alternate", "record", "voicing"], {
      "marc21xml-record": "deprecated",
      "mods-record": "deprecated",
      "onix-record": "deprecated",
      "xml-signature": "deprecated",
      "xmp-record": "deprecated",
    }),
  },
  link: { uri: LINK_URI, terms: terms(["onix"]) },
};

// Vocabularies a reserved prefix maps to, by the attribute the property appears in.
const RENDITION_URI = "http://www.idpf.org/vocab/rendition/#";
const A11Y_URI = "http://www.idpf.org/epub/vocab/package/a11y/#";
const MEDIA_URI = "http://www.idpf.org/epub/vocab/overlays/#";

const RENDITION: Readonly<Partial<Record<PropertyContext, ReadonlyMap<string, Status>>>> = {
  meta: terms(["layout"], {
    flow: "outdated",
    orientation: "outdated",
    spread: "outdated",
    viewport: "deprecated",
  }),
  itemref: terms(
    [
      "align-x-center",
      "layout-pre-paginated",
      "layout-reflowable",
      "page-spread-center",
      "page-spread-left",
      "page-spread-right",
    ],
    {
      "flow-auto": "outdated",
      "flow-paginated": "outdated",
      "flow-scrolled-continuous": "outdated",
      "flow-scrolled-doc": "outdated",
      "orientation-auto": "outdated",
      "orientation-landscape": "outdated",
      "orientation-portrait": "outdated",
      "spread-auto": "outdated",
      "spread-both": "outdated",
      "spread-landscape": "outdated",
      "spread-none": "outdated",
      "spread-portrait": "deprecated",
    },
  ),
};

const A11Y = terms([
  "certifiedBy",
  "certifierCredential",
  "certifierReport",
  "contactEmail",
  "exemption",
]);
const MEDIA = terms(["active-class", "duration", "narrator", "playback-active-class"]);

interface Reserved {
  readonly uri: string;
  readonly deprecated: boolean;
  readonly terms: (context: PropertyContext) => ReadonlyMap<string, Status> | undefined;
}

const unchecked = () => undefined;
const none = () => new Map<string, Status>();

export const RESERVED: Readonly<Record<string, Reserved>> = {
  a11y: {
    uri: A11Y_URI,
    deprecated: false,
    terms: (context) => (context === "meta" || context === "link-rel" ? A11Y : new Map()),
  },
  dcterms: { uri: "http://purl.org/dc/terms/", deprecated: false, terms: unchecked },
  marc: { uri: "http://id.loc.gov/vocabulary/", deprecated: false, terms: unchecked },
  media: {
    uri: MEDIA_URI,
    deprecated: false,
    terms: (context) => (context === "meta" ? MEDIA : new Map()),
  },
  onix: {
    uri: "http://www.editeur.org/ONIX/book/codelists/current.html#",
    deprecated: false,
    terms: unchecked,
  },
  rendition: {
    uri: RENDITION_URI,
    deprecated: false,
    terms: (context) => RENDITION[context] ?? none(),
  },
  schema: { uri: "http://schema.org/", deprecated: false, terms: unchecked },
  xsd: { uri: "http://www.w3.org/2001/XMLSchema#", deprecated: false, terms: unchecked },
  msv: {
    uri: "http://www.idpf.org/epub/vocab/structure/magazine/#",
    deprecated: true,
    terms: unchecked,
  },
  prism: {
    uri: "http://www.prismstandard.org/specifications/3.0/PRISM_CV_Spec_3.0.htm#",
    deprecated: true,
    terms: unchecked,
  },
};

// Known vocabularies a declared prefix may map to.
const KNOWN_BY_URI = new Map(
  Object.values(RESERVED).map((reserved) => [reserved.uri, reserved] as const),
);

const FORBIDDEN_URIS = new Set([META_URI, ITEM_URI, ITEMREF_URI, LINK_URI]);
const DC_ELEMENTS = "http://purl.org/dc/elements/1.1/";

export interface Problem {
  readonly id: MessageId;
  readonly args: ReadonlyArray<string>;
}

export interface Prefixes {
  readonly vocabs: ReadonlyMap<string, Reserved>;
  readonly problems: ReadonlyArray<Problem>;
}

// Parses a `prefix` attribute: `prefix: URI` mappings separated by whitespace.
export const parsePrefixes = (value: string | undefined): Prefixes => {
  const vocabs = new Map(Object.entries(RESERVED));
  const problems: Array<Problem> = [];
  if (value === undefined) return { vocabs, problems };
  if (value !== value.trim()) problems.push({ id: "OPF-004", args: [] });
  const tokens = value
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const colon = token.indexOf(":");
    let prefix: string;
    let uri: string | undefined;
    if (colon < 0) {
      // The prefix is not immediately followed by a colon: skip a detached ":" and the URI.
      problems.push({ id: "OPF-004c", args: [token] });
      if (tokens[index + 1] === ":") index++;
      index++;
      continue;
    }
    if (colon < token.length - 1) {
      problems.push({ id: "OPF-004d", args: [token.slice(0, colon)] });
      prefix = token.slice(0, colon);
      uri = token.slice(colon + 1);
    } else {
      prefix = token.slice(0, -1);
      uri = tokens[++index];
    }
    if (prefix === "") {
      problems.push({ id: "OPF-004a", args: [] });
      continue;
    }
    if (!isNCName(prefix)) {
      problems.push({ id: "OPF-004b", args: [prefix] });
      continue;
    }
    if (uri === undefined) continue;
    if (prefix === "_") problems.push({ id: "OPF-007a", args: [] });
    else if (FORBIDDEN_URIS.has(uri)) problems.push({ id: "OPF-007b", args: [prefix] });
    else if (uri === DC_ELEMENTS) problems.push({ id: "OPF-007c", args: [] });
    else {
      const reserved = RESERVED[prefix];
      if (reserved !== undefined && reserved.uri !== uri)
        problems.push({ id: "OPF-007", args: [prefix] });
      if (reserved !== undefined && reserved.deprecated)
        problems.push({ id: "OPF-086c", args: [prefix] });
      vocabs.set(prefix, KNOWN_BY_URI.get(uri) ?? { uri, deprecated: false, terms: unchecked });
    }
  }
  return { vocabs, problems };
};

export interface Property {
  readonly prefix: string;
  readonly name: string;
  readonly token: string;
}

// Parses a property attribute against the vocabularies in scope, as upstream's VocabUtil does.
export const parseProperties = (
  value: string | undefined,
  context: PropertyContext,
  prefixes: Prefixes,
  isList: boolean,
) => {
  const properties: Array<Property> = [];
  const problems: Array<Problem> = [];
  if (value === undefined) return { properties, problems };
  const tokens = value.split(/\s+/).filter((token) => token !== "");
  if (!isList && tokens.length > 1)
    return { properties, problems: [{ id: "OPF-025" as const, args: [value] }] };
  for (const token of tokens) {
    const colon = token.indexOf(":");
    const prefix = colon < 0 ? "" : token.slice(0, colon);
    const name = colon < 0 ? token : token.slice(colon + 1);
    if (colon >= 0 && (prefix === "" || name === "")) {
      problems.push({ id: "OPF-026", args: [token] });
      continue;
    }
    const vocab = prefix === "" ? undefined : prefixes.vocabs.get(prefix);
    if (prefix !== "" && vocab === undefined) {
      problems.push({ id: "OPF-028", args: [prefix] });
      continue;
    }
    if (vocab?.deprecated === true) problems.push({ id: "OPF-086c", args: [prefix] });
    const known = prefix === "" ? DEFAULT_VOCABS[context].terms : vocab?.terms(context);
    const status = known?.get(name) ?? (known === undefined ? "allowed" : undefined);
    if (status === undefined) {
      problems.push({ id: "OPF-027", args: [token] });
      continue;
    }
    if (status === "deprecated") problems.push({ id: "OPF-086", args: [token, name] });
    if (status === "outdated") problems.push({ id: "OBS-001", args: ["property", token] });
    properties.push({ prefix, name, token });
  }
  return { properties, problems };
};
