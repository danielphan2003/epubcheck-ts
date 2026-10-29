// Media type rules of EPUB 3 publication resources: core media types, upstream's preferred
// spellings, JavaScript types, and image format sniffing.

import type { MessageId } from "../messages/MessageCatalog.ts";

export interface MediaType {
  // `type/subtype`, lowercased.
  readonly essence: string;
  // Parameter names lowercased, values as written.
  readonly parameters: ReadonlyMap<string, string>;
}

export const parse = (value: string): MediaType => {
  const [essence = "", ...parameters] = value.split(";");
  return {
    essence: essence.trim().toLowerCase(),
    parameters: new Map(
      parameters.flatMap((parameter) => {
        const separator = parameter.indexOf("=");
        if (separator < 0) return [];
        const name = parameter.slice(0, separator).trim().toLowerCase();
        const raw = parameter.slice(separator + 1).trim();
        return [[name, raw.replace(/^"(.*)"$/, "$1")] as const];
      }),
    ),
  };
};

// Upstream's MIMEType.normalize, which items' media types go through: the essence trimmed and in
// lower case, parameters without a value dropped, a value quoted unless it is a token; "" when
// the value cannot be parsed.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
export const normalize = (value: string) => {
  const [essence = "", ...parameters] = value.split(";");
  const type = new RegExp(`^\\s*(${TOKEN}/${TOKEN})\\s*$`).exec(essence)?.[1];
  if (type === undefined) return "";
  const kept = parameters.flatMap((parameter) => {
    const separator = parameter.indexOf("=");
    const name = parameter.slice(0, separator).trim();
    const raw = parameter.slice(separator + 1).trim();
    if (separator < 0 || !new RegExp(`^${TOKEN}$`).test(name) || raw === "") return [];
    const quoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"');
    const text = quoted ? raw.slice(1, -1) : raw;
    const written = text !== "" && new RegExp(`^${TOKEN}$`).test(text) ? text : `"${text}"`;
    return [`${name.toLowerCase()}=${written}`];
  });
  return [type.toLowerCase(), ...kept].join(";");
};

// Upstream compares normalized media types with exact strings, so any other parameter makes a
// type foreign.
const BLESSED_FONTS = new Set([
  "font/otf",
  "font/ttf",
  "font/woff",
  "font/woff2",
  "application/font-sfnt",
  "application/font-woff",
  "application/vnd.ms-opentype",
  "application/x-font-ttf",
]);
const BLESSED_SCRIPTS = new Set([
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
]);
const CORE = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/mp4;codecs=aac",
  "audio/mp4;codecs=opus",
  "audio/ogg;codecs=opus",
  ...BLESSED_FONTS,
  "application/xhtml+xml",
  "image/svg+xml",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/jxl",
  ...BLESSED_SCRIPTS,
  "text/css",
  "application/pls+xml",
  "application/smil+xml",
]);

export const isCore = (value: string) => CORE.has(normalize(value));

// The font types `@font-face` may use in EPUB 3 (CSS-007).
export const isCoreFont = (value: string) => BLESSED_FONTS.has(normalize(value));

export const isAudio = (value: string) => normalize(value).startsWith("audio/");

// Upstream's isScriptType, case-insensitive.
const JAVASCRIPT = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
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

export const isJavaScript = (value: string) => JAVASCRIPT.has(normalize(value).toLowerCase());

// A JavaScript type that is not a core media type (RSC-035).
export const isLegacyJavaScript = (value: string) =>
  isJavaScript(value) && !BLESSED_SCRIPTS.has(normalize(value));

// The spelling upstream prefers for a core media type (OPF-090), if this is not it.
export const preferred = (value: string, path: string) => {
  switch (normalize(value)) {
    case "application/font-sfnt":
      return path.endsWith(".ttf")
        ? "font/ttf"
        : path.endsWith(".otf")
          ? "font/otf"
          : "font/(ttf|otf)";
    case "application/vnd.ms-opentype":
      return "font/otf";
    case "application/font-woff":
      return "font/woff";
    case "application/x-font-ttf":
      return "font/ttf";
    // Upstream prefers `application/javascript`, even over `text/javascript`.
    case "text/javascript":
    case "application/ecmascript":
      return "application/javascript";
    default:
      return undefined;
  }
};

export const sameEssence = (left: string, right: string) =>
  parse(left).essence === parse(right).essence;

// Bitmaps upstream checks (BitmapChecker); WebP and others are not.
export const isBitmap = (value: string) =>
  ["image/gif", "image/jpeg", "image/png"].includes(parse(value).essence);

// The formats ImageIO's readers recognize, by their format names, and the suffixes they take.
type ImageFormat = "JPEG" | "png" | "gif" | "bmp" | "tif";
const SUFFIXES: Readonly<Record<string, ImageFormat>> = {
  jpg: "JPEG",
  jpeg: "JPEG",
  png: "png",
  gif: "gif",
  bmp: "bmp",
  tif: "tif",
  tiff: "tif",
};

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Uint8Array, text: string, offset = 0) =>
  startsWith(
    bytes,
    [...text].map((char) => char.charCodeAt(0)),
    offset,
  );

const sniff = (bytes: Uint8Array): ImageFormat | undefined => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "JPEG";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "gif";
  if (ascii(bytes, "BM")) return "bmp";
  if (ascii(bytes, "II*\u0000") || ascii(bytes, "MM\u0000*")) return "tif";
  return undefined;
};

// Whether a reader gets as far as the image's dimensions.
const readable = (format: ImageFormat, bytes: Uint8Array) => {
  switch (format) {
    case "png":
      return bytes.length >= 24 && ascii(bytes, "IHDR", 12);
    case "gif":
      return bytes.length >= 10;
    case "bmp":
      return bytes.length >= 26;
    case "tif":
      return bytes.length >= 8;
    case "JPEG": {
      // A start-of-frame marker carries the dimensions.
      let offset = 2;
      while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
        const marker = bytes[offset + 1] ?? 0;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return offset + 9 <= bytes.length;
        }
        offset += 2 + (((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
      }
      return false;
    }
  }
};

// Upstream's BitmapChecker: the header must suit the declared type (OPF-029, MED-004), then the
// format ImageIO reads must be the one the file name's suffix names (PKG-022, PKG-021).
export const imageProblems = (bytes: Uint8Array, path: string, mediaType: string) => {
  const problems: Array<{ readonly id: MessageId; readonly args: ReadonlyArray<string> }> = [];
  if (bytes.length < 4) problems.push({ id: "MED-004", args: [] });
  else {
    const passed =
      mediaType === "image/jpeg"
        ? startsWith(bytes, [0xff, 0xd8])
        : mediaType === "image/gif"
          ? ascii(bytes, "GIF8")
          : mediaType !== "image/png" || ascii(bytes, "\u0089PNG");
    if (!passed) problems.push({ id: "OPF-029", args: [path, mediaType] });
  }
  const dot = path.lastIndexOf(".");
  const suffix = dot < 0 ? undefined : path.slice(dot + 1);
  if (suffix?.toLowerCase() === "svg") return problems;
  const content = sniff(bytes);
  const named = suffix === undefined ? undefined : SUFFIXES[suffix.toLowerCase()];
  if (content !== undefined && named === content) {
    if (!readable(content, bytes)) problems.push({ id: "PKG-021", args: [] });
  } else if (content !== undefined && named !== undefined && suffix !== undefined) {
    problems.push({ id: "PKG-022", args: [content, suffix] });
  } else problems.push({ id: "PKG-021", args: [] });
  return problems;
};
