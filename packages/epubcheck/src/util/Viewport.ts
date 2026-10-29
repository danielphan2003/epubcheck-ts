// The viewport `meta` tag syntax (https://www.w3.org/TR/epub-34/#app-viewport-meta-syntax):
// `name=value` pairs separated by commas, semicolons or whitespace. Parsing stops at the first
// error, keeping the properties read so far, like upstream.

export type ViewportError =
  | "NULL_OR_EMPTY"
  | "NAME_EMPTY"
  | "VALUE_EMPTY"
  | "LEADING_SEPARATOR"
  | "TRAILING_SEPARATOR"
  | "ASSIGN_UNEXPECTED";

export interface Viewport {
  readonly properties: ReadonlyArray<readonly [string, string]>;
  readonly errors: ReadonlyArray<ViewportError>;
}

const isSpace = (char: string) =>
  char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r";
const isSeparator = (char: string) => char === "," || char === ";";

type State = "name" | "assign" | "value" | "after-value" | "separator";

export const parse = (input: string) => {
  const properties: Array<readonly [string, string]> = [];
  const fail = (error: ViewportError) => ({ properties, errors: [error] });
  if (input === "") return fail("NULL_OR_EMPTY");
  let state: State = "name";
  let name = "";
  let value = "";
  const characters = [...input];
  let index = 0;
  while (index < characters.length) {
    const char = characters[index] ?? "";
    // A state that does not consume the character hands it to the next state.
    let consumed = true;
    switch (state) {
      case "name":
        if (name === "" && isSpace(char)) break;
        if (char === "=" || isSpace(char)) {
          state = "assign";
          consumed = false;
        } else if (isSeparator(char)) {
          state = "separator";
          consumed = false;
        } else name += char;
        break;
      case "assign":
        if (name === "") return fail("NAME_EMPTY");
        if (isSpace(char)) break;
        if (char === "=") state = "value";
        else if (isSeparator(char)) {
          state = "separator";
          consumed = false;
        } else return fail("VALUE_EMPTY");
        break;
      case "value":
        if (isSpace(char) && value === "") break;
        if (isSeparator(char) || isSpace(char)) {
          if (value === "") return fail("VALUE_EMPTY");
          state = "after-value";
          consumed = false;
        } else if (char === "=") return fail("ASSIGN_UNEXPECTED");
        else value += char;
        break;
      case "after-value":
        // Whitespace after a value is skipped; anything else goes to the separator state.
        if (!isSpace(char)) {
          state = "separator";
          consumed = false;
        }
        break;
      case "separator":
        if (name === "") return fail("LEADING_SEPARATOR");
        if (!isSeparator(char) && !isSpace(char)) {
          properties.push([name, value]);
          name = "";
          value = "";
          state = "name";
          consumed = false;
        }
        break;
    }
    if (consumed) index++;
  }
  const errors: Array<ViewportError> = [];
  if (state === "value" && value === "") errors.push("VALUE_EMPTY");
  else properties.push([name, value]);
  if (state === "separator") errors.push("TRAILING_SEPARATOR");
  return { properties, errors };
};

const WIDTH = /^(?:\d+(?:\.\d+)?|device-width)$/;
const HEIGHT = /^(?:\d+(?:\.\d+)?|device-height)$/;

export const isValidProperty = (name: string, value: string) =>
  name === "width" ? WIDTH.test(value) : name === "height" ? HEIGHT.test(value) : true;
