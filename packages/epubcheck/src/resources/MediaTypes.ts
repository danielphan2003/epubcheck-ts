// Media type rules of EPUB 3 publication resources: core media types, upstream's preferred
// spellings, JavaScript types, and image format sniffing.

import type { MessageId } from "../messages/MessageCatalog.ts";

const isToken = (char: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]$/.test(char);
const isWhitespace = (char: string) => /^[ \t\n\r]$/.test(char);
const isQuotable = (char: string) => /^[\t\x20-\x7e\x80-\xff]$/.test(char);

// Upstream's MIMETypeParser, laxer than the MIME Sniffing standard: an unquoted value keeps
// stray characters, and a quoted one its missing end quote. The essence and parameter names are
// lowercased, and the first of repeated names wins. Undefined without a `type/subtype`.
export const parse = (value: string) => {
  const chars = [...value];
  let index = 0;
  const take = (test: (char: string) => boolean) => {
    let taken = "";
    while (index < chars.length && test(chars[index] ?? "")) taken += chars[index++];
    return taken;
  };
  const skip = () => take((char) => char !== ";");
  take(isWhitespace);
  const type = take(isToken).toLowerCase();
  if (type === "" || chars[index] !== "/") return undefined;
  index++;
  const subtype = take(isToken).toLowerCase();
  take(isWhitespace);
  if (subtype === "" || (index < chars.length && chars[index] !== ";")) return undefined;
  const parameters = new Map<string, string>();
  while (index < chars.length) {
    index++;
    take(isWhitespace);
    const name = take(isToken).toLowerCase();
    if (name === "" || chars[index] !== "=") {
      skip();
      continue;
    }
    index++;
    let text: string | undefined = "";
    if (chars[index] === '"') {
      index++;
      while (text !== undefined && index < chars.length && chars[index] !== '"') {
        const char = chars[index++] ?? "";
        const escaped = char === "\\" ? chars[index++] : char;
        if (escaped === undefined) text += "\\";
        else text = isQuotable(escaped) ? text + escaped : undefined;
      }
      skip();
    } else {
      const raw = take((char) => char !== ";" && (isQuotable(char) || isWhitespace(char)));
      if (index < chars.length && chars[index] !== ";") {
        skip();
        continue;
      }
      if (raw === "") continue;
      text = raw.replace(/[ \t\n\r]+$/, "");
    }
    if (text !== undefined && !parameters.has(name)) parameters.set(name, text);
  }
  return { essence: `${type}/${subtype}`, parameters };
};

// Upstream's MIMETypeSerializer: a value is quoted unless it is a token.
export const serialize = (type: {
  readonly essence: string;
  readonly parameters: ReadonlyMap<string, string>;
}) =>
  [
    type.essence,
    ...[...type.parameters].map(([name, text]) =>
      text !== "" && [...text].every(isToken)
        ? `${name}=${text}`
        : `${name}="${text.replace(/["\\]/g, "\\$&")}"`,
    ),
  ].join(";");

// Upstream's MIMEType.normalize, which items' media types go through; "" when the value cannot be
// parsed.
export const normalize = (value: string) => {
  const parsed = parse(value);
  return parsed === undefined ? "" : serialize(parsed);
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

// Bitmaps upstream checks (BitmapChecker); WebP and others are not.
export const isBitmap = (value: string) =>
  ["image/gif", "image/jpeg", "image/png"].includes(normalize(value));

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
  if (startsWith(bytes, [0xff, 0xd8])) return "JPEG";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "gif";
  if (ascii(bytes, "BM")) return "bmp";
  if (ascii(bytes, "II*\u0000") || ascii(bytes, "MM\u0000*")) return "tif";
  return undefined;
};

// Whether a reader gets as far as the image's dimensions.
const readable = (format: ImageFormat, bytes: Uint8Array) => {
  switch (format) {
    case "png": {
      // ImageIO's PNG reader validates the whole IHDR chunk.
      if (bytes.length < 29 || !ascii(bytes, "IHDR", 12)) return false;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const [depth = 0, color = 0, compression, filter, interlace = 0] = bytes.subarray(24, 29);
      return (
        view.getUint32(8) === 13 &&
        view.getInt32(16) > 0 &&
        view.getInt32(20) > 0 &&
        [1, 2, 4, 8, 16].includes(depth) &&
        (color === 0 || (color === 3 && depth <= 8) || ([2, 4, 6].includes(color) && depth >= 8)) &&
        compression === 0 &&
        filter === 0 &&
        interlace <= 1
      );
    }
    case "gif": {
      // ImageIO reads up to the first image descriptor, past the color tables and extensions.
      const table = (packed: number) => (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0);
      let offset = 13 + table(bytes[10] ?? 0);
      while (offset < bytes.length) {
        const block = bytes[offset];
        if (block === 0x2c) {
          return offset + 10 + table(bytes[offset + 9] ?? 0) <= bytes.length;
        }
        if (block !== 0x21) return false;
        offset += 2;
        while (offset < bytes.length && bytes[offset] !== 0) offset += (bytes[offset] ?? 0) + 1;
        offset += 1;
      }
      return false;
    }
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
