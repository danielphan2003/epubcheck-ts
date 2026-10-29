// Well-formedness of BCP 47 language tags (RFC 5646 section 2.1). Returns undefined for a
// well-formed tag, or ICU's detail, which upstream reports in OPF-092: "Invalid subtag: a [at
// index 0]".

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

const LANGUAGE = /^[a-zA-Z]{2,8}$/;
const EXTLANG = /^[a-zA-Z]{3}$/;
const SCRIPT = /^[a-zA-Z]{4}$/;
const REGION = /^(?:[a-zA-Z]{2}|\d{3})$/;
const VARIANT = /^(?:[a-zA-Z0-9]{5,8}|\d[a-zA-Z0-9]{3})$/;
// ICU accepts only letters as extension singletons.
const SINGLETON = /^[a-wyzA-WYZ]$/;
const EXTENSION = /^[a-zA-Z0-9]{2,8}$/;
const PRIVATE = /^[a-zA-Z0-9]{1,8}$/;

// Follows ICU's LanguageTag.parse: the language and what may follow it, then private use; the
// first subtag left over is the error.
export const checkLanguageTag = (tag: string) => {
  if (GRANDFATHERED.has(tag.toLowerCase())) return undefined;
  const subtags: Array<{ readonly text: string; readonly index: number }> = [];
  let offset = 0;
  for (const text of tag.split("-")) {
    subtags.push({ text, index: offset });
    offset += text.length + 1;
  }
  let position = 0;
  const accept = (pattern: RegExp) => {
    const subtag = subtags[position];
    if (subtag === undefined || !pattern.test(subtag.text)) return false;
    position++;
    return true;
  };

  if (accept(LANGUAGE)) {
    for (let count = 0; count < 3 && accept(EXTLANG); count++);
    accept(SCRIPT);
    accept(REGION);
    while (accept(VARIANT));
    for (
      let singleton = subtags[position];
      singleton !== undefined;
      singleton = subtags[position]
    ) {
      if (!SINGLETON.test(singleton.text)) break;
      position++;
      if (!accept(EXTENSION)) {
        return `Incomplete extension '${singleton.text}' [at index ${singleton.index}]`;
      }
      while (accept(EXTENSION));
    }
  }
  const privateUse = subtags[position];
  if (privateUse !== undefined && privateUse.text.toLowerCase() === "x") {
    position++;
    if (!accept(PRIVATE)) return `Incomplete privateuse [at index ${privateUse.index}]`;
    while (accept(PRIVATE));
  }
  const rest = subtags[position];
  if (rest === undefined) return undefined;
  return rest.text === ""
    ? `Empty subtag [at index ${rest.index}]`
    : `Invalid subtag: ${rest.text} [at index ${rest.index}]`;
};
