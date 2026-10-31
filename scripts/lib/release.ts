// Release versions and tags, kept free of I/O so the release workflow's decisions are unit tested.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class InvalidReleaseVersion extends Schema.TaggedError<InvalidReleaseVersion>()(
  "InvalidReleaseVersion",
  { raw: Schema.String },
) {
  override get message(): string {
    return `Invalid release version '${this.raw}': expected X.Y.Z or X.Y.Z-suffix, with or without a leading v.`;
  }
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export interface Release {
  readonly version: string;
  readonly tag: string;
  // A suffix after X.Y.Z (1.2.3-alpha.1) publishes a prerelease that is never marked latest.
  readonly isPrerelease: boolean;
  readonly makeLatest: boolean;
}

export const parseRelease = (raw: string) => {
  const version = raw.trim().replace(/^v/, "");
  const match = VERSION.exec(version);
  if (match === null) return Option.none<Release>();
  const isPrerelease = match[4] !== undefined;
  return Option.some<Release>({
    version,
    tag: `v${version}`,
    isPrerelease,
    makeLatest: !isPrerelease,
  });
};

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: ReadonlyArray<string>;
}

const parseVersion = (version: string): ParsedVersion | undefined => {
  const match = VERSION.exec(version);
  if (match === null) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
};

const compareIdentifiers = (left: string, right: string) => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

// Semantic Versioning 2.0.0 precedence, section 11.
export const compareVersions = (left: string, right: string) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return 0;
  for (let index = 0; index < 3; index++) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const difference = compareIdentifiers(a.prerelease[index]!, b.prerelease[index]!);
    if (difference !== 0) return difference;
  }
  return a.prerelease.length - b.prerelease.length;
};

/**
 * The tag release notes are generated against: the newest release tag older than `current`.
 * A stable release compares with the previous stable one, so its notes cover every prerelease in between.
 */
export const previousReleaseTag = (tags: ReadonlyArray<string>, current: Release) =>
  Option.fromNullishOr(
    tags
      .map((tag) => tag.trim())
      .flatMap((tag) => Option.toArray(parseRelease(tag)).filter((release) => release.tag === tag))
      .filter((release) => compareVersions(release.version, current.version) < 0)
      .filter((release) => current.isPrerelease || !release.isPrerelease)
      .sort((left, right) => compareVersions(right.version, left.version))[0]?.tag,
  );
