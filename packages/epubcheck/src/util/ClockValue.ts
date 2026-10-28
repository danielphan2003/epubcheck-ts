// SMIL 3.0 clock values (https://www.w3.org/TR/SMIL3/smil-timing.html#q22), in seconds: full
// (`01:02:03.5`), partial (`02:03.5`), and timecount (`3.5s`, `200ms`, `2min`, `1h`) syntaxes.

const FULL = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/;
const PARTIAL = /^([0-5]\d):([0-5]\d(?:\.\d+)?)$/;
const TIMECOUNT = /^(\d+(?:\.\d+)?)(h|min|s|ms)?$/;

const UNITS: Readonly<Record<string, number>> = { h: 3600, min: 60, s: 1, ms: 0.001 };

export const parse = (value: string) => {
  const text = value.trim();
  const full = FULL.exec(text);
  if (full !== null) return Number(full[1]) * 3600 + Number(full[2]) * 60 + Number(full[3]);
  const partial = PARTIAL.exec(text);
  if (partial !== null) return Number(partial[1]) * 60 + Number(partial[2]);
  const timecount = TIMECOUNT.exec(text);
  if (timecount !== null) return Number(timecount[1]) * (UNITS[timecount[2] ?? "s"] ?? 1);
  return undefined;
};
