import type { Problem } from "./contract";

// Every failure of a deployment request. Messages are fixed text and no error
// takes a `cause`: a key, a tool input or a response body never rides along
// into a log line or a chat.

export class KeyRefused extends Error {
	override readonly name = "KeyRefused";
	constructor() {
		super("The deployment refused the connector key.");
	}
}

/** The release has no `/connector/v1`, or not this action, or isn't Better Giving at all. */
export class NeedsUpdate extends Error {
	override readonly name = "NeedsUpdate";
	constructor() {
		super("The deployment does not serve this connector contract.");
	}
}

/** A single-use Allow code that is used, expired or unknown. */
export class CodeInvalid extends Error {
	override readonly name = "CodeInvalid";
	constructor() {
		super("The deployment refused the Allow code.");
	}
}

/** The site redirects its connector to another https origin: it answers at a new address now. */
export class Moved extends Error {
	override readonly name = "Moved";
	constructor() {
		super("The deployment redirects to another origin.");
	}
}

export class Unreachable extends Error {
	override readonly name = "Unreachable";
	constructor() {
		super("The deployment did not answer usably.");
	}
}

/** A 4xx the chat can act on; `problem` is what its body says, if it is a problem. */
export class DeploymentRejected extends Error {
	override readonly name = "DeploymentRejected";
	declare readonly problem: Problem | null;
	constructor(
		readonly status: number,
		problem: Problem | null,
	) {
		super(`The deployment rejected the request (${status}).`);
		// Non-enumerable, so JSON.stringify and util.inspect of the error leave it out.
		Object.defineProperty(this, "problem", {
			value: problem,
			enumerable: false,
		});
	}
}
