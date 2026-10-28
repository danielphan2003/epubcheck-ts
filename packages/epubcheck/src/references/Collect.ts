import * as Xml from "../xml/Xml.ts";

// Extracts the URLs a content document or style sheet points at, with what kind of use each is.

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
  | "svg-symbol"
  | "cite"
  | "link";

export interface Reference {
  readonly url: string;
  readonly type: ReferenceType;
  // The media type the referencing element declares (a `type` attribute), if any.
  readonly mediaType?: string | undefined;
  // Where the reference appears: document path and position.
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";

export interface Features {
  readonly scripted: boolean;
  readonly svg: boolean;
  readonly mathml: boolean;
  readonly switch: boolean;
}

// HTML's srcset candidates: a URL (which may itself contain commas, as data URLs do), then
// optional descriptors up to the next comma.
const srcsetUrls = (value: string) => {
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

const JAVASCRIPT_TYPES = new Set([
  "",
  "module",
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

// A `script` with a non-JavaScript type is a data block, which does not make content scripted.
const isExecutableScript = (element: Xml.XmlElement) =>
  JAVASCRIPT_TYPES.has((Xml.attribute(element, "type") ?? "").trim().toLowerCase());

// CSS `url(...)`, `@import "..."` and `@font-face` sources.
export const fromCss = (css: string, path: string, line = -1, column = -1) => {
  const references: Array<Reference> = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const position = (index: number) => {
    if (line >= 0) return { line, column };
    const before = withoutComments.slice(0, index);
    const lines = before.split("\n");
    return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
  };
  const fontFaces: Array<readonly [number, number]> = [];
  for (const match of withoutComments.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
    fontFaces.push([match.index, match.index + match[0].length]);
  }
  const inFontFace = (index: number) =>
    fontFaces.some(([start, end]) => index >= start && index < end);
  for (const match of withoutComments.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/gi)) {
    references.push({ url: match[2] ?? "", type: "stylesheet", path, ...position(match.index) });
  }
  for (const match of withoutComments.matchAll(/url\(\s*(["']?)([^"')]*?)\1\s*\)/gi)) {
    const before = withoutComments.slice(Math.max(0, match.index - 60), match.index);
    // `@namespace` URIs name namespaces; they are not fetched.
    if (/@import\s+$/i.test(before) || /@namespace\s+(?:[\w-]+\s+)?$/i.test(before)) continue;
    references.push({
      url: match[2] ?? "",
      type: inFontFace(match.index) ? "font" : "image",
      path,
      ...position(match.index),
    });
  }
  return references;
};

const hrefOf = (element: Xml.XmlElement) =>
  Xml.attribute(element, "href") ?? Xml.attribute(element, "href", XLINK_NS);

// References and features of an XHTML or SVG content document.
export const fromDocument = (document: Xml.XmlDocument, path: string) => {
  const references: Array<Reference> = [];
  const add = (element: Xml.XmlElement, url: string | undefined, type: ReferenceType) => {
    if (url === undefined) return;
    const mediaType = Xml.attribute(element, "type")?.trim();
    references.push({ url, type, mediaType, path, line: element.line, column: element.column });
  };
  let scripted = false;
  let svg = false;
  let mathml = false;
  let hasSwitch = false;
  const isSvgDocument = document.root.ns === SVG_NS;
  const all = [document.root, ...Xml.descendants(document.root)];
  const parentOf = new Map<Xml.XmlElement, Xml.XmlElement>();
  for (const element of all)
    for (const child of Xml.childElements(element)) parentOf.set(child, element);

  for (const element of all) {
    if (element.ns === XHTML_NS) {
      switch (element.local) {
        case "a":
        case "area":
          add(element, Xml.attribute(element, "href"), "hyperlink");
          break;
        case "link": {
          const rel = (Xml.attribute(element, "rel") ?? "").toLowerCase().split(/\s+/);
          add(
            element,
            Xml.attribute(element, "href"),
            rel.includes("stylesheet") ? "stylesheet" : "link",
          );
          break;
        }
        case "img":
          add(element, Xml.attribute(element, "src"), "image");
          for (const url of srcsetUrls(Xml.attribute(element, "srcset") ?? ""))
            add(element, url, "image");
          break;
        case "source": {
          const parent = parentOf.get(element)?.local;
          const type = parent === "audio" ? "audio" : parent === "video" ? "video" : "image";
          add(element, Xml.attribute(element, "src"), type);
          for (const url of srcsetUrls(Xml.attribute(element, "srcset") ?? ""))
            add(element, url, "image");
          break;
        }
        case "audio":
          add(element, Xml.attribute(element, "src"), "audio");
          break;
        case "video":
          add(element, Xml.attribute(element, "src"), "video");
          add(element, Xml.attribute(element, "poster"), "image");
          break;
        case "track":
          add(element, Xml.attribute(element, "src"), "track");
          break;
        case "script":
          if (isExecutableScript(element)) scripted = true;
          add(element, Xml.attribute(element, "src"), "script");
          break;
        case "form":
          scripted = true;
          break;
        case "iframe":
          add(element, Xml.attribute(element, "src"), "iframe");
          break;
        case "embed":
          add(element, Xml.attribute(element, "src"), "embed");
          break;
        case "object":
          add(element, Xml.attribute(element, "data"), "object");
          break;
        case "input":
          if ((Xml.attribute(element, "type") ?? "").toLowerCase() === "image") {
            add(element, Xml.attribute(element, "src"), "image");
          }
          break;
        case "blockquote":
        case "q":
        case "ins":
        case "del":
          add(element, Xml.attribute(element, "cite"), "cite");
          break;
        case "style":
          references.push(...fromCss(Xml.textContent(element), path));
          break;
        default:
          break;
      }
    } else if (element.ns === SVG_NS) {
      if (!isSvgDocument && element.local === "svg") svg = true;
      switch (element.local) {
        case "a":
          add(element, hrefOf(element), "hyperlink");
          break;
        case "image":
          add(element, hrefOf(element), "image");
          break;
        case "use":
          add(element, hrefOf(element), "svg-symbol");
          break;
        case "font-face-uri":
          add(element, hrefOf(element), "font");
          break;
        case "script":
          scripted = true;
          add(element, hrefOf(element), "script");
          break;
        case "style":
          references.push(...fromCss(Xml.textContent(element), path));
          break;
        default:
          break;
      }
    } else if (element.ns === MATHML_NS) {
      if (element.local === "math") {
        mathml = true;
        add(element, Xml.attribute(element, "altimg"), "image");
      }
    } else if (element.ns === "http://www.idpf.org/2007/ops" && element.local === "switch") {
      hasSwitch = true;
    }
    const style = Xml.attribute(element, "style");
    if (style !== undefined) references.push(...fromCss(style, path, element.line, element.column));
  }
  const features: Features = { scripted, svg, mathml, switch: hasSwitch };
  return { references, features };
};

export const ids = (document: Xml.XmlDocument) => {
  const found = new Set<string>();
  for (const element of [document.root, ...Xml.descendants(document.root)]) {
    const id =
      Xml.attribute(element, "id") ??
      Xml.attribute(element, "id", "http://www.w3.org/XML/1998/namespace");
    if (id !== undefined) found.add(id.trim());
  }
  return found;
};
