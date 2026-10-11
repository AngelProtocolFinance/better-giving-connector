import { z } from "zod";
import { campaignId, campaignPath } from "./campaigns.ts";
import { forwarding } from "./forward.ts";
import { withQuery } from "./list-tool.ts";
import { READ } from "./page-tool.ts";

const MINOR_UNITS =
  "Amounts are in minor units (cents: 25000 is $250.00); show the operator dollars.";

/** "2 gifts raising 25000 USD minor units" */
function raisedLine(body: Record<string, unknown> | null): string {
  const { gifts, raised_minor, currency } = body ?? {};
  return `${String(gifts)} gift${gifts === 1 ? "" : "s"} raising ${String(raised_minor)} ${String(currency)} minor units`;
}

export const getResults = forwarding({
  name: "get_results",
  title: "Read fundraising results",
  description: `Answers what the operator's Better Giving raised between two dates: the total, the number of gifts, new donors, active recurring gifts, and the same by month. ${MINOR_UNITS}`,
  revision: 1,
  annotations: READ,
  input: z.object({
    from: z.iso.date().describe("The first day counted, YYYY-MM-DD."),
    to: z.iso.date().describe("The last day counted, YYYY-MM-DD."),
  }),
  request: (range) => ({ method: "GET", path: withQuery("/results", range) }),
  summary: (body) => {
    const { donors_new, recurring_active } = body ?? {};
    return `${raisedLine(body)}; ${String(donors_new)} new donor${donors_new === 1 ? "" : "s"}; ${String(recurring_active)} recurring gift${recurring_active === 1 ? "" : "s"} active.`;
  },
});

export const getCampaignResults = forwarding({
  name: "get_campaign_results",
  title: "Read a campaign's results",
  description: `Answers what one campaign has raised: the total, its goal, and the number of gifts. ${MINOR_UNITS}`,
  revision: 1,
  annotations: READ,
  input: z.object({ campaign_id: campaignId }),
  request: ({ campaign_id }) => ({
    method: "GET",
    path: `${campaignPath(campaign_id)}/results`,
  }),
  summary: (body) => {
    const goal = body?.goal_minor;
    return `${raisedLine(body)}, ${typeof goal === "number" ? `of a ${goal} goal` : "with no goal set"}.`;
  },
});
