import { z } from "zod";
import { forwarding } from "./forward.ts";
import { cursor, limit, listLine, withQuery } from "./list-tool.ts";
import { pathId, READ } from "./page-tool.ts";

const FOR_THE_OPERATOR =
  "The answer holds donors' names and emails: they are for the operator only, never to be passed on or published.";

export const listDonors = forwarding({
  name: "list_donors",
  title: "List donors",
  description: `Lists the operator's donors, a page at a time: each one's id, name and email. ${FOR_THE_OPERATOR}`,
  annotations: READ,
  input: z.object({
    cursor,
    limit,
    q: z
      .string()
      .min(1)
      .optional()
      .describe("Only donors whose name or email contains this text."),
  }),
  request: (query) => ({ method: "GET", path: withQuery("/donors", query) }),
  summary: (body) => listLine(body, ["donor", "donors"]),
});

export const getDonor = forwarding({
  name: "get_donor",
  title: "Read a donor",
  description: `Reads one donor: name, email, how many gifts they've made, how much they've given in minor units (cents; show the operator dollars), and when they last gave. ${FOR_THE_OPERATOR}`,
  annotations: READ,
  input: z.object({
    donor_id: pathId.describe("The donor's id, from list_donors."),
  }),
  request: ({ donor_id }) => ({
    method: "GET",
    path: `/donors/${encodeURIComponent(donor_id)}`,
  }),
  summary: (body) => {
    const { name, gifts_count } = body ?? {};
    return `${String(name)}: ${String(gifts_count)} gift${gifts_count === 1 ? "" : "s"}.`;
  },
});
