import * as Effect from "effect/Effect";

import * as Schemas from "../schema/Schemas.ts";
import * as XmlChecker from "../xml/XmlChecker.ts";

export const check = Effect.fn("OpfChecker.check")(function* (
  bytes: Uint8Array,
  path: string,
  version: "2" | "3",
) {
  return yield* XmlChecker.check(
    bytes,
    path,
    version === "2" ? Schemas.PACKAGE_20 : Schemas.PACKAGE_30,
    undefined,
    false,
    version,
  );
});
