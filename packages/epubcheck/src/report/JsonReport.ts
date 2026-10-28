import type { CheckResult } from "../EpubCheck.ts";
import type { Message } from "./Report.ts";

// Mirrors the shape of upstream's Jackson-serialized CheckingReport; fields we do not compute yet are null.
const groupMessages = (messages: ReadonlyArray<Message>) => {
  const groups = new Map<string, { readonly first: Message; readonly all: Array<Message> }>();
  for (const message of messages) {
    const key = `${message.id}\u0000${message.message}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { first: message, all: [message] });
    else group.all.push(message);
  }
  return [...groups.values()].map(({ first, all }) => ({
    ID: first.id,
    severity: first.severity,
    message: first.message,
    additionalLocations: 0,
    locations: all.map((message) => ({
      path: message.location.path,
      line: message.location.line,
      column: message.location.column,
      context: message.location.context ?? null,
    })),
    suggestion: first.suggestion === "" ? null : first.suggestion,
  }));
};

export const render = (result: CheckResult) => {
  const count = (severity: Message["severity"]) =>
    result.messages.filter((message) => message.severity === severity).length;
  const filename = result.path.split(/[\\/]/).pop() ?? result.path;
  return JSON.stringify(
    {
      messages: groupMessages(result.messages),
      customMessageFileName: null,
      checker: {
        path: result.path,
        filename,
        checkerVersion: "epubcheck-ts",
        nFatal: count("FATAL"),
        nError: count("ERROR"),
        nWarning: count("WARNING"),
        nUsage: count("USAGE"),
      },
      publication: null,
      items: [],
    },
    null,
    2,
  );
};
