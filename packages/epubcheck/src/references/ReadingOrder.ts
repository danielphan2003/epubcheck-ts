import { keyedSuggestion } from "../messages/MessageCatalog.ts";
import * as UrlFragment from "../util/UrlFragment.ts";
import type { Finding } from "./Collect.ts";
import * as Url from "./Url.ts";

// Upstream's reading order check, over the `toc` links of the Navigation Documents (NAV-011) and
// the text links of the Media Overlays (MED-015): a link to a spine item must follow the spine,
// then the document order of the ID its fragment names.

export interface Context {
  // The media type of each manifest item, by container path.
  readonly items: ReadonlyMap<string, { readonly mediaType: string }>;
  // The container path of each itemref's item, in spine order.
  readonly spine: ReadonlyArray<string>;
  // The position of each ID in each document, in document order.
  readonly ids: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly locale?: string | undefined;
}

// One sequence of links. Each call answers which order the link breaks, if any.
export const sequence = ({ items, spine, ids }: Context) => {
  let lastSpine = -1;
  let lastAnchor = -1;
  return ({ target, fragment }: Url.Resolved) => {
    if (target.kind !== "local") return undefined;
    const item = items.get(target.path);
    // An item listed twice is placed at its last itemref.
    const position = spine.lastIndexOf(target.path);
    if (item === undefined || position < 0) return undefined;
    if (position < lastSpine) {
      lastSpine = position;
      lastAnchor = -1;
      return "spine" as const;
    }
    if (position > lastSpine) {
      lastSpine = position;
      lastAnchor = -1;
    }
    // A fragment that names no ID points at the document's start; an unknown ID is not placed.
    const id = UrlFragment.parse(fragment ?? "", item.mediaType).id;
    const anchor = id.trim() === "" ? 0 : (ids.get(target.path)?.get(id) ?? -2) + 1;
    if (anchor < 0) return undefined;
    const broken = anchor < lastAnchor;
    lastAnchor = anchor;
    return broken ? ("document" as const) : undefined;
  };
};

// How upstream words the order a link breaks, in the report's locale.
export const orderName = (order: "spine" | "document", locale: string | undefined) =>
  keyedSuggestion("NAV-011", order, locale);

export interface TocLink {
  readonly resolved: Url.Resolved;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

// The `toc` links of every Navigation Document form one sequence.
export const tocFindings = (links: ReadonlyArray<TocLink>, context: Context) => {
  const next = sequence(context);
  return links.flatMap(({ resolved, path, line, column }): Array<Finding> => {
    const order = next(resolved);
    if (order === undefined) return [];
    const args = ["toc", Url.referenceName(resolved), orderName(order, context.locale)];
    return [{ id: "NAV-011", args, path, line, column }];
  });
};
