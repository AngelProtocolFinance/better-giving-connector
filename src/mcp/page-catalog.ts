import { z } from "zod";
import { forwarding } from "./forward.ts";
import { pageId, READ, WRITE } from "./page-tool.ts";

export const getPageCatalog = forwarding({
  name: "get_page_catalog",
  title: "Read the page catalog",
  description:
    "Answers the JSON Schema of a page document: every block a campaign page or the donation page can hold and the rules each field meets. Read it before building a document for edit_campaign_page or edit_donation_page.",
  revision: 1,
  annotations: READ,
  input: z.object({}),
  request: () => ({ method: "GET", path: "/page-catalog" }),
  summary: () => "The page document's JSON Schema, in the structured result.",
});

export const getPhotoUploadLink = forwarding({
  name: "get_photo_upload_link",
  title: "Get a photo upload link",
  description:
    "Makes a link for putting one photo into an image or hero block of a page's draft. Hand the returned link to the operator to open on their phone: it takes one image for that block, needs no sign-in, works once, and expires in 30 minutes. The photo never passes through the chat.",
  revision: 1,
  annotations: WRITE,
  input: z.object({
    target: z
      .enum(["campaign", "donation_page"])
      .describe(
        "Whether the block is on a campaign's page or on the donation page.",
      ),
    campaign_id: pageId
      .optional()
      .describe(
        "The campaign's id, from list_campaigns; required when target is campaign.",
      ),
    block_id: z
      .string()
      .min(1)
      .describe(
        "The id of the block in the page's draft that takes the photo.",
      ),
  }),
  request: ({ target, campaign_id, block_id }) => ({
    method: "POST",
    path: "/photo-links",
    body: { target, page_id: campaign_id, block_id },
  }),
  summary: (body) =>
    `Photo link for the operator: ${String(body?.url)} (expires ${String(body?.expires_at)}).`,
});
