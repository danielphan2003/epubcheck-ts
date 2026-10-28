// Translates an XML Schema regular expression into an anchored JavaScript RegExp.
// XSD regexes have no anchors (`^` and `$` are literals), add `\i`/`\c` name classes, and allow
// character-class subtraction (`[a-z-[aeiou]]`), which becomes a negative lookahead.

const NAME_START =
  ":A-Z_a-z\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}\\u{370}-\\u{37D}\\u{37F}-\\u{1FFF}\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}";
const NAME_CHAR = `${NAME_START}\\-.0-9\\u{B7}\\u{300}-\\u{36F}\\u{203F}-\\u{2040}`;

// Class contents (without brackets) for XSD multi-character escapes usable inside a class.
const CLASS_ESCAPES: Readonly<Record<string, string>> = {
  s: " \\t\\n\\r",
  d: "\\p{Nd}",
  i: NAME_START,
  c: NAME_CHAR,
  w: "\\p{L}\\p{M}\\p{N}\\p{S}",
};

const NEGATED_ESCAPES: Readonly<Record<string, string>> = {
  S: "s",
  D: "d",
  I: "i",
  C: "c",
  W: "w",
};

// Unicode block escapes (`\p{IsBasicLatin}`) are not in JavaScript; map the ones schemas use.
const BLOCKS: Readonly<Record<string, string>> = {
  BasicLatin: "\\u{0}-\\u{7F}",
  "Latin-1Supplement": "\\u{80}-\\u{FF}",
};

const propertyEscape = (negated: boolean, name: string) => {
  if (name.startsWith("Is")) {
    const block = BLOCKS[name.slice(2)];
    if (block !== undefined) return negated ? `[^${block}]` : `[${block}]`;
    return negated ? "[^]" : "[]";
  }
  return `\\${negated ? "P" : "p"}{${name}}`;
};

const translate = (pattern: string) => {
  let index = 0;
  let failed = false;
  const peek = () => pattern[index];

  const readProperty = () => {
    // Positioned just after `\p` or `\P`.
    const end = pattern.indexOf("}", index);
    if (pattern[index] !== "{" || end < 0) {
      failed = true;
      return "";
    }
    const name = pattern.slice(index + 1, end);
    index = end + 1;
    return name;
  };

  // Returns a class item: either `{ inline }` usable inside a JS class or `{ atom }` that is not.
  const classEscape = (): { readonly inline: string } | { readonly atom: string } => {
    const char = pattern[index++] ?? "";
    if (char in CLASS_ESCAPES) return { inline: CLASS_ESCAPES[char] ?? "" };
    if (char in NEGATED_ESCAPES)
      return { atom: `[^${CLASS_ESCAPES[NEGATED_ESCAPES[char] ?? ""] ?? ""}]` };
    if (char === "p" || char === "P") {
      const name = readProperty();
      if (name.startsWith("Is")) return { atom: propertyEscape(char === "P", name) };
      return { inline: `\\${char}{${name}}` };
    }
    if (char === "n") return { inline: "\\n" };
    if (char === "r") return { inline: "\\r" };
    if (char === "t") return { inline: "\\t" };
    return { inline: `\\${char}` };
  };

  const charClass = (): string => {
    // Positioned just after `[`.
    let negated = false;
    if (peek() === "^") {
      negated = true;
      index++;
    }
    let inline = "";
    const atoms: Array<string> = [];
    let subtraction: string | undefined;
    let first = true;
    while (index < pattern.length) {
      const char = pattern[index];
      if (char === "]" && !first) {
        index++;
        break;
      }
      first = false;
      if (char === "-" && pattern[index + 1] === "[") {
        index += 2;
        subtraction = charClass();
        if (pattern[index] !== "]") failed = true;
        index++;
        break;
      }
      if (char === "\\") {
        index++;
        const escaped = classEscape();
        if ("inline" in escaped) inline += escaped.inline;
        else atoms.push(escaped.atom);
        continue;
      }
      index++;
      inline += char === "[" || char === "/" ? `\\${char}` : char;
    }
    const parts = [...(inline === "" ? [] : [`[${inline}]`]), ...atoms];
    const union =
      parts.length === 0
        ? "[]"
        : parts.length === 1
          ? (parts[0] ?? "[]")
          : `(?:${parts.join("|")})`;
    const positive = negated ? `(?:(?!${union})[^])` : union;
    return subtraction === undefined ? positive : `(?:(?!${subtraction})${positive})`;
  };

  let output = "";
  while (index < pattern.length) {
    const char = pattern[index++] ?? "";
    if (char === "\\") {
      const escaped = classEscape();
      output += "inline" in escaped ? `[${escaped.inline}]` : escaped.atom;
    } else if (char === "[") {
      output += charClass();
    } else if (char === ".") {
      output += "[^\\n\\r]";
    } else if (char === "^" || char === "$" || char === "/") {
      output += `\\${char}`;
    } else {
      output += char;
    }
  }
  return failed ? undefined : `^(?:${output})$`;
};

// Returns undefined when the pattern is not a regex this translator understands.
export const compile = (pattern: string) => {
  const source = translate(pattern);
  if (source === undefined) return undefined;
  try {
    return new RegExp(source, "u");
  } catch {
    return undefined;
  }
};
