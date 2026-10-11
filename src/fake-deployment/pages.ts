import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";

/**
 * A deployment's campaigns, donation page, page catalog and photo links (docs/connector-v1.md →
 * Actions), in memory: shapes, lifecycle and version checks as the contract states them, and a
 * page document checked only for its one `donation-box` block.
 */

type PageDocument = Record<string, unknown>;

interface StoredCampaign {
  id: string;
  name: string;
  slug: string;
  campaign_type: string;
  version: string;
  draft: PageDocument;
  published: PageDocument | null;
  live: boolean;
  ended: boolean;
}

const CAMPAIGN_TYPES = new Set([
  "year_end",
  "emergency",
  "building",
  "event",
  "tribute",
  "monthly",
  "program",
  "other",
]);

const PHOTO_LINK_LIFETIME_MS = 30 * 60 * 1000;

function refusal(error: string, message: string, fix: string) {
  return { error, message, fix };
}

function starterDocument(name: string): PageDocument {
  return {
    name,
    blocks: [
      { id: "blk_title", type: "title" },
      { id: "blk_hero", type: "hero" },
      { id: "blk_give", type: "donation-box" },
    ],
  };
}

/** What a page document fails, naming the field path; null when it passes the fake's one rule. */
function documentProblem(document: unknown): string | null {
  if (typeof document !== "object" || document === null) {
    return "document must be an object.";
  }
  const { blocks } = document as { blocks?: unknown };
  if (!Array.isArray(blocks)) return "document.blocks must be a list.";
  const boxes = blocks.filter(
    (block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "donation-box",
  ).length;
  return boxes === 1
    ? null
    : `document.blocks must hold exactly one donation-box block; it holds ${boxes}.`;
}

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sameDocument(a: PageDocument | null, b: PageDocument): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => ({}));
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function fakePages() {
  // a version is an `updated_at`; a second per write keeps two writes from sharing one
  let clock = Date.parse("2026-10-01T00:00:00.000Z");
  const nextVersion = () => new Date((clock += 1000)).toISOString();

  const campaigns = new Map<string, StoredCampaign>();
  const donationPage = {
    draft: starterDocument("Give to Hope Shelter"),
    published: starterDocument("Give to Hope Shelter"),
    version: nextVersion(),
  };

  function campaignView(campaign: StoredCampaign, origin: string) {
    const state = campaign.ended
      ? "ended"
      : campaign.live
        ? "live"
        : "never_published";
    const editor_state = campaign.ended
      ? "ended"
      : !campaign.live
        ? "unpublished"
        : sameDocument(campaign.published, campaign.draft)
          ? "live"
          : "changed";
    return {
      id: campaign.id,
      name: campaign.name,
      slug: campaign.slug,
      url: `${origin}/c/${campaign.slug}`,
      state,
      campaign_type: campaign.campaign_type,
      goal_minor: null,
      ends_at: null,
      raised_minor: 0,
      currency: "USD",
      version: campaign.version,
      editor_state,
      draft: campaign.draft,
      published: campaign.published,
    };
  }

  function donationPageView(origin: string) {
    return {
      url: `${origin}/give`,
      editor_state: sameDocument(donationPage.published, donationPage.draft)
        ? "live"
        : "changed",
      draft: donationPage.draft,
      published: donationPage.published,
      version: donationPage.version,
    };
  }

  const notFound = (c: Context, id: string) =>
    c.json(
      refusal(
        "not_found",
        `No campaign has the id ${id}.`,
        "List the campaigns to get its id.",
      ),
      404,
    );

  const stale = (c: Context) =>
    c.json(
      refusal(
        "stale",
        "The page changed since it was read.",
        "Read it again, then make the change.",
      ),
      409,
    );

  const invalidDocument = (c: Context, message: string) =>
    c.json(
      refusal(
        "invalid_document",
        message,
        "Fix that field of the document; get_page_catalog has the rules.",
      ),
      422,
    );

  /** The campaign `:id` names, when the body's `version` is its current one; else the refusal. */
  async function writable(c: Context) {
    const id = c.req.param("id") ?? "";
    const campaign = campaigns.get(id);
    if (campaign === undefined) {
      return { refused: notFound(c, id) } as const;
    }
    const body = await bodyOf(c);
    if (body.version !== campaign.version)
      return { refused: stale(c) } as const;
    return { campaign, body } as const;
  }

  return new Hono()
    .get("/campaigns", (c) => {
      const { origin } = new URL(c.req.url);
      return c.json(
        {
          data: [...campaigns.values()].map((campaign) => {
            const { editor_state, draft, published, ...summary } = campaignView(
              campaign,
              origin,
            );
            return summary;
          }),
          next_cursor: null,
        },
        200,
      );
    })
    .post("/campaigns", async (c) => {
      const { name, campaign_type } = await bodyOf(c);
      if (typeof name !== "string" || name.trim() === "") {
        return c.json(
          refusal(
            "invalid_name",
            "name is empty.",
            "Give the campaign a name.",
          ),
          422,
        );
      }
      if (
        typeof campaign_type !== "string" ||
        !CAMPAIGN_TYPES.has(campaign_type)
      ) {
        return c.json(
          refusal(
            "invalid_campaign_type",
            "campaign_type is not one of the campaign types.",
            "Use year_end, emergency, building, event, tribute, monthly, program or other.",
          ),
          422,
        );
      }
      const campaign: StoredCampaign = {
        id: `cmp_${randomBytes(6).toString("hex")}`,
        name,
        slug: slugOf(name),
        campaign_type,
        version: nextVersion(),
        draft: starterDocument(name),
        published: null,
        live: false,
        ended: false,
      };
      campaigns.set(campaign.id, campaign);
      return c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .get("/campaigns/:id", (c) => {
      const campaign = campaigns.get(c.req.param("id"));
      return campaign === undefined
        ? notFound(c, c.req.param("id"))
        : c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .patch("/campaigns/:id", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { campaign, body } = found;
      if (typeof body.name === "string") campaign.name = body.name;
      if (typeof body.slug === "string") campaign.slug = body.slug;
      campaign.version = nextVersion();
      return c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .put("/campaigns/:id/draft", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { campaign, body } = found;
      const problem = documentProblem(body.document);
      if (problem !== null) return invalidDocument(c, problem);
      campaign.draft = body.document as PageDocument;
      campaign.version = nextVersion();
      return c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .post("/campaigns/:id/discard-draft", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { campaign } = found;
      campaign.draft = campaign.published ?? starterDocument(campaign.name);
      campaign.version = nextVersion();
      return c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .post("/campaigns/:id/publish", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { campaign, body } = found;
      if (campaign.ended) {
        return c.json(
          refusal(
            "ended",
            "The campaign has ended.",
            "Create a new campaign to raise again.",
          ),
          409,
        );
      }
      if (campaign.published === null && !("gifts_go_to" in body)) {
        return c.json(
          refusal(
            "gifts_go_to_required",
            "gifts_go_to is missing; a campaign's first publish names where its gifts go.",
            "Send gifts_go_to: a program id, or null for the general fund.",
          ),
          422,
        );
      }
      campaign.published = campaign.draft;
      campaign.live = true;
      campaign.version = nextVersion();
      return c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .post("/campaigns/:id/unpublish", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { campaign } = found;
      if (!campaign.live) {
        return c.json(
          refusal("not_live", "The campaign is not live.", "Nothing to do."),
          409,
        );
      }
      campaign.live = false;
      campaign.version = nextVersion();
      return c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .post("/campaigns/:id/end", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { campaign } = found;
      if (!campaign.live) {
        return c.json(
          refusal(
            "not_live",
            "Only a live campaign can end.",
            "Publish it first, or delete it if it never went live.",
          ),
          409,
        );
      }
      campaign.live = false;
      campaign.ended = true;
      campaign.version = nextVersion();
      return c.json(campaignView(campaign, new URL(c.req.url).origin), 200);
    })
    .delete("/campaigns/:id", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { campaign } = found;
      if (campaign.published !== null) {
        return c.json(
          refusal(
            "was_published",
            "The campaign has been published, so it can't be deleted.",
            "End or unpublish it instead.",
          ),
          409,
        );
      }
      campaigns.delete(campaign.id);
      return c.body(null, 204);
    })
    .get("/donation-page", (c) =>
      c.json(donationPageView(new URL(c.req.url).origin), 200),
    )
    .put("/donation-page/draft", async (c) => {
      const body = await bodyOf(c);
      if (body.version !== donationPage.version) return stale(c);
      const problem = documentProblem(body.document);
      if (problem !== null) return invalidDocument(c, problem);
      donationPage.draft = body.document as PageDocument;
      donationPage.version = nextVersion();
      return c.json(donationPageView(new URL(c.req.url).origin), 200);
    })
    .post("/donation-page/publish", async (c) => {
      const body = await bodyOf(c);
      if (body.version !== donationPage.version) return stale(c);
      donationPage.published = donationPage.draft;
      donationPage.version = nextVersion();
      return c.json(donationPageView(new URL(c.req.url).origin), 200);
    })
    .post("/donation-page/reset", async (c) => {
      const body = await bodyOf(c);
      if (body.version !== donationPage.version) return stale(c);
      donationPage.draft = donationPage.published;
      donationPage.version = nextVersion();
      return c.json(donationPageView(new URL(c.req.url).origin), 200);
    })
    .get("/page-catalog", (c) =>
      c.json(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["blocks"],
          properties: {
            name: { type: "string" },
            blocks: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "type"],
                properties: {
                  id: { type: "string" },
                  type: {
                    enum: [
                      "title",
                      "story",
                      "impact-tiers",
                      "faq",
                      "about-us",
                      "org-info",
                      "share",
                      "hero",
                      "image",
                      "goal-bar",
                      "program-chooser",
                      "donation-box",
                    ],
                  },
                },
              },
            },
          },
        },
        200,
      ),
    )
    .post("/photo-links", async (c) => {
      const { target, page_id, block_id } = await bodyOf(c);
      if (typeof block_id !== "string") {
        return c.json(
          refusal(
            "invalid_block_id",
            "block_id is missing.",
            "Send the id of an image or hero block in the page's draft.",
          ),
          422,
        );
      }
      if (target === "campaign") {
        if (typeof page_id !== "string") {
          return c.json(
            refusal(
              "invalid_page_id",
              "page_id is missing; a campaign photo link names the campaign.",
              "Send the campaign's id as page_id.",
            ),
            422,
          );
        }
        if (!campaigns.has(page_id)) return notFound(c, page_id);
      } else if (target !== "donation_page") {
        return c.json(
          refusal(
            "invalid_target",
            "target is not campaign or donation_page.",
            "Send campaign or donation_page.",
          ),
          422,
        );
      }
      return c.json(
        {
          url: `${new URL(c.req.url).origin}/connector/photo/${randomBytes(16).toString("base64url")}`,
          expires_at: new Date(
            Date.now() + PHOTO_LINK_LIFETIME_MS,
          ).toISOString(),
        },
        200,
      );
    });
}
