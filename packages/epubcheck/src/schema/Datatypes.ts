import * as XsdRegex from "./XsdRegex.ts";

export const XSD_LIBRARY = "http://www.w3.org/2001/XMLSchema-datatypes";
export const WHATTF_LIBRARY = "http://whattf.org/datatype-draft";

// A datatype answers "is this lexical value allowed?" with undefined (yes) or the detail Jing
// appends to its message, such as "must be an XML name without colons".
export interface Datatype {
  readonly key: string;
  readonly validate: (value: string, context: NamespaceContext) => string | undefined;
  readonly normalize: (value: string) => string;
  // Whether `value` patterns need the namespace context (QNames).
  readonly contextDependent: boolean;
}

export interface NamespaceContext {
  readonly resolve: (prefix: string) => string | undefined;
}

export interface Param {
  readonly name: string;
  readonly value: string;
}

const collapse = (value: string) => value.replace(/[\t\n\r ]+/g, " ").trim();
const preserve = (value: string) => value;
const replaceWhitespace = (value: string) => value.replace(/[\t\n\r]/g, " ");

const NAME_START =
  "A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NCNAME = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, "u");
const NAME = new RegExp(`^[:${NAME_START}][:${NAME_CHAR}]*$`, "u");
const NMTOKEN = new RegExp(`^[:${NAME_CHAR}]+$`, "u");

export const isNCName = (value: string) => NCNAME.test(value);

interface Base {
  readonly lexical: string;
  readonly whitespace: (value: string) => string;
  readonly test: (value: string, context: NamespaceContext) => boolean;
  readonly length?: (value: string) => number;
  readonly order?: (value: string) => number;
  readonly list?: boolean;
}

// Jing's lenient URI check: escapes are `%` and two hex digits, there is at most one fragment,
// no brackets, and a scheme, if any, is well formed. Spaces and other unsafe characters pass.
const isUri = (value: string) => {
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return false;
  if (value.split("#").length > 2 || /[[\]]/.test(value)) return false;
  const colon = value.search(/[:/?#]/);
  return (
    colon < 0 || value[colon] !== ":" || /^[A-Za-z][A-Za-z0-9+.-]*$/.test(value.slice(0, colon))
  );
};

const regex = (pattern: RegExp) => (value: string) => pattern.test(value);
const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const integerPattern = /^[+-]?\d+$/;
const floatPattern = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const timezone = "(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))?";
const year = "-?(?:[1-9]\\d{4,}|\\d{4})";
const day = "(?:0[1-9]|[12]\\d|3[01])";
const month = "(?:0[1-9]|1[0-2])";
const time = "(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?|24:00:00(?:\\.0+)?)";
const numeric = (value: string) =>
  value === "INF" ? Infinity : value === "-INF" ? -Infinity : Number(value);

const integerBase: Base = {
  lexical: "an integer",
  whitespace: collapse,
  test: regex(integerPattern),
  order: Number,
};

const bases: Readonly<Record<string, Base>> = {
  string: {
    lexical: "a string",
    whitespace: preserve,
    test: () => true,
    length: (value) => [...value].length,
  },
  normalizedString: {
    lexical: "a string",
    whitespace: replaceWhitespace,
    test: () => true,
    length: (value) => [...value].length,
  },
  token: {
    lexical: "a string",
    whitespace: collapse,
    test: () => true,
    length: (value) => [...value].length,
  },
  anyURI: {
    lexical: "a URI",
    whitespace: collapse,
    test: isUri,
    length: (value) => [...value].length,
  },
  boolean: { lexical: "a boolean", whitespace: collapse, test: regex(/^(?:true|false|1|0)$/) },
  decimal: {
    lexical: "a decimal number",
    whitespace: collapse,
    test: regex(decimalPattern),
    order: Number,
  },
  integer: integerBase,
  float: {
    lexical: "a floating-point number",
    whitespace: collapse,
    test: regex(floatPattern),
    order: numeric,
  },
  double: {
    lexical: "a floating-point number",
    whitespace: collapse,
    test: regex(floatPattern),
    order: numeric,
  },
  Name: {
    lexical: "an XML name",
    whitespace: collapse,
    test: regex(NAME),
    length: (value) => [...value].length,
  },
  NCName: {
    lexical: "an XML name without colons",
    whitespace: collapse,
    test: regex(NCNAME),
    length: (value) => [...value].length,
  },
  NMTOKEN: {
    lexical: "an XML NMTOKEN",
    whitespace: collapse,
    test: regex(NMTOKEN),
    length: (value) => [...value].length,
  },
  NMTOKENS: {
    lexical: "a list of XML NMTOKENs",
    whitespace: collapse,
    // An empty list is lexically valid; a minLength facet rejects it, with its own message.
    test: (value) => value === "" || value.split(" ").every((token) => NMTOKEN.test(token)),
    length: (value) => (value === "" ? 0 : value.split(" ").length),
    list: true,
  },
  IDREFS: {
    lexical: "a list of XML names without colons",
    whitespace: collapse,
    test: (value) => value === "" || value.split(" ").every((token) => NCNAME.test(token)),
    length: (value) => (value === "" ? 0 : value.split(" ").length),
    list: true,
  },
  QName: {
    lexical: "an XML QName",
    whitespace: collapse,
    test: (value, context) => {
      const [prefix, local, ...rest] = value.split(":");
      if (rest.length > 0) return false;
      if (local === undefined) return NCNAME.test(value);
      return (
        NCNAME.test(prefix ?? "") &&
        NCNAME.test(local) &&
        context.resolve(prefix ?? "") !== undefined
      );
    },
  },
  language: {
    lexical: "an RFC 3066 language identifier",
    whitespace: collapse,
    test: regex(/^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/),
    length: (value) => [...value].length,
  },
  dateTime: {
    lexical: "an ISO date and time",
    whitespace: collapse,
    test: regex(new RegExp(`^${year}-${month}-${day}T${time}${timezone}$`)),
  },
  date: {
    lexical: "an ISO date",
    whitespace: collapse,
    test: regex(new RegExp(`^${year}-${month}-${day}${timezone}$`)),
  },
  time: {
    lexical: "an ISO time",
    whitespace: collapse,
    test: regex(new RegExp(`^${time}${timezone}$`)),
  },
  gYear: {
    lexical: "a year",
    whitespace: collapse,
    test: regex(new RegExp(`^${year}${timezone}$`)),
  },
  gYearMonth: {
    lexical: "an ISO year and month",
    whitespace: collapse,
    test: regex(new RegExp(`^${year}-${month}${timezone}$`)),
  },
  duration: {
    lexical: "a duration",
    whitespace: collapse,
    test: regex(
      /^-?P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?!$)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/,
    ),
  },
  hexBinary: {
    lexical: "a hexadecimal string",
    whitespace: collapse,
    test: regex(/^(?:[0-9a-fA-F]{2})*$/),
    length: (value) => value.length / 2,
  },
  base64Binary: {
    lexical: "a base64 string",
    whitespace: collapse,
    test: (value) => /^[A-Za-z0-9+/= ]*$/.test(value) && value.replace(/ /g, "").length % 4 === 0,
    length: (value) => {
      const compact = value.replace(/ /g, "");
      return (compact.length / 4) * 3 - (compact.match(/=+$/)?.[0].length ?? 0);
    },
  },
};

// Derived integer types, expressed as range facets on integer the way Jing reports them.
const integerRanges: Readonly<Record<string, readonly [string | undefined, string | undefined]>> = {
  nonNegativeInteger: ["0", undefined],
  positiveInteger: ["1", undefined],
  nonPositiveInteger: [undefined, "0"],
  negativeInteger: [undefined, "-1"],
  long: ["-9223372036854775808", "9223372036854775807"],
  int: ["-2147483648", "2147483647"],
  short: ["-32768", "32767"],
  byte: ["-128", "127"],
  unsignedLong: ["0", "18446744073709551615"],
  unsignedInt: ["0", "4294967295"],
  unsignedShort: ["0", "65535"],
  unsignedByte: ["0", "255"],
};

const aliases: Readonly<Record<string, string>> = {
  ID: "NCName",
  IDREF: "NCName",
  ENTITY: "NCName",
  ENTITIES: "IDREFS",
};

const facetCheck = (base: Base, params: ReadonlyArray<Param>) => {
  const checks: Array<(value: string) => string | undefined> = [];
  for (const { name, value: limit } of params) {
    switch (name) {
      case "length":
      case "minLength":
      case "maxLength": {
        const bound = Number(limit);
        const measure = base.length ?? ((value: string) => [...value].length);
        checks.push((value) => {
          const actual = measure(value);
          if (name === "length" && actual !== bound)
            return `must be ${base.lexical} with length equal to ${limit} (actual length was ${actual})`;
          if (name === "minLength" && actual < bound)
            return `must be ${base.lexical} with length at least ${limit} (actual length was ${actual})`;
          if (name === "maxLength" && actual > bound)
            return `must be ${base.lexical} with length at most ${limit} (actual length was ${actual})`;
          return undefined;
        });
        break;
      }
      case "pattern": {
        const compiled = XsdRegex.compile(limit);
        if (compiled !== undefined) {
          checks.push((value) =>
            compiled.test(value)
              ? undefined
              : `must be ${base.lexical} matching the regular expression "${limit}"`,
          );
        }
        break;
      }
      case "minInclusive":
      case "minExclusive":
      case "maxInclusive":
      case "maxExclusive": {
        const order = base.order ?? Number;
        const bound = order(limit);
        checks.push((value) => {
          const actual = order(value);
          if (name === "minInclusive" && !(actual >= bound))
            return `must be ${base.lexical} greater than or equal to ${limit}`;
          if (name === "minExclusive" && !(actual > bound))
            return `must be ${base.lexical} greater than ${limit}`;
          if (name === "maxInclusive" && !(actual <= bound))
            return `must be ${base.lexical} less than or equal to ${limit}`;
          if (name === "maxExclusive" && !(actual < bound))
            return `must be ${base.lexical} less than ${limit}`;
          return undefined;
        });
        break;
      }
      default:
        break;
    }
  }
  return checks;
};

const fromBase = (key: string, base: Base, params: ReadonlyArray<Param>): Datatype => {
  const checks = facetCheck(base, params);
  return {
    key,
    contextDependent: false,
    normalize: base.whitespace,
    validate: (raw, context) => {
      const value = base.whitespace(raw);
      if (!base.test(value, context)) return `must be ${base.lexical}`;
      for (const check of checks) {
        const failure = check(value);
        if (failure !== undefined) return failure;
      }
      return undefined;
    },
  };
};

const xsd = (name: string, params: ReadonlyArray<Param>) => {
  const key = `xsd:${name}${params.map((param) => `|${param.name}=${param.value}`).join("")}`;
  const range = integerRanges[name];
  if (range !== undefined) {
    const [min, max] = range;
    return fromBase(key, integerBase, [
      ...(min === undefined ? [] : [{ name: "minInclusive", value: min }]),
      ...(max === undefined ? [] : [{ name: "maxInclusive", value: max }]),
      ...params,
    ]);
  }
  const base = bases[aliases[name] ?? name];
  if (base === undefined) return undefined;
  const datatype = fromBase(key, base, params);
  return name === "QName" ? { ...datatype, contextDependent: true } : datatype;
};

const builtin = (name: string): Datatype | undefined => {
  if (name === "string")
    return {
      key: "string",
      contextDependent: false,
      normalize: preserve,
      validate: () => undefined,
    };
  if (name === "token")
    return {
      key: "token",
      contextDependent: false,
      normalize: collapse,
      validate: () => undefined,
    };
  return undefined;
};

export type WhattfDatatypes = (name: string) => Datatype | undefined;

export interface Libraries {
  readonly whattf: WhattfDatatypes;
}

export const lookup = (
  library: string,
  name: string,
  params: ReadonlyArray<Param>,
  libraries: Libraries,
) => {
  if (library === "") return builtin(name);
  if (library === XSD_LIBRARY) return xsd(name, params);
  if (library === WHATTF_LIBRARY) return libraries.whattf(name);
  return undefined;
};

export const isWhitespace = (value: string) => /^[\t\n\r ]*$/.test(value);
