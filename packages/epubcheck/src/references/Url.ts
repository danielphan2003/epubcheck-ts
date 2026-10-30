import { domainToUnicode } from "node:url";

import * as JavaText from "../util/JavaText.ts";
import { percentDecode } from "../util/UrlFragment.ts";

// URL parsing as upstream does it while it reads a document: each URL string is resolved against
// the document (or its `base`), checked against the URL standard's syntax rules (RSC-020), and
// relative URLs must stay in the container (RSC-026) and have no query (RSC-033).

export interface Problem {
  readonly id: "RSC-020" | "RSC-026" | "RSC-030" | "RSC-033";
  readonly args: ReadonlyArray<string>;
}

// Where a URL points once resolved: a container path, a remote URL, or a data URL.
export type Target =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "remote"; readonly url: string; readonly scheme: string }
  | { readonly kind: "data"; readonly url: string; readonly mediaType: string };

export interface Resolved {
  readonly target: Target;
  // What follows `#`, as written; undefined without a `#`.
  readonly fragment: string | undefined;
}

const CONTAINER = "https://ocf.epubcheck.invalid/";
// Upstream resolves each URL against two test bases to tell absolute URLs and container leaks.
const TEST_A = "https://a.example.org/A/";
const TEST_B = "https://b.example.org/B/";
const SPECIAL = new Set(["ftp", "file", "gopher", "http", "https", "ws", "wss"]);

const isUrlCodePoint = (code: number) =>
  /[A-Za-z0-9!$&'()*+,\-./:;=?@_~]/.test(String.fromCodePoint(code)) ||
  (code >= 0xa0 &&
    code <= 0x10fffd &&
    !(code >= 0xd800 && code <= 0xdfff) &&
    !(code >= 0xfdd0 && code <= 0xfdef) &&
    (code & 0xfffe) !== 0xfffe);

// The container path as a URL path: upstream's normalized form, which its messages show.
export const encodePath = (path: string) => {
  let encoded = "";
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80 && isUrlCodePoint(code) && char !== "?") encoded += char;
    else {
      for (const byte of new TextEncoder().encode(char)) {
        encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return encoded;
};

const describe = (char: string) =>
  char === " " ? "space is not allowed" : `“${char}” is not allowed`;

// The first syntax error galimatias, upstream's URL library, reports in strict mode.
export const syntaxProblem = (input: string) => {
  const value = JavaText.trim(input);
  if (/[\t\n\r]/.test(value)) return "Tab, new line or carriage return found";
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  let rest = scheme === undefined ? value : value.slice(scheme.length + 1);
  let part = "path segment";
  if (scheme !== undefined && !SPECIAL.has(scheme)) part = "scheme data";
  else if (scheme !== undefined && !rest.startsWith("//")) {
    if (scheme !== "file") return 'Expected a slash ("/")';
  }
  // File URLs have hosts and paths of their own, which upstream accepts as written.
  if (part === "path segment" && scheme !== "file" && rest.startsWith("//")) {
    // Extra slashes before the host are skipped, with a complaint.
    const slashes = /^[/\\]*/.exec(rest.slice(2))?.[0].length ?? 0;
    const after = rest.slice(2 + slashes);
    const end = after.search(/[/\\?#]/);
    const authority = end < 0 ? after : after.slice(0, end);
    rest = end < 0 ? "" : after.slice(end);
    const at = authority.lastIndexOf("@");
    if (authority.slice(0, Math.max(at, 0)).includes("@")) {
      return 'User or password contains an at symbol ("@") not percent-encoded';
    }
    const host = authority.slice(at + 1);
    const close = host.startsWith("[") ? host.indexOf("]") : -1;
    if (host.startsWith("[") && (close < 0 || !/^(?::|$)/.test(host.slice(close + 1)))) {
      return "Invalid host: Unmatched '['";
    }
    const colon = host.startsWith("[") ? close + 1 : host.lastIndexOf(":");
    const name = colon < 0 || colon >= host.length ? host : host.slice(0, colon);
    const port = colon < 0 || colon >= host.length ? undefined : host.slice(colon + 1);
    if (name === "") return "Invalid host: empty host";
    if (!name.startsWith("[")) {
      const decoded = name.replace(/%[0-9A-Fa-f]{2}/g, (escape) =>
        String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
      );
      const invalid = /[ #%/:?@[\\\]]/.exec(decoded)?.[0];
      if (invalid !== undefined)
        return `Invalid host: Illegal character in domain: ${describe(invalid)}`;
    }
    const portCharacter = /[^0-9]/.exec(port ?? "")?.[0];
    if (portCharacter !== undefined) return `Illegal character in port: ${describe(portCharacter)}`;
    if (port !== undefined && Number(port) > 65535) return "Port number must be less than 65536";
    if (slashes > 0) return "Unexpected slash or backslash";
  }
  for (let index = 0; index < rest.length;) {
    const code = rest.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    index += char.length;
    if (char === "?" && part !== "fragment" && part !== "query") part = "query";
    else if (char === "#" && part !== "fragment") part = "fragment";
    else if (char === "\\" && part === "path segment") {
      return 'Backslash ("\\") used as path segment delimiter';
    } else if (char === "%" && !/^[0-9A-Fa-f]{2}/.test(rest.slice(index))) {
      return 'Percentage ("%") is not followed by two hexadecimal digits';
    } else if (char === "#" || (char !== "%" && !isUrlCodePoint(code))) {
      return `Illegal character in ${part}: ${describe(char)}`;
    }
  }
  return undefined;
};

const parse = (input: string, base: string) => {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
};

// A remote URL with upstream's path normalization: decoded, NFC, then encoded again.
const normalizeRemote = (url: URL) => {
  const copy = new URL(url.href);
  if (copy.pathname.startsWith("/")) {
    copy.pathname = encodePath(percentDecode(copy.pathname).normalize("NFC"));
  }
  copy.hash = "";
  return copy.href;
};

// A fragment as upstream's URLs hold it: controls and non-ASCII characters percent-encoded,
// and escapes of unreserved characters decoded.
const normalizeFragment = (fragment: string) => {
  let encoded = "";
  for (const char of fragment) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code < 0x7f) encoded += char;
    else {
      for (const byte of new TextEncoder().encode(char)) {
        encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return encoded.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9._~-]/.test(char) ? char : escape;
  });
};

// How upstream's reports name a reference's target: its container path as a URL, or its URL,
// with any fragment.
export const referenceName = ({ target, fragment }: Resolved) => {
  const name = target.kind === "local" ? encodePath(target.path) : target.url;
  return fragment === undefined ? name : `${name}#${normalizeFragment(fragment)}`;
};

// How upstream's messages name a resource: its container path, or its URL.
export const nameOf = (target: Target) =>
  target.kind === "local" ? encodePath(target.path) : target.url;

// Galimatias shows the domains of special schemes in Unicode, and other hosts as written.
const host = (url: URL) =>
  (SPECIAL.has(url.protocol.slice(0, -1)) && !url.hostname.startsWith("[")
    ? domainToUnicode(url.hostname)
    : url.hostname) + (url.port === "" ? "" : `:${url.port}`);

// How upstream names a remote manifest item: galimatias's human form, percent-decoded, with
// Unicode domains.
export const humanName = (href: string) => {
  const url = parse(href.trim(), CONTAINER);
  if (url === undefined) return href;
  const user = url.username + (url.password === "" ? "" : `:${url.password}`);
  const authority =
    url.host === "" && !url.href.startsWith(`${url.protocol}//`)
      ? ""
      : `//${user === "" ? "" : `${percentDecode(user)}@`}${host(url)}`;
  const part = (prefix: string, value: string) =>
    value === "" && !url.href.includes(prefix) ? "" : prefix + percentDecode(value.slice(1));
  return (
    url.protocol +
    authority +
    percentDecode(url.pathname) +
    part("?", url.search) +
    part("#", url.hash)
  );
};

// A remote manifest item's key, as references to it resolve.
export const remoteKey = (href: string) => {
  const url = parse(href.trim(), CONTAINER);
  return url === undefined ? href : normalizeRemote(url);
};

// What a resolved URL is: in the container or elsewhere, and what its key is. The annotation
// keeps each `kind` literal.
const targetOf = (url: URL): Target => {
  if (url.protocol === "data:") {
    const header = url.href.slice("data:".length).split(",")[0] ?? "";
    return { kind: "data", url: url.href, mediaType: header.split(";")[0] ?? "" };
  }
  if (url.origin === new URL(CONTAINER).origin) {
    return { kind: "local", path: percentDecode(url.pathname.slice(1)).normalize("NFC") };
  }
  return { kind: "remote", url: normalizeRemote(url), scheme: url.protocol.slice(0, -1) };
};

// The URL checker of one document (or style sheet): it remembers the base, and once it has seen
// an absolute URL it no longer reports queries or leaks in that document, as upstream does.
export const checker = (documentPath: string, options: { readonly container: boolean }) => {
  let base = CONTAINER + encodePath(documentPath);
  let testA = TEST_A + encodePath(documentPath);
  let testB = TEST_B + encodePath(documentPath);
  let remoteBase = false;

  const resolve = (input: string, isBase: boolean) => {
    const problems: Array<Problem> = [];
    if (input.startsWith("file:")) problems.push({ id: "RSC-030", args: [input] });
    const value = input.startsWith("data:") ? input.replace(/[ \t\n\v\f\r]/g, "") : input;
    const url = parse(value, base);
    const syntax = syntaxProblem(value);
    if (syntax !== undefined) problems.push({ id: "RSC-020", args: [value, syntax] });
    if (url === undefined) return { problems, url };
    const a = parse(value, testA)?.href ?? "";
    const b = parse(value, testB)?.href ?? "";
    if (isBase) {
      testA = a;
      testB = b;
    }
    if (remoteBase) return { problems, url };
    if (!a.startsWith("https://a.example.org/") || !b.startsWith("https://b.example.org/")) {
      remoteBase = true;
      return { problems, url };
    }
    // galimatias keeps an empty query, which `search` does not show.
    const hash = url.href.indexOf("#");
    if ((hash < 0 ? url.href : url.href.slice(0, hash)).includes("?")) {
      problems.push({ id: "RSC-033", args: [value] });
      url.search = "";
    }
    if (options.container && !isBase && (!a.startsWith(TEST_A) || !b.startsWith(TEST_B))) {
      problems.push({ id: "RSC-026", args: [value] });
    }
    return { problems, url };
  };

  return {
    check: (input: string) => {
      const { problems, url } = resolve(input, false);
      const hash = input.indexOf("#");
      const scheme = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input)?.[1]?.toLowerCase();
      // An absolute URL only the WHATWG parser rejects is still a remote URL upstream.
      if (
        url === undefined &&
        scheme !== undefined &&
        problems.every(({ id }) => id !== "RSC-020")
      ) {
        remoteBase = true;
        const target: Target = { kind: "remote", url: input.trim().split("#")[0] ?? "", scheme };
        const resolved: Resolved = {
          target,
          fragment: hash < 0 ? undefined : input.slice(hash + 1),
        };
        return { problems, resolved };
      }
      if (url === undefined) return { problems, resolved: undefined };
      const resolved: Resolved = {
        target: targetOf(url),
        fragment: hash < 0 ? undefined : input.slice(hash + 1),
      };
      return { problems, resolved };
    },
    // A `base` element or `xml:base` attribute: later URLs resolve against it.
    setBase: (input: string) => {
      const { problems, url } = resolve(input, true);
      if (url !== undefined) base = url.href;
      return problems;
    },
  };
};

export type Checker = ReturnType<typeof checker>;
