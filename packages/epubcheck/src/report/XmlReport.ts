import { type CheckResult, VERSION } from "../EpubCheck.ts";
import * as MessageCatalog from "../messages/MessageCatalog.ts";
import * as Dates from "./Dates.ts";
import * as Groups from "./Groups.ts";
import { epubVersionLabel, locationPath } from "./JsonReport.ts";
import type { Location, Message } from "./Report.ts";

// Upstream's XML reports: JHOVE (`--out`) and XMP (`--xmp`). Properties not computed yet are left
// out.

export interface ReportOptions {
  readonly path: string;
  // The checked file's absolute path, which JHOVE records as the `repInfo` URI.
  readonly uri: string;
  readonly maxOfEachMessage: number;
  // When the check started, in epoch milliseconds.
  readonly checkedAt: number;
}

// The release date upstream's JHOVE report states for EPUBCheck 5.4.0.
const RELEASE_DATE = "2026-09-15";

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
  );
// Upstream's DOM serializer leaves quotes alone in text.
const escapeText = (value: string) =>
  value.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));

const SEVERITY_ORDER: ReadonlyArray<Message["severity"]> = [
  "FATAL",
  "ERROR",
  "WARNING",
  "USAGE",
  "INFO",
];
const LABEL: Record<Message["severity"], { readonly name: string; readonly level: string }> = {
  FATAL: { name: "FATAL", level: "error" },
  ERROR: { name: "ERROR", level: "error" },
  WARNING: { name: "WARN", level: "warning" },
  USAGE: { name: "HINT", level: "info" },
  INFO: { name: "INFO", level: "info" },
  SUPPRESSED: { name: "SUPPRESSED", level: "info" },
};

const where = (result: CheckResult, location: Location, displayPath: string) => {
  const path = locationPath(result, location, displayPath);
  if (location.line < 0) return path;
  return location.column < 0
    ? `${path} (${location.line})`
    : `${path} (${location.line}-${location.column})`;
};

// One entry per listed location, most severe first, each severity in report order.
const entries = (
  result: CheckResult,
  options: { readonly path: string; readonly maxOfEachMessage: number },
) => {
  const groups = Groups.group(result.messages, options.maxOfEachMessage);
  return SEVERITY_ORDER.flatMap((severity) =>
    groups
      .filter((group) => group.first.severity === severity)
      .flatMap((group) =>
        group.locations.map((location) => ({
          message: group.first,
          label: LABEL[severity],
          where: where(result, location, options.path),
        })),
      ),
  );
};

const isWellFormed = (result: CheckResult) =>
  !result.messages.some((message) => message.severity === "FATAL" || message.severity === "ERROR");

const property = (indent: string, name: string, type: string, value: string) =>
  [
    `${indent}<property>`,
    `${indent}   <name>${name}</name>`,
    `${indent}   <values arity="Scalar" type="${type}">`,
    `${indent}      <value>${escapeText(value)}</value>`,
    `${indent}   </values>`,
    `${indent}</property>`,
  ].join("\n");

export const renderJhove = (result: CheckResult, options: ReportOptions) => {
  const metadata = result.publication?.metadata;
  const created = Dates.utcIso(options.checkedAt);
  const messages = entries(result, options).map((entry) => {
    const id = MessageCatalog.displayId(entry.message.id);
    return `         <message id="${id}" severity="${entry.label.level}">${escapeText(
      `${id}, ${entry.label.name}, [${entry.message.message}], ${entry.where}`,
    )}</message>`;
  });
  const info = [
    metadata?.identifier === undefined
      ? []
      : [property("               ", "Identifier", "String", metadata.identifier)],
    [property("               ", "CreationDate", "Date", created)],
    metadata?.modified === undefined
      ? []
      : [property("               ", "ModDate", "Date", metadata.modified)],
    metadata?.title === undefined
      ? []
      : [property("               ", "Title", "String", metadata.title)],
    (metadata?.creators ?? []).map((creator) =>
      property("               ", "Creator", "String", creator),
    ),
  ].flat();
  const properties = [
    property("         ", "FileName", "String", options.path.split(/[\\/]/).pop() ?? options.path),
    ...(metadata?.language === undefined
      ? []
      : [property("         ", "Language", "String", metadata.language)]),
    ...(info.length === 0
      ? []
      : [
          [
            "         <property>",
            "            <name>Info</name>",
            '            <values arity="List" type="Property">',
            ...info,
            "            </values>",
            "         </property>",
          ].join("\n"),
        ]),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<jhove xmlns="http://schema.openpreservation.org/ois/xml/ns/jhove"',
    '        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    `        date="${RELEASE_DATE}"`,
    '        name="epubcheck"',
    `        release="${VERSION}"`,
    '        xsi:schemaLocation="http://schema.openpreservation.org/ois/xml/ns/jhove https://schema.openpreservation.org/ois/xml/xsd/jhove/jhove.xsd">',
    `   <date>${Dates.localIso(options.checkedAt)}</date>`,
    `   <repInfo uri="${escape(options.uri)}">`,
    `      <created>${created}</created>`,
    ...(metadata?.modified === undefined
      ? []
      : [`      <lastModified>${escapeText(metadata.modified)}</lastModified>`]),
    "      <format>application/epub+zip</format>",
    ...(result.publication === undefined
      ? []
      : [`      <version>${epubVersionLabel(result.publication.version)}</version>`]),
    `      <status>${isWellFormed(result) ? "Well-formed" : "Not well-formed"}</status>`,
    ...(messages.length === 0 ? [] : ["      <messages>", ...messages, "      </messages>"]),
    "      <mimeType>application/epub+zip</mimeType>",
    "      <properties>",
    ...properties,
    "      </properties>",
    "   </repInfo>",
    "</jhove>",
    "",
  ].join("\n");
};

export const renderXmp = (result: CheckResult, options: ReportOptions) => {
  const metadata = result.publication?.metadata;
  const version =
    result.publication === undefined
      ? ""
      : `;version=${epubVersionLabel(result.publication.version)}`;
  const attributes = [
    'xmlns:dc="http://purl.org/dc/elements/1.1/"',
    'xmlns:premis="http://www.loc.gov/premis/rdf/v1#"',
    'xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    `dc:format="application/epub+zip${version}"`,
    ...(metadata?.identifier === undefined
      ? []
      : [`dc:identifier="${escape(metadata.identifier)}"`]),
    ...(metadata?.language === undefined ? [] : [`dc:language="${escape(metadata.language)}"`]),
    'rdf:about=""',
    ...(metadata?.modified === undefined ? [] : [`xmp:CreateDate="${escape(metadata.modified)}"`]),
  ];
  const outcomes = Groups.group(result.messages, options.maxOfEachMessage).flatMap((group) => [
    '                  <rdf:li rdf:parseType="Resource">',
    `                     <premis:hasEventOutcome>${escapeText(
      `${MessageCatalog.displayId(group.first.id)}, ${LABEL[group.first.severity].name}, ${group.first.message}`,
    )}</premis:hasEventOutcome>`,
    "                     <premis:hasEventOutcomeDetail>",
    "                        <rdf:Seq>",
    ...group.locations.map(
      (location) =>
        `                           <rdf:li premis:hasEventOutcomeDetailNote="${escape(where(result, location, options.path))}"/>`,
    ),
    "                        </rdf:Seq>",
    "                     </premis:hasEventOutcomeDetail>",
    "                  </rdf:li>",
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.0-jc003">',
    '   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `      <rdf:Description ${attributes.join("\n                        ")}>`,
    ...(metadata?.title === undefined
      ? []
      : [
          "         <dc:title>",
          "            <rdf:Alt>",
          `               <rdf:li xml:lang="x-default">${escapeText(metadata.title)}</rdf:li>`,
          "            </rdf:Alt>",
          "         </dc:title>",
        ]),
    '         <premis:hasEvent rdf:parseType="Resource">',
    `            <premis:hasEventDateTime rdf:datatype="http://www.w3.org/2001/XMLSchema#dateTime">${Dates.localIso(options.checkedAt)}</premis:hasEventDateTime>`,
    '            <premis:hasEventType rdf:resource="http://id.loc.gov/vocabulary/preservation/eventType/val"/>',
    `            <premis:hasEventDetail>${isWellFormed(result) ? "Well-formed" : "Not well-formed"}</premis:hasEventDetail>`,
    ...(outcomes.length === 0
      ? []
      : [
          "            <premis:hasEventOutcomeInformation>",
          "               <rdf:Seq>",
          ...outcomes,
          "               </rdf:Seq>",
          "            </premis:hasEventOutcomeInformation>",
        ]),
    '            <premis:hasEventRelatedAgent rdf:parseType="Resource">',
    '               <premis:hasAgentType rdf:resource="http://id.loc.gov/vocabulary/preservation/agentType/sof"/>',
    `               <premis:hasAgentName>epubcheck ${VERSION}</premis:hasAgentName>`,
    "            </premis:hasEventRelatedAgent>",
    "         </premis:hasEvent>",
    "      </rdf:Description>",
    "   </rdf:RDF>",
    "</x:xmpmeta>",
    "",
  ].join("\n");
};
