import * as MediaTypes from "../resources/MediaTypes.ts";
import * as Xml from "../xml/Xml.ts";
import type { ManifestItem } from "./PackageDocument.ts";

// Upstream's OPS content document types, and its FallbackChainResolver's answer to whether an
// item, or the manifest fallback chain it starts, is one.

export const isBlessedItemType = (mediaType: string, version: "2" | "3") =>
  mediaType === "application/xhtml+xml" ||
  mediaType === (version === "2" ? "application/x-dtbook+xml" : "image/svg+xml");

export const isDeprecatedBlessedItemType = (mediaType: string) =>
  mediaType === "text/x-oeb1-document" || mediaType === "text/html";

export const isBlessedImageType = (mediaType: string, version: "2" | "3") =>
  ["image/gif", "image/png", "image/jpeg", "image/svg+xml"].includes(mediaType) ||
  (version === "3" && ["image/webp", "image/avif", "image/jxl"].includes(mediaType));

export const isStyleType = (mediaType: string) =>
  mediaType === "text/css" || mediaType === "text/x-oeb1-css";

// Whether each item, or the chain it starts, reaches a content document or a core media type.
// An item whose chain loops never resolves, so it keeps only its own type. In EPUB 2, a blessed
// image is a core type, and a `fallback-style` naming a style sheet counts for both.
export const resolveFallbacks = (items: ReadonlyMap<string, ManifestItem>, version: "2" | "3") => {
  const resolved = new Map<string, { readonly content: boolean; readonly core: boolean }>();
  const own = (item: ManifestItem) => ({
    content:
      isBlessedItemType(item.mediaType, version) || isDeprecatedBlessedItemType(item.mediaType),
    core:
      (version === "2" && isBlessedImageType(item.mediaType, version)) ||
      MediaTypes.isCore(item.mediaType),
  });
  // Annotated, as it is recursive: undefined for an item that never resolves.
  const resolve = (
    item: ManifestItem,
    visiting: Set<string>,
  ): { readonly content: boolean; readonly core: boolean } | undefined => {
    const known = resolved.get(item.id);
    if (known !== undefined) return known;
    if (visiting.has(item.id)) return undefined;
    const fallback = item.fallback === undefined ? undefined : items.get(item.fallback);
    let { content, core } = own(item);
    if (fallback !== undefined) {
      visiting.add(item.id);
      const inherited = resolve(fallback, visiting);
      visiting.delete(item.id);
      if (inherited === undefined) return undefined;
      content ||= inherited.content;
      core ||= inherited.core;
    }
    const styleId = Xml.attribute(item.element, "fallback-style")?.trim() ?? "";
    const style = version === "2" && styleId !== "" ? items.get(styleId) : undefined;
    if (style !== undefined && isStyleType(style.mediaType)) {
      content = true;
      core = true;
    }
    resolved.set(item.id, { content, core });
    return { content, core };
  };
  const of = (item: ManifestItem) => resolve(item, new Set()) ?? own(item);
  return {
    content: (item: ManifestItem) => of(item).content,
    core: (item: ManifestItem | undefined) => item !== undefined && of(item).core,
  };
};
