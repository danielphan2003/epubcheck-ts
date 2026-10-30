import type { Message } from "./Report.ts";

// Upstream's reports merge messages with the same ID, severity and text, list at most
// `maxOfEachMessage` locations for each (negative: all), and count the rest. A location equal
// to a listed one is dropped.

export interface Group {
  readonly first: Message;
  readonly locations: ReadonlyArray<Message["location"]>;
  readonly additionalLocations: number;
}

export const DEFAULT_MAX_OF_EACH_MESSAGE = 25;

export const group = (messages: ReadonlyArray<Message>, maxOfEachMessage: number) => {
  const groups = new Map<string, { readonly first: Message; readonly all: Array<Message> }>();
  for (const message of messages) {
    const key = `${message.id}\u0000${message.severity}\u0000${message.message}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { first: message, all: [message] });
    else existing.all.push(message);
  }
  return [...groups.values()].map(({ first, all }): Group => {
    const locations: Array<Message["location"]> = [];
    const listed = new Set<string>();
    let additionalLocations = 0;
    for (const { location } of all) {
      const { path, line, column, context } = location;
      const key = JSON.stringify([path, line, column, context]);
      if (listed.has(key)) continue;
      if (maxOfEachMessage < 0 || locations.length < maxOfEachMessage) {
        locations.push(location);
        listed.add(key);
      } else additionalLocations++;
    }
    return { first, locations, additionalLocations };
  });
};

// The JSON report lists groups by ID, then text, in UTF-16 order like Java's `String.compareTo`.
export const byIdThenText = (left: Group, right: Group) => {
  const a = `${left.first.id}\u0000${left.first.message}`;
  const b = `${right.first.id}\u0000${right.first.message}`;
  return a < b ? -1 : a > b ? 1 : 0;
};
