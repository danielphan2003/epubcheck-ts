import type { MessageId } from "../messages/MessageCatalog.ts";

export interface Finding {
  readonly id: MessageId;
  readonly args: ReadonlyArray<string>;
}

const EPUB2_DISALLOWED = new Set([0x22, 0x2a, 0x3a, 0x3c, 0x3e, 0x3f, 0x5c]);

const isNoncharacter = (codepoint: number) =>
  (codepoint >= 0xfdd0 && codepoint <= 0xfdef) || (codepoint & 0xfffe) === 0xfffe;

// Upstream's EPUB 3 sets, checked in order; the first matching set names the character.
const EPUB3_SETS: ReadonlyArray<readonly [string, (codepoint: number) => boolean]> = [
  ["ASCII", (codepoint) => EPUB2_DISALLOWED.has(codepoint) || codepoint === 0x7c],
  ["NON CHARACTER", isNoncharacter],
  [
    "CONTROL",
    (codepoint) =>
      codepoint === 0x7f || codepoint <= 0x1f || (codepoint >= 0x80 && codepoint <= 0x9f),
  ],
  [
    "PRIVATE USE",
    (codepoint) =>
      (codepoint >= 0xe000 && codepoint <= 0xf8ff) ||
      (codepoint >= 0xf0000 && codepoint <= 0xfffff) ||
      (codepoint >= 0x100000 && codepoint <= 0x10ffff),
  ],
  ["SPECIALS", (codepoint) => codepoint >= 0xfff0 && codepoint <= 0xffff],
  ["DEPRECATED", (codepoint) => codepoint === 0xe0001],
];

// ICU character names for the only named code points the disallowed sets contain.
const CHARACTER_NAMES: Readonly<Record<number, string>> = {
  0xfff9: "INTERLINEAR ANNOTATION ANCHOR",
  0xfffa: "INTERLINEAR ANNOTATION SEPARATOR",
  0xfffb: "INTERLINEAR ANNOTATION TERMINATOR",
  0xfffc: "OBJECT REPLACEMENT CHARACTER",
  0xfffd: "REPLACEMENT CHARACTER",
  0xe0001: "LANGUAGE TAG",
};

const describe = (codepoint: number, set: string) => {
  const hex = `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
  if (set === "ASCII") return `${hex} (${String.fromCodePoint(codepoint)})`;
  const name = CHARACTER_NAMES[codepoint];
  return name === undefined ? `${hex} (${set})` : `${hex} ${name} (${set})`;
};

// ICU isUWhiteSpace tests the Unicode White_Space property.
const WHITE_SPACE = /\p{White_Space}/u;

export const checkFilename = (filename: string, version: "2" | "3") => {
  const disallowed = new Set<string>();
  let hasSpaces = false;
  let asciiOnly = true;
  let last = 0;
  for (const character of filename) {
    const codepoint = character.codePointAt(0) ?? 0;
    last = codepoint;
    asciiOnly &&= codepoint <= 0x7f;
    hasSpaces ||= WHITE_SPACE.test(character);
    if (version === "2") {
      if (EPUB2_DISALLOWED.has(codepoint)) disallowed.add(describe(codepoint, "ASCII"));
      continue;
    }
    const set = EPUB3_SETS.find(([, contains]) => contains(codepoint));
    if (set !== undefined) disallowed.add(describe(codepoint, set[0]));
  }
  const findings: Array<Finding> = [];
  if (last === 0x2e) findings.push({ id: "PKG-011", args: [filename] });
  if (disallowed.size > 0)
    findings.push({ id: "PKG-009", args: [filename, [...disallowed].join(", ")] });
  if (hasSpaces) findings.push({ id: "PKG-010", args: [filename] });
  if (!asciiOnly) findings.push({ id: "PKG-012", args: [filename] });
  return findings;
};
