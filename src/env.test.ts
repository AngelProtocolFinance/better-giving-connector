import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { parseEnv } from "./env.ts";

const VALID = {
  PUBLIC_URL: "https://connect.better.giving",
  TURSO_DATABASE_URL: "libsql://connector-bg.turso.io",
  TURSO_AUTH_TOKEN: "turso-token-value-0001",
  BETTER_AUTH_SECRET: "auth-secret-value-0123456789abcdef0123",
  CONNECTION_KEY_SECRET: "Lr/Z0xJQHZpmF5zhgg5XymNMJUGxag0TOR8KYd2PPJc=",
  CRON_SECRET: "cron-secret-value-0123456789abcdef0123",
};

describe("parseEnv", () => {
  test("a missing required var throws naming it", () => {
    expect(() => parseEnv({ ...VALID, BETTER_AUTH_SECRET: undefined })).toThrow(
      "BETTER_AUTH_SECRET",
    );
  });

  test("a missing cron secret throws naming it", () => {
    expect(() => parseEnv({ ...VALID, CRON_SECRET: undefined })).toThrow(
      "Missing or invalid environment variables: CRON_SECRET.",
    );
  });

  test("an invalid value is named but never printed", () => {
    const shortSecret = "short-sekrit-77";
    const badUrl = "not a url sekrit-88";

    const error = caught(() =>
      parseEnv({
        ...VALID,
        BETTER_AUTH_SECRET: shortSecret,
        PUBLIC_URL: badUrl,
      }),
    );

    expect(error.message).toContain("BETTER_AUTH_SECRET");
    expect(error.message).toContain("PUBLIC_URL");
    const printed = [
      error.message,
      error.stack,
      inspect(error, { depth: null }),
    ].join("\n");
    expect(printed).not.toContain("sekrit");
  });

  test.each([
    [".env.example placeholder", "replace-with-connection-key-secret"],
    [
      "32 bytes as hex",
      "d0d761a7e5cdb98b5915ec048a06c9cd90044c023c51b7096e604dece8bce880",
    ],
    ["16 bytes as base64", "q83vASNFZ4mrze8BI0VniQ=="],
  ])(
    "a connection key secret that isn't 32 bytes of base64 is refused by name: %s",
    (_name, value) => {
      expect(() =>
        parseEnv({ ...VALID, CONNECTION_KEY_SECRET: value }),
      ).toThrow(
        "Missing or invalid environment variables: CONNECTION_KEY_SECRET.",
      );
    },
  );

  test("a local database URL needs no auth token", () => {
    for (const url of [":memory:", "file:local.db"]) {
      const env = parseEnv({
        ...VALID,
        TURSO_DATABASE_URL: url,
        TURSO_AUTH_TOKEN: "",
      });

      expect(env.TURSO_DATABASE_URL).toBe(url);
      expect(env.TURSO_AUTH_TOKEN).toBeUndefined();
    }
  });

  test("a remote database URL with its auth token parses", () => {
    expect(parseEnv(VALID)).toStrictEqual(VALID);
  });

  test("a remote database URL without an auth token throws naming the token", () => {
    expect(() => parseEnv({ ...VALID, TURSO_AUTH_TOKEN: "" })).toThrow(
      "Missing or invalid environment variables: TURSO_AUTH_TOKEN.",
    );
  });
});

function caught(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected an Error to be thrown");
}
