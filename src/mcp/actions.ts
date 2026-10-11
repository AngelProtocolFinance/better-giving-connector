import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { ActionName } from "../deployment";

export type ActionSpec = {
	tool: string;
	action: ActionName;
	title: string;
	description: string;
	input: z.ZodObject;
	annotations: ToolAnnotations;
};

/** One tool per `/connector/v1` action; each is registered on every server. */
export const ACTIONS: readonly ActionSpec[] = [];
