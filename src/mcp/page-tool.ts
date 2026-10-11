import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";

/** A read of the deployment. */
export const READ: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/** A change to a draft or a new draft: nothing donors see until a publish. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/** A change donors see, or one that can't be taken back: the description asks for the operator's yes first. */
export const NEEDS_A_YES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

/**
 * An id that goes into an action's path: `.` and `..` would resolve to another action, and a lone
 * surrogate makes `encodeURIComponent` throw.
 */
export const pathId = z
  .string()
  .min(1)
  .refine((id) => id !== "." && id !== "..", "Not an id.")
  // `isWellFormed()`, which lib es2022 doesn't type: under `u` only an unpaired surrogate is \p{Cs}
  .refine((id) => !/\p{Cs}/u.test(id), "Not an id.");

/** The `version` a write sends: the page's, as the chat last read it. */
export function versionFromLastRead(page: string, read: string) {
  return z
    .string()
    .min(1)
    .describe(
      `The ${page}'s version, from ${read} or the answer to your last change to it. A change sent with an older version is refused, and you read the ${page} again.`,
    );
}

export const pageDocument = z
  .record(z.string(), z.unknown())
  .describe(
    "The whole page document, replacing the draft: layout, palette, look, share settings, switches and blocks, with exactly one donation-box block. get_page_catalog answers its JSON Schema. A refusal names the field to fix.",
  );
