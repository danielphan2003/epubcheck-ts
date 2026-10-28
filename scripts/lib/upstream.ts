import * as Schema from "effect/Schema";

export const UPSTREAM_REPOSITORY = "https://github.com/w3c/epubcheck";
export const UPSTREAM_TAG = "v5.4.0";

// Paths copied verbatim from the tagged upstream tree into vendor/epubcheck.
export const UPSTREAM_PATHS = [
  "LICENSE.md",
  "src/test/resources",
  "src/main/resources/com/adobe/epubcheck/messages",
  "src/main/java/com/adobe/epubcheck/messages/DefaultSeverities.java",
];

// SHA-256 of each upstream release archive the reference jar may be fetched from.
export const REFERENCE_JAR_SHA256: Readonly<Record<string, string>> = {
  "v5.4.0": "33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c",
};

export const referenceJarUrl = (tag: string) =>
  `https://github.com/w3c/epubcheck/releases/download/${tag}/epubcheck-${tag.slice(1)}.zip`;

export const UpstreamManifest = Schema.Struct({
  repository: Schema.String,
  tag: Schema.String,
  commit: Schema.String,
  paths: Schema.Array(Schema.String),
  // Git object id of each path at `commit`. A byte-identical vendored copy has the same ids, which
  // is how `conformance check` detects edits under vendor/.
  objects: Schema.Record(Schema.String, Schema.String),
});
export const UpstreamManifestJson = Schema.fromJsonString(UpstreamManifest, { space: 2 });
