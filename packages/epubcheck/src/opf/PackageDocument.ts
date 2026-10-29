import * as Xml from "../xml/Xml.ts";
import { percentDecode } from "../util/UrlFragment.ts";

// The parts of a package document that other checks need: manifest items and the spine.

const OPF_NS = "http://www.idpf.org/2007/opf";

export interface ManifestItem {
  readonly id: string;
  readonly href: string;
  // Container path of the resource, or undefined for remote resources and unparsable hrefs.
  readonly path: string | undefined;
  readonly mediaType: string;
  readonly properties: ReadonlyArray<string>;
  readonly element: Xml.XmlElement;
}

export interface PackageDocument {
  readonly path: string;
  readonly version: "2" | "3";
  readonly items: ReadonlyArray<ManifestItem>;
  readonly spine: ReadonlyArray<string>;
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
        mediaType: (Xml.attribute(element, "media-type") ?? "").trim(),
        properties: (Xml.attribute(element, "properties") ?? "")
          .split(/[ \t\n\v\f\r]+/)
          .filter((token) => token !== ""),
        element,
      };
    });
  const itemrefs = (spine === undefined ? [] : Xml.childElements(spine))
    .filter((element) => element.ns === OPF_NS && element.local === "itemref")
    .map((element) => (Xml.attribute(element, "idref") ?? "").trim());
  return { path, version, items, spine: itemrefs };
};
