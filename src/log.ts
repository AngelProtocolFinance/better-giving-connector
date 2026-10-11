/**
 * Every shape a log line can take. No field holds a message, a stack, a body,
 * a header or a raw URL: an error here may carry a deployment key or donor data.
 */
export type LogEntry =
  | {
      event: "request";
      method: string;
      /** the matched route pattern, never the requested path; null when no route matched */
      route: string | null;
      status: number;
      durationMs: number;
    }
  | ({ event: "unhandled_error"; method: string; route: string } & ErrorClass);

export interface ErrorClass {
  errorName: string;
  errorCode?: string;
}

export type LogLevel = "info" | "error";
export type LogSink = (line: string, level: LogLevel) => void;
export type Log = (entry: LogEntry) => void;

/** Library errors name their class and code as identifiers; anything else may be data. */
const IDENTIFIER = /^[A-Za-z_$][\w$.-]{0,63}$/;

function identifier(value: string | undefined): string | undefined {
  return value !== undefined && IDENTIFIER.test(value) ? value : undefined;
}

/** `error`'s class and, when it carries a string one, its code. */
export function errorClass(error: Error): ErrorClass {
  const code: unknown = (error as { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
}

/** Rebuilt field by field, so a widened entry's extra properties never reach the sink. */
function allowListed(entry: LogEntry): LogEntry {
  switch (entry.event) {
    case "request":
      return {
        event: entry.event,
        method: entry.method,
        route: entry.route,
        status: entry.status,
        durationMs: entry.durationMs,
      };
    case "unhandled_error": {
      const errorCode = identifier(entry.errorCode);
      return {
        event: entry.event,
        method: entry.method,
        route: entry.route,
        errorName: identifier(entry.errorName) ?? "Error",
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }
  }
}

/** One JSON line per entry. */
export function createLogger(write: LogSink): Log {
  return (entry) =>
    write(
      JSON.stringify(allowListed(entry)),
      entry.event === "unhandled_error" ? "error" : "info",
    );
}

/** Errors to stderr, so the platform's log view files them at error level. */
export const consoleSink: LogSink = (line, level) => {
  if (level === "error") console.error(line);
  else console.log(line);
};
