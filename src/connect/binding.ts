import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** HKDF `info`: this key signs nothing else derived from the same secret. */
const LABEL = "better-giving-connector/connect-attempt-state/v1";
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Connect-attempt states bound to the browser that started the attempt: a state is a random
 * attempt id and an HMAC of it under that browser's nonce, which only that browser's cookie holds.
 */
export function attemptBinding(secret: string) {
  const key = Buffer.from(hkdfSync("sha256", secret, "", LABEL, 32));
  const tag = (nonce: string, attemptId: string) =>
    createHmac("sha256", key).update(`${nonce}.${attemptId}`).digest();

  return {
    newNonce: (): string => randomBytes(32).toString("base64url"),

    /** Whether `value`, read from a cookie, has a nonce's shape. */
    isNonce: (value: string | undefined): value is string =>
      value !== undefined && NONCE.test(value),

    /** A new attempt's state, for the browser holding `nonce`. */
    stateFor(nonce: string): string {
      const attemptId = randomBytes(32).toString("base64url");
      return `${attemptId}.${tag(nonce, attemptId).toString("base64url")}`;
    },

    /** Whether `state` was made for the browser holding `nonce`. */
    isBound(state: string, nonce: string): boolean {
      const [attemptId, given, ...rest] = state.split(".");
      if (attemptId === undefined || given === undefined || rest.length > 0) {
        return false;
      }
      const expected = tag(nonce, attemptId);
      const received = Buffer.from(given, "base64url");
      return (
        received.byteLength === expected.byteLength &&
        timingSafeEqual(received, expected)
      );
    },
  };
}

export type AttemptBinding = ReturnType<typeof attemptBinding>;
