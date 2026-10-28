// Media type rules of EPUB 3 publication resources: core media types, upstream's preferred
// spellings, JavaScript types, and image format sniffing.

export interface MediaType {
  // `type/subtype`, lowercased.
  readonly essence: string;
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
        return [[name, raw.replace(/^"(.*)"$/, "$1").toLowerCase()] as const];
      }),
    ),
  };
};

const CORE = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "image/avif",
  "image/jxl",
  "audio/mpeg",
  "text/css",
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/font-sfnt",
  "application/x-font-ttf",
  "application/vnd.ms-opentype",
  "application/font-woff",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "application/xhtml+xml",
  "application/x-dtbncx+xml",
  "application/smil+xml",
  "application/pls+xml",
]);

const FONTS = new Set([
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/font-sfnt",
  "application/x-font-ttf",
  "application/vnd.ms-opentype",
  "application/font-woff",
  "image/svg+xml",
]);

// MP4 audio is a core media type with AAC or Opus, and Ogg audio only with Opus.
const isCoreAudio = ({ essence, parameters }: MediaType) => {
  const codecs = parameters.get("codecs");
  if (essence === "audio/mp4") {
    return (
      codecs === undefined || codecs === "aac" || codecs.startsWith("mp4a") || codecs === "opus"
    );
  }
  return essence === "audio/ogg" && codecs === "opus";
};

export const isCore = (value: string) => {
  const type = parse(value);
  return CORE.has(type.essence) || isCoreAudio(type);
};

export const isCoreFont = (value: string) => FONTS.has(parse(value).essence);

export const isAudio = (value: string) => parse(value).essence.startsWith("audio/");

// HTML's JavaScript MIME type essences.
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

export const isJavaScript = (value: string) => JAVASCRIPT.has(parse(value).essence);

// A JavaScript type that is not a core media type (RSC-035).
export const isLegacyJavaScript = (value: string) => isJavaScript(value) && !isCore(value);

// The spelling upstream prefers for a core media type (OPF-090), if this is not it.
export const preferred = (value: string, path: string) => {
  switch (parse(value).essence) {
    case "application/font-sfnt":
      return /\.otf$/i.test(path) ? "font/otf" : "font/ttf";
    case "application/x-font-ttf":
      return "font/ttf";
    case "application/vnd.ms-opentype":
      return "font/otf";
    case "application/font-woff":
      return "font/woff";
    // Upstream prefers `application/javascript`, even over `text/javascript`.
    case "application/ecmascript":
    case "text/javascript":
      return "application/javascript";
    default:
      return undefined;
  }
};

export const sameEssence = (left: string, right: string) =>
  parse(left).essence === parse(right).essence;

export type ImageFormat = "JPEG" | "PNG" | "GIF" | "WEBP";

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

export const sniffImage = (bytes: Uint8Array): ImageFormat | undefined => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "JPEG";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "PNG";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "GIF";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "WEBP";
  }
  return undefined;
};

export const SNIFFED_TYPES: Readonly<Record<string, ImageFormat>> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
};

export const EXTENSIONS: Readonly<Record<ImageFormat, ReadonlyArray<string>>> = {
  JPEG: ["jpg", "jpeg", "jpe", "jif", "jfif", "jfi"],
  PNG: ["png"],
  GIF: ["gif"],
  WEBP: ["webp"],
};
