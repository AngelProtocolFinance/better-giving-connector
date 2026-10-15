import { expect, test } from "vitest";
import { parseOrigin } from "../deployment/origin";
import { Secret } from "../secret";
import { ACTIONS } from "./actions";
import { runTool } from "./run-tool";

const spec = ACTIONS.find((action) => action.tool === "get_campaign");
const origin = parseOrigin("https://give.example.org");

test("an empty connection key is not used as a redaction pattern", async () => {
	if (!spec || !origin) throw new Error("missing campaign spec or origin");
	const answer = { note: "keep every character" };

	const result = await runTool(
		spec,
		{
			userId: "user",
			origin,
			orgName: "Give",
			key: new Secret(""),
			createdAt: new Date(),
		},
		{ id: "cmp_1" },
		{
			client: { call: async () => answer },
			dropConnection: async () => {},
		},
	);

	expect(result.content).toEqual([
		{ type: "text", text: JSON.stringify(answer) },
	]);
});
