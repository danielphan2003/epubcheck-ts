import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  defaultSeverity,
  formatMessage,
  formatSuggestion,
  severityRank,
  type MessageId,
  type Severity,
} from "../messages/MessageCatalog.ts";

// Upstream EPUBLocation: a container-relative path plus 1-based line/column, or -1 when unknown.
export interface Location {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly context?: string | undefined;
}

export interface Message {
  readonly id: MessageId;
  readonly severity: Severity;
  readonly message: string;
  readonly suggestion: string;
  readonly location: Location;
}

export interface Override {
  readonly severity: Severity;
  readonly message?: string | undefined;
  readonly suggestion?: string | undefined;
}

export interface ReportOptions {
  readonly locale?: string | undefined;
  // Messages less severe than this are dropped, like upstream's `-e`, `-w`, `-u` flags. Default: INFO.
  readonly reportingLevel?: Severity | undefined;
  // Upstream's `--customMessages`: per-ID severity and text overrides.
  readonly overrides?: ReadonlyMap<MessageId, Override> | undefined;
}

export const location = (path: string, line = -1, column = -1, context?: string): Location => ({
  path,
  line,
  column,
  context,
});

export class Report extends Context.Service<
  Report,
  {
    readonly message: (
      id: MessageId,
      location: Location,
      ...args: ReadonlyArray<string>
    ) => Effect.Effect<void>;
    readonly messages: Effect.Effect<ReadonlyArray<Message>>;
    // The reporting locale, for checkers that format text of their own (such as CSS errors).
    readonly locale: string | undefined;
  }
>()("epubcheck-ts/report/Report") {}

export const make = (options: ReportOptions = {}) =>
  Effect.sync(() => {
    const reported: Array<Message> = [];
    const threshold = severityRank(options.reportingLevel ?? "INFO");

    // Called for every reported finding; a span per message would swamp traces.
    const message = Effect.fnUntraced(function* (
      id: MessageId,
      at: Location,
      ...args: ReadonlyArray<string>
    ) {
      const override = options.overrides?.get(id);
      const severity = override?.severity ?? defaultSeverity(id);
      if (severityRank(severity) < threshold) return;
      const entry: Message = {
        id,
        severity,
        message: formatMessage(id, args, options.locale, override?.message),
        suggestion: override?.suggestion ?? formatSuggestion(id, options.locale),
        location: at,
      };
      yield* Effect.sync(() => reported.push(entry));
    });

    return Report.of({
      message,
      messages: Effect.sync(() => [...reported]),
      locale: options.locale,
    });
  });

export const layer = (options?: ReportOptions) => Layer.effect(Report, make(options));
