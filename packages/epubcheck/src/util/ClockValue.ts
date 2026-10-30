import * as JavaText from "./JavaText.ts";

// SMIL 3.0 clock values (https://www.w3.org/TR/SMIL3/smil-timing.html#q22) in milliseconds, as
// upstream's SmilClock computes them: timecounts in seconds, hours or with no unit are truncated
// to whole milliseconds, while `ms`, `min` and clock syntaxes keep their fractions.

const TIMECOUNT = /^(?:npt=)?(\d+)(?:\.(\d+))?(h|min|s|ms)?$/;
const FULL = /^(?:npt=)?(\d+):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/;
const PARTIAL = /^(?:npt=)?([0-5]\d):([0-5]\d)(?:\.(\d+))?$/;

// `whole.fraction` times `factor`, computed exactly: truncated as BigDecimal.longValue does, or
// rounded to a double as BigDecimal.doubleValue does.
const times = (whole: string, fraction: string, factor: bigint, truncate: boolean) => {
  const denominator = 10n ** BigInt(fraction.length);
  const product = BigInt(whole + fraction) * factor;
  const units = product / denominator;
  const rest = product % denominator;
  if (truncate || rest === 0n) return Number(units);
  return Number(`${units}.${rest.toString().padStart(fraction.length, "0")}`);
};

const UNITS: Readonly<Record<string, readonly [bigint, boolean]>> = {
  s: [1000n, true],
  h: [3_600_000n, true],
  min: [60_000n, false],
  ms: [1n, false],
};

export const parse = (value: string) => {
  const text = JavaText.trim(value);
  const timecount = TIMECOUNT.exec(text);
  if (timecount !== null) {
    const [, whole = "0", fraction = "", unit = "s"] = timecount;
    const [factor, truncate] = UNITS[unit] ?? [1000n, true];
    return times(whole, fraction, factor, truncate);
  }
  const full = FULL.exec(text);
  const partial = full === null ? PARTIAL.exec(text) : null;
  const [hours = "0", minutes, seconds, fraction] =
    full !== null ? full.slice(1) : partial !== null ? ["0", ...partial.slice(1)] : [];
  if (minutes === undefined || seconds === undefined) return undefined;
  const millis = Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000;
  return millis + (fraction === undefined ? 0 : times("0", fraction, 1000n, false));
};
