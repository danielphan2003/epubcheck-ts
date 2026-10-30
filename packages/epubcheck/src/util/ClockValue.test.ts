import { describe, expect, it } from "@effect/vitest";

import * as ClockValue from "./ClockValue.ts";

// Each value is EPUBCheck 5.4.0's SmilClock, in milliseconds.
describe("ClockValue", () => {
  it.each([
    { value: "3", millis: 3000 },
    { value: " 3.5s ", millis: 3500 },
    { value: "1.0006s", millis: 1000 },
    { value: "1.001s", millis: 1001 },
    { value: "1.5ms", millis: 1.5 },
    { value: "0.5min", millis: 30000 },
    { value: "1.00001min", millis: 60000.6 },
    { value: "1h", millis: 3600000 },
    { value: "0.0000001h", millis: 0 },
    { value: "01:02:03.5", millis: 3723500 },
    { value: "02:03.25", millis: 123250 },
    { value: "npt=5s", millis: 5000 },
    { value: "60:00", millis: undefined },
    { value: "5x", millis: undefined },
  ])("reads $value", ({ value, millis }) => {
    expect(ClockValue.parse(value)).toBe(millis);
  });
});
