// Well-formedness of BCP 47 language tags (RFC 5646 section 2.1). Returns undefined for a
// well-formed tag, or a detail in the style of ICU's parser, which upstream reports in OPF-092:
// "Invalid subtag: a [at index 0]".

const GRANDFATHERED = new Set([
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
  "art-lojban",
  "cel-gaulish",
  "no-bok",
  "no-nyn",
  "zh-guoyu",
  "zh-hakka",
  "zh-min",
  "zh-min-nan",
  "zh-xiang",
]);

const alpha = (min: number, max: number) => new RegExp(`^[a-zA-Z]{${min},${max}}$`);
const LANGUAGE = /^(?:[a-zA-Z]{2,3}|[a-zA-Z]{5,8})$/;
const LANGUAGE_4 = alpha(4, 4);
const EXTLANG = alpha(3, 3);
const SCRIPT = alpha(4, 4);
const REGION = /^(?:[a-zA-Z]{2}|\d{3})$/;
const VARIANT = /^(?:[a-zA-Z0-9]{5,8}|\d[a-zA-Z0-9]{3})$/;
const SINGLETON = /^[0-9a-wyzA-WYZ]$/;
const EXTENSION = /^[a-zA-Z0-9]{2,8}$/;
const PRIVATE = /^[a-zA-Z0-9]{1,8}$/;

export const checkLanguageTag = (tag: string) => {
  if (GRANDFATHERED.has(tag.toLowerCase())) return undefined;
  const subtags: Array<{ readonly text: string; readonly index: number }> = [];
  let offset = 0;
  for (const text of tag.split("-")) {
    subtags.push({ text, index: offset });
    offset += text.length + 1;
  }
  let position = 0;
  const invalid = () => {
    const subtag = subtags[position];
    return subtag === undefined
      ? undefined
      : `Invalid subtag: ${subtag.text} [at index ${subtag.index}]`;
  };
  const current = () => subtags[position]?.text;
  const accept = (pattern: RegExp) => {
    const text = current();
    if (text !== undefined && pattern.test(text)) {
      position++;
      return true;
    }
    return false;
  };

  if (current()?.toLowerCase() === "x") {
    position++;
    if (!accept(PRIVATE)) return invalid() ?? `Invalid subtag: ${tag} [at index 0]`;
    while (accept(PRIVATE));
    return invalid();
  }
  if (accept(LANGUAGE)) {
    const first = subtags[0]?.text ?? "";
    if (first.length <= 3) for (let count = 0; count < 3 && accept(EXTLANG); count++);
  } else if (!accept(LANGUAGE_4)) return invalid();
  accept(SCRIPT);
  accept(REGION);
  while (accept(VARIANT));
  while (current() !== undefined && SINGLETON.test(current() ?? "")) {
    position++;
    if (!accept(EXTENSION)) return invalid() ?? `Invalid subtag: ${tag} [at index ${offset - 1}]`;
    while (accept(EXTENSION));
  }
  if (current()?.toLowerCase() === "x") {
    position++;
    if (!accept(PRIVATE)) return invalid() ?? `Invalid subtag: ${tag} [at index ${offset - 1}]`;
    while (accept(PRIVATE));
  }
  return invalid();
};
