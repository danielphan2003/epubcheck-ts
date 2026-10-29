import * as DateTime from "effect/DateTime";

// Timestamps as upstream's reports print them, from epoch milliseconds.

const pad = (value: number) => String(value).padStart(2, "0");

const local = (millis: number) =>
  DateTime.makeZonedUnsafe(millis, { timeZone: DateTime.zoneMakeLocal() });

// The JSON report's `MM-dd-yyyy HH:mm:ss`, in local time.
export const checkDate = (millis: number) => {
  const parts = DateTime.toParts(local(millis));
  return `${pad(parts.month)}-${pad(parts.day)}-${parts.year} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
};

// ISO 8601 in local time with its offset, as Java's `OffsetDateTime` prints it.
export const localIso = (millis: number) => {
  const zoned = local(millis);
  const parts = DateTime.toParts(zoned);
  const offset = DateTime.zonedOffsetIso(zoned);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offset === "+00:00" ? "Z" : offset}`;
};

// Java's SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'"): local time with a literal `Z`.
export const localWithZ = (millis: number) => {
  const parts = DateTime.toParts(local(millis));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}Z`;
};

// Java's FileTime.toString: UTC, with only the fraction of a second it needs.
export const fileTime = (millis: number) => {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(millis));
  return iso.replace(/\.?0+Z$/, "Z");
};

export const utcIso = (millis: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 19)}Z`;
