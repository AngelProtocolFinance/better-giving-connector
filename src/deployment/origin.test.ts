import { describe, expect, test } from "vitest";
import { parseOrigin, parseTypedOrigin } from "./origin";

describe("parseOrigin", () => {
	test.each([
		["give.example.org", "https://give.example.org"],
		["https://give.example.org/donate", "https://give.example.org"],
		["  Give.Example.ORG/donate?x=1#top ", "https://give.example.org"],
		["HTTPS://give.example.org", "https://give.example.org"],
		["give.example.org.", "https://give.example.org"],
	])("accepts %j as %s", (input, origin) => {
		expect(parseOrigin(input)).toBe(origin);
	});

	test.each([
		["http", "http://give.example.org"],
		["another scheme", "ftp://give.example.org"],
		["an IPv4 literal", "203.0.113.7"],
		["a shorthand IPv4 literal", "https://127.1"],
		["an integer IPv4 literal", "2130706433"],
		["an IPv6 literal", "https://[::1]/"],
		["localhost", "localhost"],
		["a localhost subdomain", "app.localhost"],
		["localhost with a trailing dot", "localhost."],
		["a localhost subdomain with a trailing dot", "https://app.localhost./"],
		["two trailing dots", "give.example.org.."],
		["a single-label host", "https://intranet"],
		["a port", "give.example.org:8443"],
		["userinfo", "https://user:pw@give.example.org"],
		["a bare username", "https://user@give.example.org"],
		["an empty string", "   "],
		["garbage", "not a host"],
	])("refuses %s", (_, input) => {
		expect(parseOrigin(input)).toBeNull();
	});
});

describe("parseTypedOrigin", () => {
	test.each([
		["http://give.example.org/donate", "https://give.example.org"],
		[" HTTP://give.example.org", "https://give.example.org"],
		["give.example.org", "https://give.example.org"],
	])("accepts %j as %s", (input, origin) => {
		expect(parseTypedOrigin(input)).toBe(origin);
	});

	test.each([
		["http on a port", "http://give.example.org:8080"],
		["http to an IPv4 literal", "http://127.0.0.1"],
		["another scheme", "ftp://give.example.org"],
	])("refuses %s", (_, input) => {
		expect(parseTypedOrigin(input)).toBeNull();
	});
});
