import { z } from "zod";
import { forwarding } from "./forward.ts";
import {
  NEEDS_A_YES,
  pageDocument,
  pageId,
  READ,
  versionFromLastRead,
  WRITE,
} from "./page-tool.ts";

const CAMPAIGN_TYPES = [
  "year_end",
  "emergency",
  "building",
  "event",
  "tribute",
  "monthly",
  "program",
  "other",
] as const;

const campaignId = pageId.describe(
  "The campaign's id, from list_campaigns or create_campaign.",
);

const campaignVersion = versionFromLastRead("campaign", "get_campaign");

/** "Spring Appeal: live, https://…" */
function campaignLine(body: Record<string, unknown> | null): string {
  const { name, state, url } = body ?? {};
  return `${String(name)}: ${String(state)}, ${String(url)}`;
}

function campaignPath(id: string): `/${string}` {
  return `/campaigns/${encodeURIComponent(id)}`;
}

/** A versioned write to `/campaigns/:id<action>` that sends only the version. */
function campaignAction(
  name: string,
  action: "/discard-draft" | "/unpublish" | "/end",
  copy: { title: string; description: string; destructive: boolean },
) {
  return forwarding({
    name,
    title: copy.title,
    description: copy.description,
    revision: 1,
    annotations: copy.destructive ? NEEDS_A_YES : WRITE,
    input: z.object({ campaign_id: campaignId, version: campaignVersion }),
    request: ({ campaign_id, version }) => ({
      method: "POST",
      path: `${campaignPath(campaign_id)}${action}`,
      body: { version },
    }),
    summary: campaignLine,
  });
}

export const listCampaigns = forwarding({
  name: "list_campaigns",
  title: "List campaigns",
  description:
    "Lists the operator's Better Giving campaigns: each one's id, name, address, state (never_published, live or ended), money raised and version. Use an id from here with the other campaign tools.",
  revision: 1,
  annotations: READ,
  input: z.object({
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The next_cursor of the previous page, to read the page after it. Leave it out for the first page.",
      ),
  }),
  request: ({ cursor }) => ({
    method: "GET",
    path:
      cursor === undefined
        ? "/campaigns"
        : `/campaigns?${new URLSearchParams({ cursor })}`,
  }),
  summary: (body) => {
    const campaigns = Array.isArray(body?.data) ? body.data : [];
    const listed = campaigns
      .map(
        (campaign: { name?: unknown; state?: unknown }) =>
          `${String(campaign.name)} (${String(campaign.state)})`,
      )
      .join(", ");
    const more =
      typeof body?.next_cursor === "string"
        ? " More on the next page: call again with next_cursor."
        : "";
    return `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}${listed === "" ? "." : `: ${listed}.`}${more}`;
  },
});

export const getCampaign = forwarding({
  name: "get_campaign",
  title: "Read a campaign",
  description:
    "Reads one campaign whole: its state, its editor_state (unpublished, changed, live or ended), its draft page document, its published page document, and the version every change to it must send.",
  revision: 1,
  annotations: READ,
  input: z.object({ campaign_id: campaignId }),
  request: ({ campaign_id }) => ({
    method: "GET",
    path: campaignPath(campaign_id),
  }),
  summary: campaignLine,
});

export const createCampaign = forwarding({
  name: "create_campaign",
  title: "Create a campaign",
  description:
    "Creates a new campaign on the operator's Better Giving, not yet published: it takes no gifts until publish_campaign. Answers the campaign with its id, its starting draft and its version.",
  revision: 1,
  annotations: WRITE,
  input: z.object({
    name: z.string().min(1).describe("The campaign's name, as donors see it."),
    campaign_type: z
      .enum(CAMPAIGN_TYPES)
      .describe("What the campaign raises for."),
  }),
  request: (body) => ({ method: "POST", path: "/campaigns", body }),
  summary: campaignLine,
});

export const renameCampaign = forwarding({
  name: "rename_campaign",
  title: "Rename a campaign",
  description:
    "Changes a campaign's name, its address (slug), or both. A live campaign's address changes for donors at once.",
  revision: 1,
  annotations: WRITE,
  input: z.object({
    campaign_id: campaignId,
    version: campaignVersion,
    name: z.string().min(1).optional().describe("The new name."),
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The new last part of the campaign's address, e.g. winter-coats.",
      ),
  }),
  request: ({ campaign_id, ...body }) => ({
    method: "PATCH",
    path: campaignPath(campaign_id),
    body,
  }),
  summary: campaignLine,
});

export const editCampaignPage = forwarding({
  name: "edit_campaign_page",
  title: "Edit a campaign's page",
  description:
    "Replaces a campaign's draft page with a whole new page document. Donors see none of it until publish_campaign. Start from the draft get_campaign answers and change what the operator asked for.",
  revision: 1,
  annotations: WRITE,
  input: z.object({
    campaign_id: campaignId,
    version: campaignVersion,
    document: pageDocument,
  }),
  request: ({ campaign_id, version, document }) => ({
    method: "PUT",
    path: `${campaignPath(campaign_id)}/draft`,
    body: { version, document },
  }),
  summary: campaignLine,
});

export const discardCampaignChanges = campaignAction(
  "discard_campaign_changes",
  "/discard-draft",
  {
    title: "Discard a campaign's draft changes",
    description:
      "Throws away the changes in a campaign's draft that haven't been published, so the draft matches the published page again.",
    destructive: false,
  },
);

export const publishCampaign = forwarding({
  name: "publish_campaign",
  title: "Publish a campaign",
  description:
    "Ask the operator “Publish this campaign now? It will start taking gifts.” and call only after they say yes. Puts the campaign's draft on its public address, where it takes gifts.",
  revision: 1,
  annotations: NEEDS_A_YES,
  input: z.object({
    campaign_id: campaignId,
    version: campaignVersion,
    gifts_go_to: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "Where the campaign's gifts go: a program id, or null for the general fund. Required on a campaign's first publish; leave it out after that.",
      ),
  }),
  request: ({ campaign_id, ...body }) => ({
    method: "POST",
    path: `${campaignPath(campaign_id)}/publish`,
    body,
  }),
  summary: campaignLine,
});

export const unpublishCampaign = campaignAction(
  "unpublish_campaign",
  "/unpublish",
  {
    title: "Unpublish a campaign",
    description:
      "Ask the operator “Take this campaign off its public address? It will stop taking gifts; its draft stays.” and call only after they say yes. Takes a live campaign off its address; publish_campaign puts it back.",
    destructive: true,
  },
);

export const endCampaign = campaignAction("end_campaign", "/end", {
  title: "End a campaign",
  description:
    "Ask the operator “End this campaign? It will stop taking gifts and show as ended.” and call only after they say yes. Ends a live campaign.",
  destructive: true,
});

export const deleteCampaign = forwarding({
  name: "delete_campaign",
  title: "Delete a campaign",
  description:
    "Ask the operator “Delete this campaign? It can't be undone.” and call only after they say yes. Only a campaign that was never published can be deleted; end or unpublish one that was.",
  revision: 1,
  annotations: NEEDS_A_YES,
  input: z.object({ campaign_id: campaignId, version: campaignVersion }),
  request: ({ campaign_id, version }) => ({
    method: "DELETE",
    path: campaignPath(campaign_id),
    body: { version },
  }),
  summary: () => "Deleted the campaign.",
});
