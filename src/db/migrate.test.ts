import { expect, test } from "vitest";
import { createDb } from "./index";
import { migrate } from "./migrate";

test("a second run applies nothing", async () => {
	const db = createDb({ url: ":memory:" });

	const first = await migrate(db);
	const second = await migrate(db);

	expect(first).toContain("0002_connection.sql");
	expect(second).toEqual([]);
	db.close();
});
