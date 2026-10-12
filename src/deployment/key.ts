import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * A deployment's connector key. Printing, interpolating or serialising it shows `[redacted]`;
 * `reveal()` is the only read of the key itself.
 */
export class DeploymentKey {
  readonly #plain: string;

  constructor(plain: string) {
    this.#plain = plain;
  }

  reveal(): string {
    return this.#plain;
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
