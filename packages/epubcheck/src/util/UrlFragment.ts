import { isNCName } from "../schema/Datatypes.ts";

// What a URL fragment identifies, depending on the target's media type: an element ID, a
// scheme-based pointer (`epubcfi(...)`), or a media fragment (`t=10`, `xywh=...`).

export interface UrlFragment {
  readonly id: string;
  readonly scheme: string;
  readonly isMediaFragment: boolean;
  readonly isValid: boolean;
}

const SCHEME_BASED = /^(\w+)\(.*\)$/s;
const MEDIA_FRAGMENT = /^(?:t|xywh|track|id|xyn|xyr)=[^&]+(?:&[^&=]+=[^&]+)*$/s;
const SVG_VIEW = /^svgView\(.+\)$/s;
const SPATIAL = /^xywh=(?:pixel:|percent:)?\d+,\d+,\d+,\d+$/;
const TEMPORAL = /^t=(?:npt:)?(?:([0-9.:]+)(?:,([0-9.:]+))?|,([0-9.:]+))$/;
const NPT_TIME = /^(?:\d+|[0-5]\d:[0-5]\d|\d+:[0-5]\d:[0-5]\d)(?:\.\d*)?$/;

const percentDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const isTimeSegment = (segment: string) => {
  const match = TEMPORAL.exec(segment);
  return (
    match !== null && match.slice(1).every((time) => time === undefined || NPT_TIME.test(time))
  );
};

const isSpaceSegment = (segment: string) => SPATIAL.test(segment);

const result = (fields: Partial<UrlFragment>): UrlFragment => ({
  id: "",
  scheme: "",
  isMediaFragment: false,
  isValid: true,
  ...fields,
});

const html = (fragment: string) => {
  // Text directives (`:~:text=...`) are not part of the element ID.
  const directive = fragment.indexOf(":~:");
  const base = directive < 0 ? fragment : fragment.slice(0, directive);
  const scheme = SCHEME_BASED.exec(base);
  if (scheme !== null) return result({ scheme: scheme[1] ?? "" });
  if (MEDIA_FRAGMENT.test(base)) return result({ isMediaFragment: true });
  return result({ id: percentDecode(base) });
};

const svg = (fragment: string) => {
  if (fragment === "") return result({});
  const [first = "", ...rest] = fragment.split("&");
  if (first.startsWith("svgView(")) {
    return result({ isValid: SVG_VIEW.test(first) && rest.every(isTimeSegment) });
  }
  if (first.startsWith("t=")) {
    return result({
      isMediaFragment: true,
      isValid: isTimeSegment(first) && rest.every(isSpaceSegment),
    });
  }
  if (first.startsWith("xywh=")) {
    return result({
      isMediaFragment: true,
      isValid: isSpaceSegment(first) && rest.every(isTimeSegment),
    });
  }
  if (first.includes("=")) return result({ isValid: false });
  const id = percentDecode(first);
  return result({ id, isValid: isNCName(id) && rest.every(isTimeSegment) });
};

const xml = (fragment: string) => {
  const scheme = SCHEME_BASED.exec(fragment);
  if (scheme !== null) return result({ scheme: scheme[1] ?? "" });
  const id = percentDecode(fragment);
  return result({ id, isValid: isNCName(id) });
};

export const parse = (fragment: string, mediaType: string) => {
  switch (mediaType) {
    case "image/svg+xml":
      return svg(fragment);
    case "text/html":
    case "application/xhtml+xml":
      return html(fragment);
    default:
      return xml(fragment);
  }
};
