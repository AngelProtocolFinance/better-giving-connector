import { inspect } from "node:util";

const REDACTED = "[redacted]";

// Holds a deployment's connector key so that printing, interpolating or
// serialising it can never leak the value; only `reveal()` reads it.
export class Secret {
	readonly #value: string;

	constructor(value: string) {
		this.#value = value;
	}

	reveal(): string {
		return this.#value;
	}

	toString(): string {
		return REDACTED;
	}

	toJSON(): string {
		return REDACTED;
	}

	[inspect.custom](): string {
		return REDACTED;
	}
}
