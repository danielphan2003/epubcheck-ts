import * as Result from "effect/Result";

import * as ContentRules from "../content/ContentRules.ts";
import * as CssChecker from "../css/CssChecker.ts";
import type { MessageId } from "../messages/MessageCatalog.ts";
import * as MediaTypes from "../resources/MediaTypes.ts";
import * as JavaText from "../util/JavaText.ts";
import type { TocLink } from "./ReadingOrder.ts";
import * as Xml from "../xml/Xml.ts";
import * as Url from "./Url.ts";

// Reads the URLs a content document or style sheet points at, as upstream does while it parses
// them: each URL is checked where it appears, and those that point at publication resources are
// collected, with what kind of use each is, for the checks that need the whole publication.

export type ReferenceType =
  | "hyperlink"
  | "image"
  | "stylesheet"
  | "script"
  | "audio"
  | "video"
  | "track"
  | "font"
  | "iframe"
  | "object"
  | "embed"
  // CSS `url()` values outside `@font-face`, and `input` images.
  | "generic"
  | "svg-symbol"
  // SVG `fill` and `stroke`, and `clip-path`, URL values.
  | "svg-paint"
  | "svg-clip-path"
  | "cite"
  // A Search Key Map's link to dictionary content.
  | "search-key"
  // A Media Overlay's link to the content it narrates.
  | "overlay-text"
  // A link of a region-based nav, which must point to a fixed-layout item (NAV-009).
  | "region-based-nav";

export interface Finding {
  readonly id: MessageId;
  readonly args: ReadonlyArray<string>;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface Reference {
  readonly type: ReferenceType;
  readonly target: Url.Target;
  readonly fragment: string | undefined;
  // The media type the referencing element declares (a `type` attribute), if any.
  readonly mediaType?: string | undefined;
  // The referencing element's local name.
  readonly element?: string | undefined;
  // Whether the reference needs no manifest fallback: an image in `picture`, an `object` with
  // content, or a media source next to one of a core media type.
  readonly intrinsicFallback?: boolean | undefined;
  // Whether the document loads it as one of its resources, which decides the `remote-resources`
  // and `svg` manifest properties.
  readonly resource: boolean;
  // Where the reference appears: document path and position.
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface Context {
  readonly version: "2" | "3";
  // False for a single document, which has no container to resolve references in.
  readonly container: boolean;
  // The media type of a resource in a publication: its manifest item's, or a data URL's own.
  readonly mediaTypeOf?: ((target: Url.Target) => string | undefined) | undefined;
  // Media Overlays styling classes the package does not declare, with their properties, which a
  // selector using them is reported for (CSS-029).
  readonly undeclaredClasses?: ReadonlyArray<readonly [string, string]> | undefined;
  // The reporting locale, which CSS syntax errors are worded in.
  readonly locale?: string | undefined;
  // Whether the document is a Navigation Document, which upstream's NavHandler reads too.
  readonly navigation?: boolean | undefined;
  // Whether the document is a Data Navigation Document, whose `nav` elements may be region-based.
  readonly dataNav?: boolean | undefined;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const OPS_NS = "http://www.idpf.org/2007/ops";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

export interface Features {
  readonly scripted: boolean;
  // A JavaScript `script` or an event handler (upstream's HAS_SCRIPTS); forms are only scripted.
  readonly scripts: boolean;
  readonly svg: boolean;
  readonly mathml: boolean;
  readonly switch: boolean;
  readonly remoteResources: boolean;
  // Where the first `epub:type="dictionary"` element is.
  readonly dictionary: { readonly line: number; readonly column: number } | undefined;
  // Content that allows the `index` and `glossary` properties.
  readonly index: boolean;
  readonly glossary: boolean;
  // Whether the document has a style sheet or `style` element (not just `style` attributes).
  readonly styled: boolean;
  // Whether a nav of a Navigation Document is a page list (upstream's PAGE_LIST feature).
  readonly pageList: boolean;
  // Page break markers, and Microdata (the first `itemscope`) or RDFa (a `property`).
  readonly pagebreak: boolean;
  readonly microdata: { readonly line: number; readonly column: number } | undefined;
  readonly rdfa: boolean;
  // Where each `style` element or attribute whose CSS uses remote resources starts.
  readonly remoteStyles: ReadonlyArray<number>;
}

// HTML's srcset candidates: a URL (which may itself contain commas, as data URLs do), then
// optional descriptors up to the next comma.
export const srcsetUrls = (value: string) => {
  const urls: Array<string> = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index] ?? "")) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index] ?? "")) index++;
    let url = value.slice(start, index);
    // A data URL may be wrapped after its comma; its payload continues on the next line.
    if (url.startsWith("data:") && url.endsWith(",")) {
      while (index < value.length && /\s/.test(value[index] ?? "")) index++;
      const payload = index;
      while (index < value.length && !/\s/.test(value[index] ?? "")) index++;
      url += value.slice(payload, index);
    }
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      let depth = 0;
      while (index < value.length) {
        const char = value[index];
        if (char === "(") depth++;
        else if (char === ")") depth--;
        else if (char === "," && depth <= 0) break;
        index++;
      }
    }
    if (url !== "") urls.push(url);
  }
  return urls;
};

const SCRIPT_TYPES = new Set([
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// Upstream counts only these event handler attributes as scripting.
const EVENT_HANDLERS = new Set(
  (
    "onafterprint onbeforeprint onbeforeunload onerror onhaschange onload onmessage onoffline " +
    "onpagehide onpageshow onpopstate onredo onresize onstorage onundo onunload onblur onchange " +
    "oncontextmenu onfocus onformchange onforminput oninput oninvalid onreset onselect onsubmit " +
    "onkeydown onkeypress onkeyup onabort oncanplay oncanplaythrough ondurationchange onemptied " +
    "onended onloadeddata onloadedmetadata onloadstart onpause onplay onplaying onprogress " +
    "onratechange onreadystatechange onseeked onseeking onstalled onsuspend ontimeupdate " +
    "onvolumechange onwaiting onclick ondblclick ondrag ondragend ondragenter ondragleave " +
    "ondragover ondragstart ondrop onmousedown onmousemove onmouseout onmouseover onmouseup " +
    "onmousewheel onscroll"
  ).split(" "),
);

// A `script` with another type (a module, or a data block) does not make content scripted.
const isScript = (element: Xml.XmlElement) => {
  const type = Xml.attribute(element, "type");
  return type === undefined || SCRIPT_TYPES.has(type.toLowerCase());
};

const BLESSED_IMAGES = new Set([
  "image/gif",
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/avif",
  "image/jxl",
]);

// What a `type` attribute must agree with: the codecs of MP4 and Ogg audio, and no other
// parameters.
const declaredType = (value: string) => {
  const parsed = MediaTypes.parse(value);
  if (parsed === undefined) return "";
  const codecs = parsed.parameters.get("codecs");
  const audio = parsed.essence === "audio/mp4" || parsed.essence === "audio/ogg";
  return MediaTypes.serialize({
    essence: parsed.essence,
    parameters: new Map<string, string>(audio && codecs !== undefined ? [["codecs", codecs]] : []),
  });
};
// Upstream compares parsed types, whose parameters are unordered.
const canonical = (value: string) => {
  const parsed = MediaTypes.parse(value);
  if (parsed === undefined) return "";
  const sorted = [...parsed.parameters].sort(([left], [right]) => (left < right ? -1 : 1));
  return JSON.stringify([parsed.essence, sorted]);
};

// The URLs an SVG element links to: `xlink:href` in EPUB 2, and `href` too in EPUB 3.
const svgHrefs = (element: Xml.XmlElement, epub3: boolean) => {
  const xlink = Xml.attribute(element, "href", XLINK_NS);
  if (!epub3) return xlink === undefined ? [] : [xlink];
  const href = Xml.attribute(element, "href");
  if (href === undefined) return xlink === undefined ? [] : [xlink];
  return xlink === undefined || xlink === href ? [href] : [href, xlink];
};

// Java's `\s`, which upstream splits `epub:type` values on: ASCII whitespace only.
const JAVA_SPACE = /[ \t\n\v\f\r]+/;

const SVG_URL_PROPERTIES = [
  ["fill", "svg-paint"],
  ["stroke", "svg-paint"],
  ["clip-path", "svg-clip-path"],
] as const;

// The nav types upstream's NavHandler reads, in the order it tests them: the last one wins.
const NAV_TYPES = ["toc", "page-list", "landmarks"] as const;

// References, URL findings and features of an XHTML or SVG content document; for a Navigation
// Document, also the rules of its navs and the `toc` links to check the reading order of.
export const fromDocument = (document: Xml.XmlDocument, path: string, context: Context) => {
  const references: Array<Reference> = [];
  const findings: Array<Finding> = [];
  const urls = Url.checker(path, context);
  const epub3 = context.version === "3";
  const isSvgDocument = document.root.ns === SVG_NS;
  // Upstream lowercases `type`, a case-insensitive attribute, on XHTML elements in EPUB 3 XHTML.
  const typeAttribute = (element: Xml.XmlElement) => {
    const value = Xml.attribute(element, "type");
    return epub3 && !isSvgDocument && element.ns === XHTML_NS ? value?.toLowerCase() : value;
  };
  let scripted = false;
  let scripts = false;
  let svg = false;
  let mathml = false;
  let hasSwitch = false;
  let remoteResources = false;
  let dictionary: Features["dictionary"];
  let index = false;
  let glossary = false;
  let styled = false;
  let pageList = false;
  let pagebreak = false;
  let microdata: Features["microdata"];
  let rdfa = false;
  const remoteStyles: Array<number> = [];
  const tocLinks: Array<TocLink> = [];
  let regionBased = false;
  let navType: (typeof NAV_TYPES)[number] | undefined;

  interface Position {
    readonly line: number;
    readonly column: number;
  }
  // Upstream locates most references at the start tag, and some at the end tag.
  const start = (element: Xml.XmlElement) => ({ line: element.line, column: element.column });
  const end = (element: Xml.XmlElement) => ({ line: element.endLine, column: element.endColumn });
  const check = (url: string | undefined, at: Position) => {
    if (url === undefined) return undefined;
    const { problems, resolved } = urls.check(url);
    for (const problem of problems) findings.push({ ...problem, path, ...at });
    return resolved;
  };
  const register = (
    resolved: Url.Resolved | undefined,
    type: ReferenceType,
    element: Xml.XmlElement,
    at: Position,
    options: { readonly resource?: boolean; readonly intrinsicFallback?: boolean } = {},
  ) => {
    if (resolved === undefined) return;
    const mediaType = typeAttribute(element)?.trim();
    const { resource = false, intrinsicFallback = false } = options;
    references.push({
      ...resolved,
      type,
      mediaType,
      element: element.local,
      resource,
      intrinsicFallback,
      path,
      ...at,
    });
  };
  const mediaTypeOf = (resolved: Url.Resolved | undefined) =>
    resolved === undefined ? undefined : context.mediaTypeOf?.(resolved.target);
  // An element's `type` must agree with the manifest (OPF-013); what applies is the declared type
  // if there is one.
  const typeOf = (
    resolved: Url.Resolved | undefined,
    declared: string | undefined,
    at: Position,
  ) => {
    const actual = mediaTypeOf(resolved);
    if (declared === undefined || actual === undefined || resolved === undefined) return actual;
    const expected = declaredType(declared);
    if (canonical(expected) !== canonical(actual)) {
      const args = [Url.nameOf(resolved.target), declared, actual];
      findings.push({ id: "OPF-013", args, path, ...at });
    }
    return expected;
  };
  let inPicture = false;
  // Upstream's checks of `picture` images: `img` must be a core image type, and `source` too
  // unless it declares its type. Only manifest items are checked, not data URLs.
  const pictureImage = (element: Xml.XmlElement, resolved: Url.Resolved | undefined) => {
    const actual = mediaTypeOf(resolved);
    if (!inPicture || actual === undefined || resolved === undefined) return;
    if (resolved.target.kind === "data") return;
    const args = [Url.nameOf(resolved.target), actual];
    const type = (typeAttribute(element) ?? "").trim();
    if (element.local === "img") {
      if (!BLESSED_IMAGES.has(actual))
        findings.push({ id: "MED-003", args, path, ...start(element) });
    } else if (type === "") {
      if (!BLESSED_IMAGES.has(actual))
        findings.push({ id: "MED-007", args, path, ...start(element) });
    } else typeOf(resolved, type, start(element));
  };
  const images = (element: Xml.XmlElement) => {
    // Upstream checks an image's `src` and `srcset` URLs once each, in sorted order.
    const src = Xml.attribute(element, "src");
    const sources = new Set(srcsetUrls(Xml.attribute(element, "srcset") ?? ""));
    if (src !== undefined) sources.add(src);
    for (const url of [...sources].sort()) {
      const resolved = resource(url, start(element));
      pictureImage(element, resolved);
      register(resolved, "image", element, start(element), {
        resource: true,
        intrinsicFallback: inPicture,
      });
    }
  };
  // Audio and video references take their type from the resource: audio played by a `video`
  // element is audio.
  const media = (
    element: Xml.XmlElement,
    resolved: Url.Resolved | undefined,
    mediaType: string | undefined,
    at: Position,
    intrinsicFallback: boolean,
  ) => {
    const type = mediaType !== undefined && MediaTypes.isAudio(mediaType) ? "audio" : "video";
    register(resolved, type, element, at, { resource: true, intrinsicFallback });
  };
  // Upstream's resource URLs: blank ones are ignored, and remote ones need `remote-resources`.
  const resource = (url: string | undefined, at: Position) => {
    if (url === undefined || url.trim() === "") return undefined;
    const resolved = check(url, at);
    if (resolved?.target.kind === "remote") remoteResources = true;
    return resolved;
  };
  const addResource = (element: Xml.XmlElement, url: string | undefined, type: ReferenceType) =>
    register(resource(url, start(element)), type, element, start(element), { resource: true });
  const hyperlink = (element: Xml.XmlElement, href: string | undefined) => {
    if (href === undefined) return;
    const trimmed = JavaText.trim(href);
    if (trimmed === "") {
      findings.push({ id: "HTM-045", args: [], path, ...start(element) });
      return;
    }
    if (trimmed === ".") return;
    const resolved = check(trimmed, start(element));
    // Remote hyperlinks are not publication resources.
    if (resolved === undefined || resolved.target.kind === "remote") return;
    register(resolved, "hyperlink", element, start(element));
    if (epub3 && resolved.target.kind === "data") {
      findings.push({ id: "RSC-029", args: [], path, ...start(element) });
    } else if (regionBased) register(resolved, "region-based-nav", element, start(element));
  };
  const fonts: Array<{ readonly embedded: boolean; readonly name: string }> = [];
  // A `style` element or attribute, its lines counted from its element's.
  const css = (text: string, line: number, styleAttribute: boolean) => {
    const offset = Math.max(line - 1, 0);
    const found = CssChecker.check(text, { path, context, offset, styleAttribute });
    references.push(...found.references);
    findings.push(...found.findings);
    fonts.push(...found.fonts);
    if (found.ended && found.remote) remoteStyles.push(offset);
  };
  // The sources of an `audio` or `video` element, registered at its end tag, once each.
  const mediaSources = new Map<
    Xml.XmlElement,
    Map<string, { readonly resolved: Url.Resolved; readonly mediaType: string | undefined }>
  >();
  // Whether an element has content other than whitespace, for `object` fallbacks.
  const palpable = new Map<Xml.XmlElement, boolean>();

  const enter = (element: Xml.XmlElement, parent: Xml.XmlElement | undefined) => {
    const base =
      element.ns === XHTML_NS && element.local === "base"
        ? Xml.attribute(element, "href")
        : Xml.attribute(element, "base", XML_NS);
    if (base !== undefined) {
      for (const problem of urls.setBase(base)) {
        findings.push({ ...problem, path, ...start(element) });
      }
    }
    // Upstream checks a `style` element in any namespace, and counts it as CSS when it has text.
    if (element.local === "style") {
      const text = Xml.textContent(element);
      if (text.length > 0) styled = true;
      css(text, element.line, false);
    }
    if (element.ns === XHTML_NS) {
      switch (element.local) {
        case "a":
        case "area":
          hyperlink(element, Xml.attribute(element, "href"));
          break;
        case "img": {
          if (!epub3) {
            register(
              check(Xml.attribute(element, "src"), start(element)),
              "image",
              element,
              start(element),
            );
            break;
          }
          images(element);
          break;
        }
        case "object":
          if (!epub3) {
            register(
              check(Xml.attribute(element, "data"), start(element)),
              "object",
              element,
              start(element),
            );
          }
          break;
        case "link": {
          const resolved = check(Xml.attribute(element, "href"), start(element));
          // Other links (icons, alternates, ...) are not publication resources.
          const rel = Xml.attribute(element, "rel")?.toLowerCase();
          if (rel?.includes("stylesheet") === true) {
            register(resolved, "stylesheet", element, start(element));
          }
          break;
        }
        case "script":
          if (isScript(element)) scripted = scripts = true;
          if (epub3) addResource(element, Xml.attribute(element, "src"), "script");
          break;
        default:
          break;
      }
      if (epub3) {
        switch (element.local) {
          case "form":
            scripted = true;
            break;
          case "audio":
          case "video": {
            if (element.local === "video") {
              addResource(element, Xml.attribute(element, "poster"), "image");
            }
            mediaSources.set(element, new Map());
            const resolved = resource(Xml.attribute(element, "src"), start(element));
            media(element, resolved, mediaTypeOf(resolved), start(element), false);
            break;
          }
          case "picture":
            inPicture = true;
            break;
          case "track":
            addResource(element, Xml.attribute(element, "src"), "track");
            break;
          case "input":
            addResource(element, Xml.attribute(element, "src"), "generic");
            break;
          case "iframe":
            addResource(element, Xml.attribute(element, "src"), "iframe");
            break;
          case "embed": {
            const resolved = resource(Xml.attribute(element, "src"), start(element));
            typeOf(resolved, typeAttribute(element), start(element));
            register(resolved, "embed", element, start(element), { resource: true });
            break;
          }
          case "source": {
            if (parent?.local === "picture") {
              images(element);
              break;
            }
            const sources = parent === undefined ? undefined : mediaSources.get(parent);
            if (sources === undefined) break;
            const src = Xml.attribute(element, "src");
            const resolved = resource(src, start(element));
            const mediaType = typeOf(resolved, typeAttribute(element), start(element));
            if (context.container && src !== undefined && resolved !== undefined) {
              sources.set(src, { resolved, mediaType });
            }
            break;
          }
          case "blockquote":
          case "q":
          case "ins":
          case "del":
            register(
              check(Xml.attribute(element, "cite"), start(element)),
              "cite",
              element,
              start(element),
            );
            break;
          default:
            break;
        }
      }
      const style = Xml.attribute(element, "style");
      if (style !== undefined && style !== "") css(style, element.line, true);
    } else if (element.ns === SVG_NS) {
      // Upstream matches SVG element names in lowercase.
      switch (element.local.toLowerCase()) {
        case "svg":
          if (!isSvgDocument) svg = true;
          break;
        case "a":
          for (const href of svgHrefs(element, epub3)) hyperlink(element, href);
          break;
        case "image":
          for (const href of svgHrefs(element, epub3)) {
            register(check(href, start(element)), "image", element, start(element));
          }
          break;
        case "use":
          for (const href of svgHrefs(element, epub3)) {
            register(check(href, start(element)), "svg-symbol", element, start(element));
          }
          break;
        case "font-face-uri":
          for (const href of svgHrefs(element, epub3)) {
            const resolved = check(href, start(element));
            if (epub3 && resolved?.target.kind === "remote") remoteResources = true;
            register(resolved, "font", element, start(element));
          }
          break;
        case "script":
          if (isScript(element)) scripted = scripts = true;
          // Upstream reads `src`, which SVG scripts do not have, so their `href` is not checked.
          if (epub3) addResource(element, Xml.attribute(element, "src"), "script");
          break;
        default:
          break;
      }
      // Upstream reads a URL value only written exactly as `url(...)`, quoted or not.
      for (const [property, type] of SVG_URL_PROPERTIES) {
        const value = Xml.attribute(element, property);
        if (value === undefined || !value.startsWith("url(") || !value.endsWith(")")) continue;
        const inner = value.slice(4, -1);
        const quoted = inner.length > 1 && /^(["']).*\1$/s.test(inner);
        const url = quoted ? inner.slice(1, -1) : inner;
        register(check(url, start(element)), type, element, start(element));
      }
    } else if (element.ns === MATHML_NS && element.local === "math" && epub3) {
      mathml = true;
      register(
        check(Xml.attribute(element, "altimg"), start(element)),
        "image",
        element,
        start(element),
      );
    } else if (element.ns === OPS_NS && element.local === "switch") {
      hasSwitch = true;
    }
    if (epub3) {
      if (element.attributes.some((attribute) => EVENT_HANDLERS.has(attribute.local.toLowerCase())))
        scripted = scripts = true;
      const types = (Xml.attribute(element, "type", OPS_NS) ?? "").split(JAVA_SPACE);
      if (types.includes("dictionary")) dictionary ??= start(element);
      if (types.includes("index")) index = true;
      if (types.includes("glossary")) glossary = true;
      if (types.includes("pagebreak")) pagebreak = true;
      // Only a Data Navigation Document's `nav` may be region-based; any `</nav>` ends it.
      if (types.includes("region-based")) {
        if (element.local === "nav" && context.dataNav === true) regionBased = true;
        else findings.push({ id: "HTM-052", args: [], path, ...start(element) });
      }
      if (Xml.attribute(element, "itemscope") !== undefined) microdata ??= start(element);
      if (Xml.attribute(element, "property") !== undefined) rdfa = true;
    }
    // NavHandler checks each XHTML `a` again, as written, after the hyperlink checks. A nav
    // without one of its types keeps the current one; any `</nav>` ends it.
    if (context.navigation !== true || element.ns !== XHTML_NS) return;
    if (element.local === "nav") {
      const types = (Xml.attribute(element, "type", OPS_NS) ?? "").split(JAVA_SPACE);
      if (types.includes("page-list")) pageList = true;
      navType = NAV_TYPES.findLast((type) => types.includes(type)) ?? navType;
    } else if (element.local === "a") {
      const href = Xml.attribute(element, "href");
      const resolved = check(href, start(element));
      if (href === undefined || resolved === undefined || navType === undefined) return;
      // A document checked alone has its own `file:` URL, whose origin a host-less one shares.
      const remote =
        resolved.target.kind === "remote" &&
        (context.container || !resolved.target.url.startsWith("file:///"));
      if (remote) {
        findings.push({ id: "NAV-010", args: [navType, href], path, ...start(element) });
      } else if (navType === "toc") tocLinks.push({ resolved, path, ...start(element) });
    }
  };

  const exit = (element: Xml.XmlElement) => {
    if (element.local === "nav") regionBased = false;
    palpable.set(
      element,
      element.children.some((child) =>
        child.kind === "text" ? child.text.trim() !== "" : isPalpable(child, palpable),
      ),
    );
    if (context.navigation === true && element.ns === XHTML_NS && element.local === "nav") {
      navType = undefined;
    }
    if (element.ns !== XHTML_NS || !epub3) return;
    if (element.local === "picture") inPicture = false;
    if (element.local === "object") {
      const at = end(element);
      const resolved = resource(Xml.attribute(element, "data"), at);
      typeOf(resolved, typeAttribute(element), at);
      register(resolved, "object", element, at, {
        resource: true,
        intrinsicFallback: palpable.get(element) === true,
      });
    }
    const sources = mediaSources.get(element);
    if (sources === undefined) return;
    // A source of a core media type is a fallback for the others.
    const fallback = [...sources.values()].some(
      ({ mediaType }) => mediaType !== undefined && MediaTypes.isCore(mediaType),
    );
    for (const { resolved, mediaType } of sources.values()) {
      media(element, resolved, mediaType, end(element), fallback);
    }
  };

  // `<?xml-stylesheet href="..."?>` links a style sheet to an SVG document. Saxon's
  // ProcInstParser reads the pseudo-attributes as an element's attributes, so any XML error voids
  // the whole declaration.
  for (const instruction of isSvgDocument ? document.processingInstructions : []) {
    if (instruction.target !== "xml-stylesheet") continue;
    const parsed = Xml.parse(`<e ${instruction.body}/>`);
    if (Result.isFailure(parsed)) continue;
    const type = Xml.attribute(parsed.success.root, "type");
    if (type !== undefined && type.toLowerCase() !== "text/css") continue;
    const at = { line: instruction.line, column: instruction.column };
    const href = Xml.attribute(parsed.success.root, "href");
    const resolved = href === undefined ? undefined : check(href, at);
    if (resolved !== undefined) {
      references.push({ ...resolved, type: "stylesheet", resource: false, path, ...at });
    }
  }

  // Iterative, with end tags: documents can nest deeper than the call stack allows.
  const stack: Array<readonly [Xml.XmlElement, Xml.XmlElement | undefined, boolean]> = [
    [document.root, undefined, false],
  ];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const [element, parent, closing] = next;
    if (closing) {
      exit(element);
      continue;
    }
    enter(element, parent);
    stack.push([element, parent, true]);
    for (const child of Xml.childElements(element).reverse()) stack.push([child, element, false]);
  }

  const features: Features = {
    scripted,
    scripts,
    svg,
    mathml,
    switch: hasSwitch,
    remoteResources,
    dictionary,
    index,
    glossary,
    styled: styled || references.some((reference) => reference.type === "stylesheet"),
    pageList,
    pagebreak,
    microdata,
    rdfa,
    remoteStyles,
  };
  return { references, findings, features, fonts, tocLinks };
};

// A Search Key Map Document links search key groups and matches to dictionary content.
export const fromSearchKeyMap = (document: Xml.XmlDocument, path: string, context: Context) => {
  const references: Array<Reference> = [];
  const findings: Array<Finding> = [];
  const urls = Url.checker(path, context);
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const href = Xml.attribute(element, "href");
    if (element.ns !== OPS_NS || href === undefined) continue;
    if (element.local !== "search-key-group" && element.local !== "match") continue;
    const at = { path, line: element.line, column: element.column };
    const { problems, resolved } = urls.check(href);
    for (const problem of problems) findings.push({ ...problem, ...at });
    if (resolved !== undefined) {
      references.push({ ...resolved, type: "search-key", resource: false, ...at });
    }
  }
  return { references, findings };
};

// Upstream's palpable content: embedded content, text, and elements that contain either.
const isPalpable = (element: Xml.XmlElement, palpable: ReadonlyMap<Xml.XmlElement, boolean>) => {
  if (Xml.attribute(element, "hidden") !== undefined) return false;
  if (element.ns === SVG_NS) return element.local === "svg";
  if (element.ns === MATHML_NS) return element.local === "math";
  if (element.ns !== XHTML_NS) return false;
  if (EMBEDDED.has(element.local)) return true;
  if (NOT_PALPABLE.has(element.local)) return false;
  return palpable.get(element) === true;
};
const EMBEDDED = new Set([
  "audio",
  "canvas",
  "embed",
  "iframe",
  "img",
  "object",
  "picture",
  "video",
]);
const NOT_PALPABLE = new Set(["html", "head", "script", "link", "meta", "title", "style"]);

export type IdType = "svg-paint" | "svg-clip-path" | "svg-symbol" | "generic";

// The SVG elements whose IDs have a type of their own, by name in lowercase.
const SVG_ID_TYPES: Readonly<Record<string, IdType>> = {
  lineargradient: "svg-paint",
  radialgradient: "svg-paint",
  pattern: "svg-paint",
  clippath: "svg-clip-path",
  symbol: "svg-symbol",
};

const DTBOOK_NS = "http://www.daisy.org/z3986/2005/dtbook/";

// The references upstream's DTBookHandler registers: `a` and `link` hrefs as generic, except
// remote `a` hrefs marked external (OPF-021 for a scheme it does not know), and `img` sources
// as images. Any `xml:base` stays in force after its element, as in upstream's BaseURLHandler.
export const fromDtbook = (document: Xml.XmlDocument, path: string, context: Context) => {
  const references: Array<Reference> = [];
  const findings: Array<Finding> = [];
  const urls = Url.checker(path, context);
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const base = Xml.attribute(element, "base", XML_NS);
    const at = { path, line: element.line, column: element.column };
    if (base !== undefined) {
      for (const problem of urls.setBase(base)) findings.push({ ...problem, ...at });
    }
    if (element.ns !== DTBOOK_NS) continue;
    const { local } = element;
    const name = local === "img" ? "src" : local === "a" || local === "link" ? "href" : undefined;
    const url = name === undefined ? undefined : Xml.attribute(element, name);
    if (url === undefined) continue;
    const { problems, resolved } = urls.check(url);
    for (const problem of problems) findings.push({ ...problem, ...at });
    if (resolved === undefined) continue;
    const external = local === "a" && Xml.attribute(element, "external") === "true";
    if (external && resolved.target.kind === "remote") {
      if (!ContentRules.REGISTERED_SCHEMES.has(resolved.target.scheme)) {
        findings.push({ id: "OPF-021", args: [Url.humanName(url)], ...at });
      }
      continue;
    }
    const type = local === "img" ? "image" : "generic";
    references.push({ ...resolved, type, resource: false, ...at });
  }
  return { references, findings };
};

// A document's IDs as upstream registers them, with their types and positions in document order.
// The first element with an ID gives its type: an SVG paint server, clip path or symbol, or any
// other element. A DTBook document registers its own elements' IDs only.
export const documentIds = (document: Xml.XmlDocument, dtbook = false) => {
  const types = new Map<string, IdType>();
  const positions = new Map<string, number>();
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    if (dtbook && element.ns !== DTBOOK_NS) continue;
    // Upstream registers the `id` attributes, as written.
    const id = Xml.attribute(element, "id");
    if (id === undefined || types.has(id)) continue;
    const own = element.ns === SVG_NS ? SVG_ID_TYPES[element.local.toLowerCase()] : undefined;
    types.set(id, own ?? "generic");
    positions.set(id, positions.size);
  }
  return { types, positions };
};
