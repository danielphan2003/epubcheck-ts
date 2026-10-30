// The text without the leading (unless `leading` is false) and trailing characters `strip`
// accepts. A scan, where an end-anchored pattern is quadratic on a long run inside the text.
export const trimBy = (value: string, strip: (code: number) => boolean, leading = true) => {
  let end = value.length;
  while (end > 0 && strip(value.charCodeAt(end - 1))) end--;
  let start = 0;
  if (leading) while (start < end && strip(value.charCodeAt(start))) start++;
  return value.slice(start, end);
};

// Java's String.trim, which strips every character up to U+0020 but not NBSP.
export const trim = (value: string) => trimBy(value, (code) => code <= 0x20);

// What Character.isWhitespace accepts, as galimatias strips it around a URL: not NBSP, U+2007,
// U+202F, U+FEFF or other control characters.
const isWhitespace = (code: number) =>
  (code >= 0x09 && code <= 0x0d) ||
  (code >= 0x1c && code <= 0x20) ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x2006) ||
  (code >= 0x2008 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x205f ||
  code === 0x3000;

export const stripWhitespace = (value: string) => trimBy(value, isWhitespace);
