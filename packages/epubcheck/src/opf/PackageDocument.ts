import * as MediaTypes from "../resources/MediaTypes.ts";
import * as Xml from "../xml/Xml.ts";
import { percentDecode } from "../util/UrlFragment.ts";

// The parts of a package document that other checks need: manifest items and the spine.

const OPF_NS = "http://www.idpf.org/2007/opf";
const DC_NS = "http://purl.org/dc/elements/1.1/";

export interface ManifestItem {
  readonly id: string;
  readonly href: string;
  // Container path of the resource, or undefined for remote resources and unparsable hrefs.
  readonly path: string | undefined;
  // Normalized, as upstream stores it, so every check sees the same spelling.
  readonly mediaType: string;
  readonly properties: ReadonlyArray<string>;
  // The ID of the manifest fallback, if any.
  readonly fallback: string | undefined;
  readonly element: Xml.XmlElement;
}

// Publication metadata as the reports show it.
export interface Metadata {
  readonly title: string | undefined;
  readonly creators: ReadonlyArray<string>;
  readonly contributors: ReadonlyArray<string>;
  readonly subjects: ReadonlyArray<string>;
  readonly publisher: string | undefined;
  readonly description: string | undefined;
  readonly rights: string | undefined;
  readonly identifier: string | undefined;
  readonly language: string | undefined;
  readonly date: string | undefined;
  readonly modified: string | undefined;
  readonly types: ReadonlyArray<string>;
  // The global `rendition:layout` value.
  readonly layout: string | undefined;
}

// A `collection` element (EPUB 3): its roles, its own links, and the collections nested in it.
export interface Collection {
  readonly roles: ReadonlyArray<string>;
  // Each link's `href`, and the container path it points to, if any.
  readonly links: ReadonlyArray<{ readonly href: string; readonly path: string | undefined }>;
  readonly collections: ReadonlyArray<Collection>;
}

export interface SpineItem {
  readonly idref: string;
  readonly linear: boolean;
  readonly properties: ReadonlyArray<string>;
}

export interface PackageDocument {
  readonly path: string;
  readonly version: "2" | "3";
  readonly items: ReadonlyArray<ManifestItem>;
  // Item IDs in spine order; `spineItems` has each itemref's details.
  readonly spine: ReadonlyArray<string>;
  readonly spineItems: ReadonlyArray<SpineItem>;
  readonly metadata: Metadata;
  readonly collections: ReadonlyArray<Collection>;
}

const BASE = "https://container.invalid/";

// Resolves `href` against the package document's container path, like upstream's URL handling.
export const resolve = (href: string, from: string) => {
  try {
    const url = new URL(href, new URL(from, BASE));
    if (url.origin !== new URL(BASE).origin) return undefined;
    // Invalid UTF-8 decodes to U+FFFD, as in upstream's URL library.
    return percentDecode(url.pathname.slice(1));
  } catch {
    return undefined;
  }
};

export const read = (
  document: Xml.XmlDocument,
  path: string,
  version: "2" | "3",
): PackageDocument => {
  const children = Xml.childElements(document.root).filter((child) => child.ns === OPF_NS);
  const manifest = children.find((child) => child.local === "manifest");
  const spine = children.find((child) => child.local === "spine");
  const items = (manifest === undefined ? [] : Xml.childElements(manifest))
    .filter((element) => element.ns === OPF_NS && element.local === "item")
    .map((element) => {
      const href = (Xml.attribute(element, "href") ?? "").trim();
      return {
        id: (Xml.attribute(element, "id") ?? "").trim(),
        href,
        path: href === "" ? undefined : resolve(href, path),
        mediaType: MediaTypes.normalize(Xml.attribute(element, "media-type") ?? ""),
        properties: (Xml.attribute(element, "properties") ?? "")
          .split(/[ \t\n\v\f\r]+/)
          .filter((token) => token !== ""),
        fallback: Xml.attribute(element, "fallback")?.trim() || undefined,
        element,
      };
    });
  const spineItems = (spine === undefined ? [] : Xml.childElements(spine))
    .filter((element) => element.ns === OPF_NS && element.local === "itemref")
    .map((element) => ({
      idref: (Xml.attribute(element, "idref") ?? "").trim(),
      linear: (Xml.attribute(element, "linear") ?? "").trim() !== "no",
      properties: (Xml.attribute(element, "properties") ?? "")
        .split(/\s+/)
        .filter((token) => token !== ""),
    }));
  const itemrefs = spineItems.map((itemref) => itemref.idref);
  // Annotated, as it is recursive.
  const readCollection = (element: Xml.XmlElement): Collection => ({
    roles: (Xml.attribute(element, "role") ?? "").split(/\s+/).filter((role) => role !== ""),
    links: Xml.childElements(element)
      .filter((link) => link.ns === OPF_NS && link.local === "link")
      .map((link) => {
        const href = (Xml.attribute(link, "href") ?? "").trim();
        // Fragments name parts of a resource; the resource is what the collection includes.
        return { href, path: resolve(href.split("#")[0] ?? href, path) };
      }),
    collections: Xml.childElements(element)
      .filter((child) => child.ns === OPF_NS && child.local === "collection")
      .map(readCollection),
  });
  // Top-level collections; nested ones are in their parents.
  const collections = children
    .filter((element) => element.local === "collection")
    .map(readCollection);
  return {
    path,
    version,
    items,
    spine: itemrefs,
    spineItems,
    metadata: readMetadata(document, children),
    collections,
  };
};

const readMetadata = (
  document: Xml.XmlDocument,
  children: ReadonlyArray<Xml.XmlElement>,
): Metadata => {
  const metadata = children.find((child) => child.local === "metadata");
  // EPUB 2 allows Dublin Core inside a `dc-metadata` wrapper.
  const elements = (metadata === undefined ? [] : Xml.childElements(metadata)).flatMap((element) =>
    element.local === "dc-metadata" ? Xml.childElements(element) : [element],
  );
  const values = (local: string) =>
    elements
      .filter((element) => element.ns === DC_NS && element.local === local)
      .map((element) => Xml.textContent(element).trim())
      .filter((value) => value !== "");
  const uniqueIdentifier = Xml.attribute(document.root, "unique-identifier")?.trim();
  const identifiers = elements.filter(
    (element) => element.ns === DC_NS && element.local === "identifier",
  );
  const identifier =
    identifiers.find((element) => Xml.attribute(element, "id")?.trim() === uniqueIdentifier) ??
    identifiers[0];
  const layout = elements.find(
    (element) =>
      element.ns === OPF_NS &&
      element.local === "meta" &&
      Xml.attribute(element, "property")?.trim() === "rendition:layout",
  );
  const modified = elements.find(
    (element) =>
      element.ns === OPF_NS &&
      element.local === "meta" &&
      Xml.attribute(element, "property")?.trim() === "dcterms:modified",
  );
  return {
    title: values("title")[0],
    creators: values("creator"),
    contributors: values("contributor"),
    subjects: values("subject"),
    publisher: values("publisher")[0],
    description: values("description")[0],
    rights: values("rights")[0],
    identifier: identifier === undefined ? undefined : Xml.textContent(identifier).trim(),
    language: values("language")[0],
    date: values("date")[0],
    types: values("type"),
    layout: layout === undefined ? undefined : Xml.textContent(layout).trim(),
    modified: modified === undefined ? undefined : Xml.textContent(modified).trim(),
  };
};
