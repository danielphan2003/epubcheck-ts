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

export const REFERENCE_JAR_URL = `https://github.com/w3c/epubcheck/releases/download/${UPSTREAM_TAG}/epubcheck-${UPSTREAM_TAG.slice(1)}.zip`;

export const UpstreamManifest = Schema.Struct({
  repository: Schema.String,
  tag: Schema.String,
  commit: Schema.String,
  paths: Schema.Array(Schema.String),
});
export const UpstreamManifestJson = Schema.fromJsonString(UpstreamManifest, { space: 2 });
