import { z } from "zod";
import { forwarding } from "./forward.ts";
import { cursor, limit, listLine, withQuery } from "./list-tool.ts";
import { READ, WRITE } from "./page-tool.ts";

export const listGifts = forwarding({
  name: "list_gifts",
  title: "List gifts",
  description:
    "Lists the gifts the operator's Better Giving received, a page at a time: each one's id, donor id, amount in minor units (cents; show the operator dollars), currency, date, method, program and form. The donor's name is on get_donor.",
  revision: 1,
  annotations: READ,
  input: z.object({
    cursor,
    limit,
    form_id: z
      .string()
      .min(1)
      .optional()
      .describe("Only the gifts made through this form, from list_forms."),
    since: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .optional()
      .describe(
        "Only the gifts recorded at or after this date (YYYY-MM-DD) or ISO-8601 time.",
      ),
  }),
  request: (query) => ({ method: "GET", path: withQuery("/gifts", query) }),
  summary: (body) => listLine(body, ["gift", "gifts"]),
});

export const listRecurringGifts = forwarding({
  name: "list_recurring_gifts",
  title: "List recurring gifts",
  description:
    "Lists the donors' recurring (monthly) gifts, a page at a time: each one's id, donor id, amount in minor units (cents; show the operator dollars), status and next charge. Read only: a change to a donor's monthly gift, or stopping one, is made in the Better Giving dashboard, not from the chat.",
  revision: 1,
  annotations: READ,
  input: z.object({ cursor, limit }),
  request: (query) => ({
    method: "GET",
    path: withQuery("/recurring-gifts", query),
  }),
  summary: (body) => listLine(body, ["recurring gift", "recurring gifts"]),
});

export const recordGift = forwarding({
  name: "record_gift",
  title: "Record a cash or check gift",
  description:
    "Records a gift the operator received by hand: only cash and check gifts can be recorded; gifts made online arrive on their own. Before calling, confirm the amount, donor and date with the operator in one line, e.g. “Record a $50.00 check from Ana Ruiz dated 2026-10-03?”, and call only after they say yes. Every call records a new gift: if a call didn't answer, check list_gifts before calling again.",
  revision: 1,
  annotations: WRITE,
  input: z.object({
    donor: z
      .union([
        z.object({
          id: z.string().min(1).describe("The donor's id, from list_donors."),
        }),
        z.object({
          new: z.object({
            name: z.string().min(1).describe("The new donor's name."),
            email: z
              .email()
              .optional()
              .describe("The new donor's email, when the operator has it."),
          }),
        }),
      ])
      .describe(
        "Who gave: { id } for a donor list_donors found, or { new: { name, email? } } for someone who hasn't given before. Search list_donors with q first.",
      ),
    amount_minor: z
      .number()
      .int()
      .positive()
      .describe(
        "The gift's amount in minor units: cents, so 5000 is $50.00. Show the operator dollars.",
      ),
    dated: z.iso
      .date()
      .describe(
        "The date on the check, or the day the cash was given: YYYY-MM-DD.",
      ),
    method: z.enum(["cash", "check"]).describe("How the gift was given."),
    program_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The program the gift is for, from list_programs; left out, it goes to the general fund.",
      ),
    form_id: z
      .string()
      .min(1)
      .optional()
      .describe("The form the gift is counted under, from list_forms."),
    note: z
      .string()
      .min(1)
      .optional()
      .describe("A note for the operator's records, e.g. the check number."),
  }),
  // a fresh key per call: the model retrying a call means another gift, never a replay of this one
  request: (gift) => ({
    method: "POST",
    path: "/gifts",
    body: { idempotency_key: crypto.randomUUID(), ...gift },
  }),
  summary: (body) => {
    const { method, amount_minor, currency, dated } = body ?? {};
    return `Recorded a ${String(method)} gift of ${String(amount_minor)} ${String(currency)} minor units, dated ${String(dated)}.`;
  },
});
