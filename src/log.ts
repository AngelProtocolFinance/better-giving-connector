import { type ActionName, isActionName } from "./deployment";

// The only place this service writes a log line. Each line is built from the
// fields its kind names, so a field riding along on the event object never
// reaches it; a tool name outside the contract's actions is written as
// "unknown". `errorName` is the one free string: pass `err.name`, never a message.

export type ToolOutcome =
	| "ok"
	| "invalid_input"
	| "key_refused"
	| "moved"
	| "needs_update"
	| "rejected"
	| "unreachable"
	| "server_error"
	| "failed";

/** Where a connect request ended: GET /connect, its POST, the return's stages, or Cancel. */
export type ConnectStep =
	| "open"
	| "address"
	| "return"
	| "exchange"
	| "complete"
	| "cancel";

export type ConnectOutcome =
	| "ok"
	| "expired"
	| "invalid_address"
	| "needs_update"
	| "unreachable"
	| "denied"
	| "state_mismatch"
	| "issuer_mismatch"
	| "code_invalid"
	| "failed";

export type LogEvent =
	| { kind: "tool"; tool: ActionName; outcome: ToolOutcome; ms: number }
	| { kind: "connect"; step: ConnectStep; outcome: ConnectOutcome }
	| { kind: "sweep"; connections: number; ms: number }
	| {
			kind: "error";
			where: "mcp" | "connect" | "auth" | "app" | "sweep" | "disconnect";
			errorName: string;
	  };

export function log(event: LogEvent): void {
	switch (event.kind) {
		case "tool": {
			const { kind, tool, outcome, ms } = event;
			const name = isActionName(tool) ? tool : "unknown";
			console.log(JSON.stringify({ kind, tool: name, outcome, ms }));
			return;
		}
		case "connect": {
			const { kind, step, outcome } = event;
			console.log(JSON.stringify({ kind, step, outcome }));
			return;
		}
		case "sweep": {
			const { kind, connections, ms } = event;
			console.log(JSON.stringify({ kind, connections, ms }));
			return;
		}
		case "error": {
			const { kind, where, errorName } = event;
			console.error(JSON.stringify({ kind, where, errorName }));
			return;
		}
	}
}
