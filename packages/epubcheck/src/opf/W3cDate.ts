// Upstream's check of `dc:date` against http://www.w3.org/TR/NOTE-datetime (OPF-053, OPF-054).
// It reads the fields between `-`, `T`, `:`, `.`, `+` and `Z` leniently (any digit count, an
// optional time zone), then a strict Gregorian calendar rejects impossible values. Problems are
// described with upstream's exception messages, which its reports include.

type Field = "year" | "month" | "day" | "hour" | "minute" | "second";

const CALENDAR_FIELDS: ReadonlyArray<readonly [Field, string, number, number]> = [
  ["year", "YEAR", 1, 292278994],
  ["month", "MONTH", 1, 12],
  ["day", "DAY_OF_MONTH", 1, 31],
  ["hour", "HOUR_OF_DAY", 0, 23],
  ["minute", "MINUTE", 0, 59],
  ["second", "SECOND", 0, 59],
];

const DATE_STEPS: ReadonlyArray<readonly [Field, string | undefined]> = [
  ["year", undefined],
  ["month", "-"],
  ["day", "-"],
  ["hour", "T"],
  ["minute", ":"],
];

const notInteger = (token: string) => `[For input string: "${token}"] is not an integer`;

// Java's Integer.parseInt.
const integer = (token: string) =>
  /^\d+$/.test(token) && Number(token) <= 2147483647 ? Number(token) : undefined;

// The fields a date names, whether a non-zero time zone offset applies, or what is wrong.
const read = (value: string) => {
  const tokens = value.split(/([-T:.+Z])/).filter((token) => token !== "");
  if (tokens.length === 0) return "Empty Date";
  const fields: Partial<Record<Field, number>> = {};
  let index = 0;
  const atEnd = () => index >= tokens.length;
  const next = () => tokens[index++] ?? "";
  const result = (offset = false) => ({ fields, offset });
  // A delimiter before the next field: false at the end of the value.
  const delimiter = (expected: string) => {
    if (atEnd()) return false;
    const token = next();
    if (token !== expected) return `Unexpected: ${token}`;
    return atEnd() ? "Incomplete date." : true;
  };

  for (const [field, before] of DATE_STEPS) {
    if (before !== undefined) {
      const found = delimiter(before);
      if (found === false) return result();
      if (typeof found === "string") return found;
    }
    const token = next();
    const number = integer(token);
    if (number === undefined) return notInteger(token);
    fields[field] = number;
  }
  if (atEnd()) return result();
  let token = next();
  if (token === ":") {
    if (atEnd()) return "No secondes specified";
    const seconds = next();
    const second = integer(seconds);
    if (second === undefined) return notInteger(seconds);
    fields.second = second;
    if (atEnd()) return result();
    token = next();
    if (token === ".") {
      // Upstream fails with an uncaught exception here and reports nothing.
      if (atEnd()) return result();
      const fraction = next().padEnd(3, "0");
      // Java's Character.isDigit accepts any Unicode decimal digit.
      const invalid = /\P{Nd}/u.exec(fraction.slice(3))?.[0];
      if (invalid !== undefined)
        return `Invalid digit in the decimal fraction of a second: ${invalid}`;
      if (integer(fraction.slice(0, 3)) === undefined) return notInteger(fraction.slice(0, 3));
      if (atEnd()) return result();
      token = next();
    }
  }
  if (token === "Z") {
    return atEnd() ? result() : `Unexpected field at the end of the date field: ${next()}`;
  }
  if (token !== "+" && token !== "-") return "only Z, + or - allowed";
  if (atEnd()) return "Missing hour field";
  const hoursToken = next();
  const hours = integer(hoursToken);
  if (hours === undefined) return notInteger(hoursToken);
  const colon = delimiter(":");
  if (colon === false) return "Missing minute field";
  if (typeof colon === "string") return colon;
  const minutesToken = next();
  const minutes = integer(minutesToken);
  if (minutes === undefined) return notInteger(minutesToken);
  // Applying a non-zero offset normalizes the calendar before its strict check.
  return result(hours !== 0 || minutes !== 0);
};

// The Julian calendar applies before October 1582.
const isLeap = (year: number) =>
  year % 4 === 0 && (year < 1582 || year % 100 !== 0 || year % 400 === 0);

const daysIn = (year: number, month: number) =>
  month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

// What is wrong with a `dc:date` value, as upstream words it, or undefined if it is valid.
export const problem = (text: string) => {
  if (text === "") return "zero-length string";
  const value = text.trim();
  const parsed = read(value);
  if (typeof parsed === "string") return parsed;
  const { fields, offset } = parsed;
  const calendar = `${value} class java.lang.IllegalArgumentException `;
  if (!offset) {
    for (const [field, name, min, max] of CALENDAR_FIELDS) {
      const number = fields[field];
      if (number !== undefined && (number < min || number > max)) return calendar + name;
    }
    const { year = 1, month, day } = fields;
    if (month !== undefined && day !== undefined) {
      if (year === 1582 && month === 10 && day >= 5 && day <= 14) {
        return `${calendar}the specified date doesn't exist`;
      }
      if (day > daysIn(year, month)) return `${calendar}MONTH: ${month - 1} -> ${month}`;
    }
  }
  // Upstream formats the year with four digits and rejects a longer result.
  const year = fields.year ?? 1;
  return year > 9999 ? String(year) : undefined;
};
