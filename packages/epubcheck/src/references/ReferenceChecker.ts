import type { MessageId } from "../messages/MessageCatalog.ts";
import type { ManifestItem } from "../opf/PackageDocument.ts";
import * as UrlFragment from "../util/UrlFragment.ts";
import type { Features, Reference, ReferenceType } from "./Collect.ts";

// Checks every reference once all documents are read: the target must be in the container and
// the manifest, remote resources are allowed only for audio, video and fonts, and fragments
// must point at existing IDs.

export interface Finding {
  readonly id: MessageId;
  readonly args: ReadonlyArray<string>;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

// Paths are NFC-normalized: an href and a container name may use different normalization forms.
export interface Publication {
  readonly packagePath: string;
  readonly files: ReadonlySet<string>;
  readonly items: ReadonlyMap<string, ManifestItem>;
  // Remote manifest items by URL without fragment.
  readonly remoteItems: ReadonlyMap<string, ManifestItem>;
  readonly spine: ReadonlySet<string>;
  readonly ids: ReadonlyMap<string, ReadonlySet<string>>;
}

const REMOTE_ALLOWED = new Set<ReferenceType>(["audio", "video", "font"]);
// Hyperlinks, citations and non-stylesheet `link` elements are not fetched as publication resources.
const NAVIGATION = new Set<ReferenceType>(["hyperlink", "cite", "link"]);

const isRemoteMediaType = (mediaType: string | undefined) =>
  mediaType !== undefined &&
  /^(?:audio|video|font)\/|^application\/(?:font|x-font|vnd\.ms-opentype)/.test(mediaType);
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const SPECIAL = new Set(["http", "https", "ftp", "ws", "wss"]);
const CONTENT_TYPES = new Set(["application/xhtml+xml", "image/svg+xml"]);

const finding = (reference: Reference, id: MessageId, ...args: ReadonlyArray<string>): Finding => ({
  id,
  args,
  path: reference.path,
  line: reference.line,
  column: reference.column,
});

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// Resolves a relative URL against the referencing document's container path; undefined when it
// climbs out of the container.
const resolve = (url: string, from: string) => {
  const segments = from.split("/").slice(0, -1);
  for (const segment of url.split("/")) {
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else if (segment !== "." && segment !== "") segments.push(segment);
  }
  return decode(segments.join("/"));
};

// Without a publication (a single document check), only the URL syntax rules apply.
export const check = (
  references: ReadonlyArray<Reference>,
  publication: Publication | undefined,
) => {
  const findings: Array<Finding> = [];
  const remoteUsers = new Set<string>();
  for (const reference of references) {
    const url = reference.url.trim();
    if (url === "") continue;
    const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
    if (scheme === "file") {
      findings.push(finding(reference, "RSC-030", url));
      continue;
    }
    if (scheme === "data") {
      if (reference.type === "hyperlink") findings.push(finding(reference, "RSC-029"));
      continue;
    }
    if (scheme !== undefined) {
      if (SPECIAL.has(scheme) && !url.slice(scheme.length + 1).startsWith("//")) {
        findings.push(finding(reference, "RSC-020", url, 'Expected a slash ("/")'));
        continue;
      }
      if (scheme !== "http" && scheme !== "https") continue;
      if (NAVIGATION.has(reference.type)) continue;
      const withoutFragment = url.split("#")[0] ?? url;
      const declared = publication?.remoteItems.get(withoutFragment);
      const allowed =
        REMOTE_ALLOWED.has(reference.type) ||
        isRemoteMediaType(declared?.mediaType) ||
        isRemoteMediaType(reference.mediaType);
      if (!allowed) {
        findings.push(finding(reference, "RSC-006", url));
        continue;
      }
      remoteUsers.add(reference.path);
      // Upstream warns about plain HTTP only for media and font references proper.
      if (scheme === "http" && REMOTE_ALLOWED.has(reference.type))
        findings.push(finding(reference, "RSC-031", url));
      if (publication !== undefined && declared === undefined) {
        findings.push(finding(reference, "RSC-008", url));
      }
      continue;
    }
    if (/\s/.test(url)) {
      findings.push(
        finding(
          reference,
          "RSC-020",
          url,
          "Illegal character in path segment: space is not allowed",
        ),
      );
      continue;
    }
    const hash = url.indexOf("#");
    const fragment = hash < 0 ? undefined : url.slice(hash + 1);
    let target = hash < 0 ? url : url.slice(0, hash);
    const query = target.indexOf("?");
    if (query >= 0) {
      findings.push(finding(reference, "RSC-033", url));
      target = target.slice(0, query);
    }
    if (target.startsWith("/")) {
      findings.push(finding(reference, "RSC-026", url));
      continue;
    }
    // A single document's position in a container is unknown, so climbing out cannot be judged.
    if (publication === undefined) continue;
    const resolved = target === "" ? reference.path : resolve(target, reference.path);
    if (resolved === undefined) {
      findings.push(finding(reference, "RSC-026", url));
      continue;
    }
    const path = resolved.normalize("NFC");
    const item = publication.items.get(path);
    if (!publication.files.has(path)) {
      // A declared but missing resource is reported once, from the manifest (RSC-001).
      if (item === undefined) {
        findings.push(finding(reference, reference.type === "link" ? "RSC-007w" : "RSC-007", path));
      }
      continue;
    }
    if (item === undefined) {
      if (!path.startsWith("META-INF/") && path !== publication.packagePath) {
        findings.push(finding(reference, "RSC-008", path));
      }
      continue;
    }
    const isContent = CONTENT_TYPES.has(item.mediaType);
    if (
      reference.type === "hyperlink" &&
      isContent &&
      target !== "" &&
      !publication.spine.has(path)
    ) {
      findings.push(finding(reference, "RSC-011"));
    }
    if (fragment !== undefined && fragment !== "" && isContent && reference.type === "hyperlink") {
      const parsed = UrlFragment.parse(fragment, item.mediaType);
      if (parsed.id !== "" && publication.ids.get(path)?.has(parsed.id) !== true) {
        findings.push(finding(reference, "RSC-012"));
      }
    }
  }
  return { findings, remoteUsers };
};

const PROPERTY_FEATURES: ReadonlyArray<readonly [string, keyof Features]> = [
  ["scripted", "scripted"],
  ["svg", "svg"],
  ["mathml", "mathml"],
  ["switch", "switch"],
];

// Manifest properties that describe content (EPUB 3): OPF-014 when missing, OPF-015 or OPF-018
// when declared without the matching content.
export const propertyFindings = (
  item: ManifestItem,
  path: string,
  features: Features,
  usesRemoteResources: boolean,
) => {
  const findings: Array<Finding> = [];
  const at = (id: MessageId, property: string): Finding => ({
    id,
    args: [property],
    path,
    line: -1,
    column: -1,
  });
  for (const [property, feature] of PROPERTY_FEATURES) {
    const declared = item.properties.includes(property);
    if (features[feature] && !declared) findings.push(at("OPF-014", property));
    else if (!features[feature] && declared && property !== "switch")
      findings.push(at("OPF-015", property));
  }
  const declaresRemote = item.properties.includes("remote-resources");
  if (usesRemoteResources && !declaresRemote) findings.push(at("OPF-014", "remote-resources"));
  else if (!usesRemoteResources && declaresRemote) {
    findings.push(at(features.scripted ? "OPF-018b" : "OPF-018", "remote-resources"));
  }
  return findings;
};
