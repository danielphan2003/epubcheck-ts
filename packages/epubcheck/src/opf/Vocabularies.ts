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

export type PropertyContext = "meta" | "item" | "itemref" | "link-rel" | "link";

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
      "layout-pre-paginated",
      "layout-reflowable",
      "page-spread-center",
      "page-spread-left",
      "page-spread-right",
    ],
    {
      "align-x-center": "deprecated",
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

const A11Y: Readonly<Partial<Record<PropertyContext, ReadonlyMap<string, Status>>>> = {
  meta: terms(["certifiedBy", "certifierCredential", "contactEmail", "exemption"]),
  "link-rel": terms(["certifierCredential", "certifierReport"]),
};
const MEDIA = terms(["active-class", "duration", "narrator", "playback-active-class"]);
const SCRIPTED = terms([
  "network-access-required",
  "required-params",
  "storage-required",
  "version",
]);

interface Reserved {
  readonly uri: string;
  readonly deprecated: boolean;
  // The terms a context accepts; undefined accepts any term.
  readonly terms: (context: PropertyContext) => ReadonlyMap<string, Status> | undefined;
  // Where the prefix is reserved without a declaration; everywhere when absent.
  readonly reservedIn?: ReadonlyArray<PropertyContext> | undefined;
}

const unchecked = () => undefined;
const none = () => new Map<string, Status>();

export const RESERVED: Readonly<Record<string, Reserved>> = {
  a11y: {
    uri: A11Y_URI,
    deprecated: false,
    terms: (context) => A11Y[context] ?? none(),
    reservedIn: ["meta", "link-rel", "link"],
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
  xsd: { uri: "http://www.w3.org/2001/XMLSchema#", deprecated: true, terms: unchecked },
};

// Known vocabularies a declared prefix may map to.
const KNOWN_BY_URI = new Map<string, Reserved>([
  ...Object.values(RESERVED).map((reserved) => [reserved.uri, reserved] as const),
  [
    "http://idpf.org/epub/vocab/sc/#",
    {
      uri: "http://idpf.org/epub/vocab/sc/#",
      deprecated: false,
      terms: (context) =>
        context === "meta" ? SCRIPTED : context === "itemref" ? undefined : none(),
    },
  ],
]);

const FORBIDDEN_URIS = new Set([META_URI, ITEM_URI, ITEMREF_URI, LINK_URI]);
const DC_ELEMENTS = "http://purl.org/dc/elements/1.1/";

export interface Problem {
  readonly id: MessageId;
  readonly args: ReadonlyArray<string>;
}

// Guava's CharMatcher.whitespace(), which upstream's prefix parser uses.
const isWhitespace = (char: string) =>
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(char);

type PrefixState = "start" | "prefix" | "prefix-end" | "space" | "uri" | "whitespace";

// What each state of upstream's parser reads, and which of those characters it allows.
const STATES: Readonly<
  Record<
    PrefixState,
    { readonly reads: (char: string) => boolean; readonly allows: string | undefined }
  >
> = {
  start: { reads: isWhitespace, allows: "" },
  prefix: { reads: (char) => char !== ":" && !isWhitespace(char), allows: undefined },
  "prefix-end": { reads: (char) => char === ":", allows: undefined },
  space: { reads: isWhitespace, allows: " " },
  uri: { reads: (char) => !isWhitespace(char), allows: undefined },
  whitespace: { reads: isWhitespace, allows: " \t\r\n" },
};

// java.net.URI's syntax, approximately: a scheme needs a scheme-specific part, escapes need two
// hex digits, and quotes, angle brackets, braces, pipes, carets and backslashes are illegal.
const isJavaUri = (value: string) => {
  if (/[\u0000-\u0020\u007f"<>\\^`{|}]|%(?![0-9A-Fa-f]{2})/.test(value)) return false;
  if (value.split("#").length > 2) return false;
  // Brackets only enclose an IP literal host.
  const host = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?)\[[0-9A-Fa-f:.]+\]/;
  if (/[[\]]/.test(value.replace(host, "$1"))) return false;
  const delimiter = value.search(/[:/?#]/);
  if (delimiter < 0 || value[delimiter] !== ":") return true;
  const rest = value.slice(delimiter + 1);
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*$/.test(value.slice(0, delimiter)) &&
    rest !== "" &&
    !rest.startsWith("#")
  );
};

// Parses a `prefix` attribute with upstream's state machine: optional leading whitespace, then
// `prefix:` and a URI separated by one space, with whitespace between mappings.
export const parsePrefixes = (value: string | undefined) => {
  const vocabs = new Map<string, Reserved>(Object.entries(RESERVED));
  const problems: Array<Problem> = [];
  if (value === undefined) return { vocabs, problems };
  // Java prints a missing prefix as "null".
  const named = () => prefix ?? "null";
  const declare = (prefix: string, uri: string) => {
    if (prefix === "_") problems.push({ id: "OPF-007a", args: [] });
    else if (FORBIDDEN_URIS.has(uri)) problems.push({ id: "OPF-007b", args: [prefix] });
    else if (uri === DC_ELEMENTS) problems.push({ id: "OPF-007c", args: [] });
    else {
      const reserved = RESERVED[prefix];
      if (reserved !== undefined && reserved.uri !== uri)
        problems.push({ id: "OPF-007", args: [prefix] });
      if (reserved !== undefined && reserved.deprecated)
        problems.push({ id: "OPF-086c", args: [prefix] });
      const known = KNOWN_BY_URI.get(uri) ?? { uri, deprecated: false, terms: unchecked };
      vocabs.set(prefix, { ...known, reservedIn: undefined });
    }
  };
  let state: PrefixState = "start";
  let prefix: string | undefined;
  let read = "";
  let index = 0;
  while (index < value.length) {
    const from = index;
    const { reads, allows } = STATES[state];
    while (index < value.length && reads(value[index] ?? "")) index++;
    read = value.slice(from, index);
    const disallowed = allows !== undefined && [...read].some((char) => !allows.includes(char));
    switch (state) {
      case "start":
        if (read !== "") problems.push({ id: "OPF-004", args: [] });
        state = "prefix";
        break;
      case "prefix":
        if (read === "") problems.push({ id: "OPF-004a", args: [] });
        else if (!isNCName(read)) problems.push({ id: "OPF-004b", args: [read] });
        else prefix = read;
        state = "prefix-end";
        break;
      case "prefix-end":
        if (read !== "") {
          state = "space";
          break;
        }
        while (index < value.length && value[index] !== ":" && isWhitespace(value[index] ?? "")) {
          index++;
        }
        problems.push({ id: "OPF-004c", args: [named()] });
        state = value[index] === ":" ? "prefix-end" : "uri";
        prefix = undefined;
        break;
      case "space":
        if (read === "") {
          problems.push({ id: "OPF-004d", args: [named()] });
          prefix = undefined;
        } else if (disallowed) problems.push({ id: "OPF-004e", args: [named()] });
        state = "uri";
        break;
      case "uri":
        if (!isJavaUri(read)) problems.push({ id: "OPF-006", args: [read, named()] });
        else if (prefix !== undefined) declare(prefix, read);
        prefix = undefined;
        state = "whitespace";
        break;
      case "whitespace":
        if (disallowed) problems.push({ id: "OPF-004f", args: [named()] });
        state = "prefix";
        break;
    }
  }
  if (state !== "start" && state !== "prefix" && state !== "whitespace") {
    problems.push({ id: "OPF-005", args: [named()] });
  }
  if (state === "prefix" && read !== "") problems.push({ id: "OPF-004", args: [] });
  return { vocabs, problems };
};

export type Prefixes = ReturnType<typeof parsePrefixes>;

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
  // Java splits on ASCII whitespace only; NBSP belongs to a token.
  const tokens = value.split(/[ \t\n\v\f\r]+/).filter((token) => token !== "");
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
    const found = prefix === "" ? undefined : prefixes.vocabs.get(prefix);
    const vocab =
      found?.reservedIn === undefined || found.reservedIn.includes(context) ? found : undefined;
    if (prefix !== "" && vocab === undefined) {
      problems.push({ id: "OPF-028", args: [prefix] });
      continue;
    }
    // Only the deprecated vocabulary's own prefix name is deprecated, not another one mapped to it.
    if (vocab?.deprecated === true && RESERVED[prefix]?.uri === vocab.uri) {
      problems.push({ id: "OPF-086c", args: [prefix] });
    }
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
