// The only place this service writes a log line. Every event is a closed shape
// of names and enums: there is no slot a key, a tool argument, a tool result
// or a free-form message could ride in.

export type ToolOutcome =
	| "ok"
	| "key_refused"
	| "needs_update"
	| "rejected"
	| "unreachable"
	| "failed";

export type ConnectStep =
	| "address"
	| "hello"
	| "allow"
	| "return"
	| "exchange"
	| "complete";

export type ConnectOutcome =
	| "ok"
	| "needs_update"
	| "unreachable"
	| "denied"
	| "state_mismatch"
	| "code_invalid"
	| "failed";

export type LogEvent =
	| { kind: "tool"; tool: string; outcome: ToolOutcome; ms: number }
	| { kind: "connect"; step: ConnectStep; outcome: ConnectOutcome }
	| {
			kind: "error";
			where: "mcp" | "connect" | "auth" | "app";
			errorName: string;
	  };

export function log(event: LogEvent): void {
	const line = JSON.stringify(event);
	if (event.kind === "error") console.error(line);
	else console.log(line);
}
