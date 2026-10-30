// Java's String.trim, which strips every character up to U+0020 but not NBSP.
export const trim = (value: string) => value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");

const WHITESPACE =
  /^[\t-\r\u001C- \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]+|[\t-\r\u001C- \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]+$/g;

// What Character.isWhitespace accepts, as galimatias strips it around a URL: not NBSP, U+2007,
// U+202F, U+FEFF or other control characters.
export const stripWhitespace = (value: string) => value.replace(WHITESPACE, "");
