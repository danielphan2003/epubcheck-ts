import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as Xml from "../xml/Xml.ts";
import * as Encryption from "./Encryption.ts";

const IDPF = "http://www.idpf.org/2008/embedding";
const AES = "http://www.w3.org/2001/04/xmlenc#aes128-cbc";
const data = (algorithm: string, uri: string, attributes = "") =>
  `<enc:EncryptedData${attributes}><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData>`;
const FILES = new Set(["EPUB/f.otf", "EPUB/i.png"]);

describe("Encryption.read", () => {
  // Each row's findings are EPUBCheck 5.4.0's for a publication with these two files.
  it.each([
    {
      name: "an obfuscated font",
      body: data(IDPF, "EPUB/f.otf"),
      found: [["OBS-001", "font-obfuscation"]],
      encrypted: ["EPUB/f.otf"],
      obfuscated: ["EPUB/f.otf"],
    },
    {
      name: "an encrypted image",
      body: data(AES, "EPUB/i.png"),
      found: [],
      encrypted: ["EPUB/i.png"],
      obfuscated: [],
    },
    // URLs resolve against the container root.
    {
      name: "encoded and relative URLs",
      body: data(IDPF, "EPUB/f%2Eotf") + data(IDPF, "./EPUB/i.png"),
      found: [
        ["OBS-001", "font-obfuscation"],
        ["OBS-001", "font-obfuscation"],
      ],
      encrypted: ["EPUB/f.otf", "EPUB/i.png"],
      obfuscated: ["EPUB/f.otf", "EPUB/i.png"],
    },
    {
      name: "a missing resource",
      body: data(IDPF, "EPUB/nope.otf"),
      found: [["RSC-007", "EPUB/nope.otf"]],
      encrypted: [],
      obfuscated: [],
    },
    {
      name: "a remote resource",
      body: data(IDPF, "http://example.org/f.otf"),
      found: [["RSC-007", "http://example.org/f.otf"]],
      encrypted: [],
      obfuscated: [],
    },
    // Upstream records no algorithm for compressed data.
    {
      name: "a compressed resource",
      body: data(
        IDPF,
        "EPUB/i.png",
        ' xmlns:c="http://ns.adobe.com/digitaleditions/enc" c:compression="0"',
      ),
      found: [],
      encrypted: ["EPUB/i.png"],
      obfuscated: [],
    },
  ])("reads $name", ({ body, found, encrypted, obfuscated }) => {
    const parsed = Xml.parse(
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">${body}</encryption>`,
    );
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const read = Encryption.read(parsed.success, FILES);
    expect(read.findings.map(({ id, args }) => [id, ...args])).toEqual(found);
    expect([...read.encrypted]).toEqual(encrypted);
    expect([...read.obfuscated.keys()]).toEqual(obfuscated);
  });
});
