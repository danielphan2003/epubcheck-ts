// Java's number parsing, which upstream's date and UUID checks rely on: Character.digit accepts
// ASCII and fullwidth Latin letters and any decimal digit in the Basic Multilingual Plane.

const isDecimal = (char: string) => /\p{Nd}/u.test(char);

const digit = (char: string, radix: number) => {
  if (char.length !== 1) return undefined;
  const code = char.charCodeAt(0);
  let value: number | undefined;
  if (isDecimal(char)) {
    // Unicode encodes decimal digits in contiguous runs of ten, from zero.
    let start = code;
    while (start > 0 && isDecimal(String.fromCharCode(start - 1))) start--;
    value = (code - start) % 10;
  } else if (/[a-zA-Z]/.test(char)) value = char.toLowerCase().charCodeAt(0) - 87;
  else if (code >= 0xff21 && code <= 0xff3a) value = code - 0xff21 + 10;
  else if (code >= 0xff41 && code <= 0xff5a) value = code - 0xff41 + 10;
  return value !== undefined && value < radix ? value : undefined;
};

// Integer.parseInt and Long.parseLong for non-negative values: an optional `+`, then digits, at
// most `max`. Undefined when Java would throw NumberFormatException.
export const parse = (text: string, radix: number, max: bigint) => {
  const digits = text.startsWith("+") ? text.slice(1) : text;
  if (digits === "") return undefined;
  let value = 0n;
  for (const char of digits) {
    const next = digit(char, radix);
    if (next === undefined) return undefined;
    value = value * BigInt(radix) + BigInt(next);
    if (value > max) return undefined;
  }
  return value;
};

export const MAX_INT = 2n ** 31n - 1n;
export const MAX_LONG = 2n ** 63n - 1n;
