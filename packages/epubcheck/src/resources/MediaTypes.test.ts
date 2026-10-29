import { describe, expect, it } from "@effect/vitest";

import * as MediaTypes from "./MediaTypes.ts";

describe("MediaTypes", () => {
  // Upstream's MIMEType.normalize.
  it.each([
    { value: "image/PNG", normalized: "image/png" },
    { value: " audio/ogg ; Codecs=opus ", normalized: "audio/ogg;codecs=opus" },
    { value: 'audio/mp4;codecs="mp4a.40.2"', normalized: "audio/mp4;codecs=mp4a.40.2" },
    { value: 'text/css;charset="a b"', normalized: 'text/css;charset="a b"' },
    { value: "text/css;charset", normalized: "text/css" },
    { value: "audio/mp4;codecs=aac;Codecs=x", normalized: "audio/mp4;codecs=aac" },
    { value: 'image/png;x="a;b"', normalized: 'image/png;x="a;b"' },
    { value: 'text/css;x="a\\"b\\\\"', normalized: 'text/css;x="a\\"b\\\\"' },
    { value: 'text/css;x="abc', normalized: "text/css;x=abc" },
    { value: "audio/mpeg;x=a b ;y=c", normalized: 'audio/mpeg;x="a b";y=c' },
    { value: "text/css;x=€;y=c", normalized: "text/css;y=c" },
    { value: "text /css", normalized: "" },
    { value: "text/css x", normalized: "" },
    { value: "not a type", normalized: "" },
  ])("normalizes $value", ({ value, normalized }) => {
    expect(MediaTypes.normalize(value)).toBe(normalized);
  });

  // Upstream compares normalized types with exact strings.
  it.each([
    { value: "audio/mp4", core: true },
    { value: "audio/ogg; codecs=opus", core: true },
    { value: "audio/mp4;codecs=mp4a.40.2", core: false },
    { value: "image/png;x=y", core: false },
    { value: "application/x-dtbncx+xml", core: false },
    { value: "image/webp", core: true },
  ])("tells whether $value is a core media type", ({ value, core }) => {
    expect(MediaTypes.isCore(value)).toBe(core);
  });

  it.each([
    { value: "application/font-sfnt", path: "a.ttf", preferred: "font/ttf" },
    { value: "application/font-sfnt", path: "a.OTF", preferred: "font/(ttf|otf)" },
    { value: "text/javascript", path: "a.js", preferred: "application/javascript" },
    { value: "font/woff", path: "a.woff", preferred: undefined },
  ])("prefers a spelling for $value at $path", ({ value, path, preferred }) => {
    expect(MediaTypes.preferred(value, path)).toBe(preferred);
  });

  // A 1x1 RGB PNG's signature and IHDR chunk, without its CRC.
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
    0, 0, 0, 1, 8, 2, 0, 0, 0,
  ]);
  const gif = new TextEncoder().encode("GIF89a\x01\x00\x01\x00\x00\x00\x00");
  const jpeg = new Uint8Array([0xff, 0xd8, 0, 0, 0, 0, 0, 0]);
  // Each answer is EPUBCheck 5.4.0's BitmapChecker.
  it.each([
    { name: "a PNG", bytes: png, path: "a.png", type: "image/png", ids: [] },
    {
      name: "a PNG named .jpg",
      bytes: png,
      path: "a.jpg",
      type: "image/jpeg",
      ids: ["OPF-029", "PKG-022"],
    },
    { name: "a PNG named .JPG", bytes: png, path: "a.JPG", type: "image/png", ids: ["PKG-022"] },
    { name: "a PNG named .jpe", bytes: png, path: "a.jpe", type: "image/png", ids: ["PKG-021"] },
    {
      name: "a PNG without an extension",
      bytes: png,
      path: "img/a",
      type: "image/png",
      ids: ["PKG-021"],
    },
    {
      name: "a truncated IHDR",
      bytes: png.subarray(0, 28),
      path: "a.png",
      type: "image/png",
      ids: ["PKG-021"],
    },
    {
      name: "a PNG 0 pixels wide",
      bytes: png.map((byte, index) => (index === 19 ? 0 : byte)),
      path: "a.png",
      type: "image/png",
      ids: ["PKG-021"],
    },
    {
      name: "a 16-bit palette PNG",
      bytes: png.map((byte, index) => (index === 24 ? 16 : index === 25 ? 3 : byte)),
      path: "a.png",
      type: "image/png",
      ids: ["PKG-021"],
    },
    { name: "a GIF header alone", bytes: gif, path: "a.gif", type: "image/gif", ids: ["PKG-021"] },
    {
      name: "a GIF with an image descriptor",
      bytes: new Uint8Array([...gif, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
      path: "a.gif",
      type: "image/gif",
      ids: [],
    },
    {
      name: "JPEG bytes named .png",
      bytes: jpeg,
      path: "a.png",
      type: "image/png",
      ids: ["OPF-029", "PKG-022"],
    },
    {
      name: "a JPEG without a frame",
      bytes: jpeg,
      path: "a.jpg",
      type: "image/jpeg",
      ids: ["PKG-021"],
    },
    {
      name: "two bytes",
      bytes: new Uint8Array([0x89, 0x50]),
      path: "a.png",
      type: "image/png",
      ids: ["MED-004", "PKG-021"],
    },
    {
      name: "text",
      bytes: new TextEncoder().encode("hello"),
      path: "a.png",
      type: "image/png",
      ids: ["OPF-029", "PKG-021"],
    },
  ])("checks $name", ({ bytes, path, type, ids }) => {
    expect(MediaTypes.imageProblems(bytes, path, type).map((problem) => problem.id)).toEqual(ids);
  });
});
