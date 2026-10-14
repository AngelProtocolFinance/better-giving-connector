import { afterEach, beforeEach, expect, test } from "vitest";
import { freshDb } from "../../test/support";
import type { Origin } from "../deployment/origin";
import { Secret } from "../secret";
import {
	ConnectionKeySecretMismatch,
	ConnectionKeyUnreadable,
	connections,
	type Db,
} from "./index";

const SECRET = "test-connection-key-secret-aaaaaaaaaaaaaaaa";
const KEY = "bgk_live_sentinel_7f3a9c";
const ORIGIN = "https://give.example.org" as Origin;

let db: Db;

async function insertUser1(store = connections(db, SECRET)) {
	await store.insert({
		userId: "user-1",
		origin: ORIGIN,
		orgName: "Example Org",
		key: new Secret(KEY),
	});
}

async function storedCiphertext(): Promise<string> {
	const { rows } = await db.execute(
		"SELECT key_ct FROM connection WHERE user_id = 'user-1'",
	);
	return String(rows[0]?.key_ct);
}

async function expectUnreadable(read: Promise<unknown>) {
	const ct = await storedCiphertext();
	const err = await read.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(ConnectionKeyUnreadable);
	const message = (err as Error).message;
	expect(message).not.toContain(KEY);
	expect(message).not.toContain(ct.split(".")[3]);
}

beforeEach(async () => {
	db = await freshDb();
});

afterEach(() => db.close());

test("get returns the inserted connection with its key as a Secret", async () => {
	const store = connections(db, SECRET);
	const before = Date.now();

	await store.insert({
		userId: "user-1",
		origin: ORIGIN,
		orgName: "Example Org",
		key: new Secret(KEY),
	});
	const conn = await store.get("user-1");

	expect(conn?.userId).toBe("user-1");
	expect(conn?.origin).toBe(ORIGIN);
	expect(conn?.orgName).toBe("Example Org");
	expect(conn?.key).toBeInstanceOf(Secret);
	expect(conn?.key.reveal()).toBe(KEY);
	expect(conn?.createdAt.getTime()).toBeGreaterThanOrEqual(before);
	expect(conn?.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
});

test("the stored row never contains the plaintext key", async () => {
	await insertUser1();

	const { rows } = await db.execute("SELECT * FROM connection");

	expect(rows).toHaveLength(1);
	expect(JSON.stringify(rows)).not.toContain(KEY);
});

test("a row copied to another user fails to decrypt", async () => {
	await insertUser1();
	await db.execute(
		"INSERT INTO connection SELECT 'user-2', origin, org_name, key_ct, created_at FROM connection WHERE user_id = 'user-1'",
	);

	await expectUnreadable(connections(db, SECRET).get("user-2"));
});

test("a row whose origin is rewritten fails to decrypt", async () => {
	await insertUser1();
	await db.execute(
		"UPDATE connection SET origin = 'https://evil.example' WHERE user_id = 'user-1'",
	);

	await expectUnreadable(connections(db, SECRET).get("user-1"));
});

test.each([
	["an unknown version", (ct: string) => ct.replace(/^v2\./, "v9.")],
	[
		"the pre-kid v1 label on today's segments",
		(ct: string) => ct.replace(/^v2\./, "v1."),
	],
	["an extra segment", (ct: string) => `${ct}.AAAA`],
])("a stored key with %s is unreadable", async (_, malform) => {
	await insertUser1();
	await db.execute({
		sql: "UPDATE connection SET key_ct = ? WHERE user_id = 'user-1'",
		args: [malform(await storedCiphertext())],
	});

	await expectUnreadable(connections(db, SECRET).get("user-1"));
});

test("a key read under another CONNECTION_KEY_SECRET is a secret mismatch, not unreadable", async () => {
	await insertUser1();

	const err = await connections(
		db,
		"another-connection-key-secret-bbbbbbbbbbbb",
	)
		.get("user-1")
		.then(
			() => null,
			(e: unknown) => e,
		);

	expect(err).toBeInstanceOf(ConnectionKeySecretMismatch);
	expect(err).not.toBeInstanceOf(ConnectionKeyUnreadable);
	expect((err as Error).message).not.toContain(KEY);
});

test("a stored key is labelled v2 with four segments, since v1 had no kid", async () => {
	await insertUser1();

	expect((await storedCiphertext()).split(".")).toMatchObject([
		"v2",
		expect.any(String),
		expect.any(String),
		expect.any(String),
	]);
});

test("get of a user with no connection is null", async () => {
	expect(await connections(db, SECRET).get("nobody")).toBeNull();
});

test("get after delete is null", async () => {
	const store = connections(db, SECRET);
	await insertUser1(store);

	await store.delete("user-1");

	expect(await store.get("user-1")).toBeNull();
});

test("deleting twice is fine", async () => {
	const store = connections(db, SECRET);
	await insertUser1(store);
	await store.delete("user-1");

	await expect(store.delete("user-1")).resolves.toBeUndefined();
	expect(await store.get("user-1")).toBeNull();
});
