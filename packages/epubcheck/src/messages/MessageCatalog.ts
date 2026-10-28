import { bundles, defaultSeverities } from "./catalog.generated.ts";

export type MessageId = keyof typeof defaultSeverities;

export type Severity = "FATAL" | "ERROR" | "WARNING" | "USAGE" | "INFO" | "SUPPRESSED";

export const messageIds = Object.keys(defaultSeverities) as ReadonlyArray<MessageId>;

export const isMessageId = (value: string): value is MessageId =>
  Object.prototype.hasOwnProperty.call(defaultSeverities, value);

export const defaultSeverity = (id: MessageId): Severity => defaultSeverities[id];

// Higher ranks are more severe; mirrors upstream ReportingLevel.
export const severityRank = (severity: Severity) => {
  switch (severity) {
    case "FATAL":
      return 5;
    case "ERROR":
      return 4;
    case "WARNING":
      return 3;
    case "INFO":
      return 2;
    case "USAGE":
      return 1;
    case "SUPPRESSED":
      return 0;
  }
};

const bundleKey = (id: MessageId) => id.replace("-", "_");

// ResourceBundle-style lookup: "fr-CA" falls back to "fr", then to the default bundle.
const lookup = (key: string, locale: string | undefined) => {
  const candidates: Array<string> = [];
  if (locale !== undefined && locale !== "") {
    const parts = locale.split(/[-_]/);
    for (let length = parts.length; length > 0; length--) {
      candidates.push(parts.slice(0, length).join("-"));
    }
  }
  candidates.push("default");
  for (const candidate of candidates) {
    const value = bundles[candidate]?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
};

// Java `String.format` subset used by the bundles: `%n$s`, `%s`, `%n`, and `%%`.
const formatJava = (pattern: string, args: ReadonlyArray<string>) => {
  let sequential = 0;
  return pattern.replace(
    /%(?:(\d+)\$)?([sn%])/g,
    (match, index: string | undefined, kind: string) => {
      if (kind === "%") return "%";
      if (kind === "n") return "\n";
      const position = index === undefined ? sequential++ : Number(index) - 1;
      return position < args.length ? (args[position] ?? "null") : match;
    },
  );
};

export const formatMessage = (
  id: MessageId,
  args: ReadonlyArray<string>,
  locale?: string | undefined,
) => {
  const key = bundleKey(id);
  const pattern = lookup(key, locale);
  if (pattern === undefined) return "";
  let effectiveArgs = args;
  // A localized argument is a bundle key `ID.keyword`; later arguments format that value.
  for (let index = 0; index < args.length; index++) {
    const localized = lookup(`${key}.${args[index]}`, locale);
    if (localized !== undefined) {
      effectiveArgs = [...args.slice(0, index), formatJava(localized, args.slice(index + 1))];
      break;
    }
  }
  return formatJava(pattern, effectiveArgs);
};

export const formatSuggestion = (id: MessageId, locale?: string | undefined) =>
  lookup(`${bundleKey(id)}_SUG`, locale) ?? "";
