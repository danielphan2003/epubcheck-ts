import * as MediaTypes from "../resources/MediaTypes.ts";
import * as Xml from "../xml/Xml.ts";
import * as JavaText from "../util/JavaText.ts";
import { percentDecode } from "../util/UrlFragment.ts";
import * as Vocabularies from "./Vocabularies.ts";

// The parts of a package document that other checks need: manifest items and the spine.

export const OPF_NS = "http://www.idpf.org/2007/opf";
// Legacy OEBPS 1.2 package documents use their own namespace, or none.
export const OEB_PACKAGE_NS = "http://openebook.org/namespaces/oeb-package/1.0/";
// Upstream reads package elements in any of these namespaces, whatever the root's.
export const PACKAGE_NAMESPACES = new Set([OPF_NS, OEB_PACKAGE_NS, ""]);
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
  // Upstream's publication identifier: the identifier whose `id` is `unique-identifier`, as
  // written, if it has text.
  readonly uid: string | undefined;
  readonly language: string | undefined;
  readonly date: string | undefined;
  readonly modified: string | undefined;
  readonly types: ReadonlyArray<string>;
  // The global `rendition:layout` values: those of metas that refine nothing.
  readonly layouts: ReadonlyArray<string>;
  // The first `rendition:orientation` and `rendition:spread` values, refining or not, as upstream
  // reports them.
  readonly orientation: string | undefined;
  readonly spread: string | undefined;
  // Media Overlays styling class names (`media:active-class`, `media:playback-active-class`).
  readonly activeClass: string | undefined;
  readonly playbackActiveClass: string | undefined;
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
  // Upstream applies an itemref's properties only when its `idref` needs no trimming.
  readonly padded: boolean;
  readonly linear: boolean;
  // Known properties, by their reserved prefixes.
  readonly properties: ReadonlyArray<string>;
}

export interface PackageDocument {
  readonly path: string;
  readonly version: "2" | "3";
  readonly items: ReadonlyArray<ManifestItem>;
  // Item IDs in spine order; `spineItems` has each itemref's details.
  readonly spine: ReadonlyArray<string>;
  readonly spineItems: ReadonlyArray<SpineItem>;
  // The ID the spine's `toc` names.
  readonly toc: string | undefined;
  // The guide's `reference` elements.
  readonly guide: ReadonlyArray<Xml.XmlElement>;
  readonly metadata: Metadata;
  // The package metadata's links (EPUB 3).
  readonly links: Collection["links"];
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

// The items upstream registers: those with an `id` and an `href`, the last item of each ID.
export const registered = (opf: PackageDocument) =>
  new Map(
    opf.items.flatMap((item) =>
      Xml.attribute(item.element, "id") === undefined ||
      Xml.attribute(item.element, "href") === undefined
        ? []
        : [[item.id, item] as const],
    ),
  ).values();

// What upstream's registry finds a resource by: the NFC paths of registered items without a
// fragment, whose URLs no fragment-less reference equals.
export const declaredPaths = (opf: PackageDocument) =>
  [...registered(opf)].flatMap((item) =>
    item.path === undefined || item.href.includes("#") ? [] : [item.path.normalize("NFC")],
  );

export const read = (
  document: Xml.XmlDocument,
  path: string,
  version: "2" | "3",
): PackageDocument => {
  const children = Xml.childElements(document.root).filter((child) =>
    PACKAGE_NAMESPACES.has(child.ns),
  );
  const manifest = children.find((child) => child.local === "manifest");
  const spine = children.find((child) => child.local === "spine");
  const items = (manifest === undefined ? [] : Xml.childElements(manifest))
    .filter((element) => PACKAGE_NAMESPACES.has(element.ns) && element.local === "item")
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
  const prefixes = Vocabularies.parsePrefixes(Xml.attribute(document.root, "prefix"));
  const spineItems = (spine === undefined ? [] : Xml.childElements(spine))
    .filter((element) => PACKAGE_NAMESPACES.has(element.ns) && element.local === "itemref")
    .map((element) => ({
      idref: (Xml.attribute(element, "idref") ?? "").trim(),
      padded: (Xml.attribute(element, "idref") ?? "").trim() !== Xml.attribute(element, "idref"),
      linear: (Xml.attribute(element, "linear") ?? "").trim() !== "no",
      properties: Vocabularies.canonicalNames(
        Xml.attribute(element, "properties"),
        "itemref",
        prefixes,
      ),
    }));
  const itemrefs = spineItems.map((itemref) => itemref.idref);
  const guide = children.find((child) => child.local === "guide");
  const linksOf = (element: Xml.XmlElement | undefined) =>
    (element === undefined ? [] : Xml.childElements(element))
      .filter((link) => link.ns === OPF_NS && link.local === "link")
      .map((link) => {
        const href = (Xml.attribute(link, "href") ?? "").trim();
        // Fragments name parts of a resource; the resource is what the link points to.
        return { href, path: resolve(href.split("#")[0] ?? href, path) };
      });
  // Annotated, as it is recursive.
  const readCollection = (element: Xml.XmlElement): Collection => ({
    roles: (Xml.attribute(element, "role") ?? "").split(/\s+/).filter((role) => role !== ""),
    links: linksOf(element),
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
    toc: spine === undefined ? undefined : Xml.attribute(spine, "toc")?.trim(),
    guide: (guide === undefined ? [] : Xml.childElements(guide)).filter(
      (element) => PACKAGE_NAMESPACES.has(element.ns) && element.local === "reference",
    ),
    metadata: readMetadata(document, children, prefixes),
    links: linksOf(children.find((child) => child.local === "metadata")),
    collections,
  };
};

const readMetadata = (
  document: Xml.XmlDocument,
  children: ReadonlyArray<Xml.XmlElement>,
  prefixes: Vocabularies.Prefixes,
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
  const declared = Xml.attribute(document.root, "unique-identifier");
  const uidElement =
    declared === undefined || declared === ""
      ? undefined
      : identifiers.find((element) => {
          const id = Xml.attribute(element, "id");
          return id !== undefined && id !== "" && JavaText.trim(id) === declared;
        });
  // Upstream keeps the text an element holds directly.
  const uidText = uidElement?.children.flatMap((child) =>
    child.kind === "text" ? [child.text] : [],
  );
  // Upstream resolves the property through the declared prefixes, and takes `refines="#"` as no
  // refinement at all.
  const layouts = elements.filter(
    (element) =>
      element.ns === OPF_NS &&
      element.local === "meta" &&
      (Xml.attribute(element, "refines") ?? "#") === "#" &&
      Vocabularies.canonicalNames(
        Xml.attribute(element, "property"),
        "meta",
        prefixes,
        false,
      )[0] === "rendition:layout",
  );
  // The first package `meta` for a property, resolved through the declared prefixes as upstream
  // resolves it; unrefined unless `refined` allows any.
  const meta = (property: string, refined = false) => {
    const element = elements.find(
      (candidate) =>
        candidate.ns === OPF_NS &&
        candidate.local === "meta" &&
        (refined || Xml.attribute(candidate, "refines") === undefined) &&
        Vocabularies.canonicalNames(
          Xml.attribute(candidate, "property"),
          "meta",
          prefixes,
          false,
        )[0] === property,
    );
    return element === undefined ? undefined : Xml.textContent(element).trim();
  };
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
    uid:
      uidText === undefined || uidText.length === 0 ? undefined : JavaText.trim(uidText.join("")),
    language: values("language")[0],
    date: values("date")[0],
    types: values("type"),
    layouts: layouts.map((element) => Xml.textContent(element).trim()),
    orientation: meta("rendition:orientation", true),
    spread: meta("rendition:spread", true),
    // Upstream notes the styling classes whether or not their metas refine anything.
    activeClass: meta("media:active-class", true),
    playbackActiveClass: meta("media:playback-active-class", true),
    modified: modified === undefined ? undefined : Xml.textContent(modified).trim(),
  };
};
