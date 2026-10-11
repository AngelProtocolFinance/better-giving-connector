import { describe, expect, test } from "vitest";
import { parseAddress } from "./address.ts";

describe("parseAddress", () => {
  test.each([
    "give.hopeshelter.org",
    "https://give.hopeshelter.org/",
    "give.hopeshelter.org/campaigns/year-end?x=1",
    "  http://GIVE.HopeShelter.org/#donate ",
  ])("reads %j as the https origin", (typed) => {
    expect(parseAddress(typed)).toStrictEqual({
      ok: true,
      origin: "https://give.hopeshelter.org",
    });
  });

  test("keeps www. and a port", () => {
    expect(parseAddress("www.hopeshelter.org:8443/give")).toStrictEqual({
      ok: true,
      origin: "https://www.hopeshelter.org:8443",
    });
  });

  test.each([
    "ftp://give.hopeshelter.org",
    "[::1]",
    "https://[2001:db8::1]/",
    "0x7f.1",
  ])("refuses %j as not a web address", (typed) => {
    expect(parseAddress(typed)).toStrictEqual({
      ok: false,
      error: "not_an_address",
    });
  });
});
