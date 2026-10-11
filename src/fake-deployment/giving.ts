import { type Context, Hono } from "hono";
import { bodyOf, keysetPage, refusal } from "./common.ts";

/**
 * A deployment's donors, gifts, recurring gifts and results (docs/connector-v1.md → Reads and
 * Writes outside pages), in memory, seeded with three donors who each gave once and one of them
 * monthly.
 */

interface Donor {
  id: string;
  name: string;
  email: string | null;
  kind: string;
  created_at: string;
}

interface Gift {
  id: string;
  donor_id: string;
  amount_minor: number;
  currency: string;
  dated: string;
  method: string;
  program_id: string | null;
  form_id: string | null;
  note: string | null;
  created_at: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function seeded() {
  const donor = (
    id: string,
    name: string,
    email: string | null,
    day: string,
  ): Donor => ({
    id,
    name,
    email,
    kind: "individual",
    created_at: `${day}T12:00:00.000Z`,
  });
  const donors = [
    donor("dnr_ana", "Ana Ruiz", "ana@example.org", "2026-08-15"),
    donor("dnr_ben", "Ben Okafor", "ben@example.org", "2026-09-02"),
    donor("dnr_chen", "Chen Wei", null, "2026-09-20"),
  ];
  const gifts: Gift[] = donors.map(({ id, created_at }, index) => ({
    id: `gft_seed${index + 1}`,
    donor_id: id,
    amount_minor: 5000 * (index + 1),
    currency: "USD",
    dated: created_at.slice(0, 10),
    method: "card",
    program_id: null,
    form_id: "frm_donation_page",
    note: null,
    created_at,
  }));
  const recurring = [
    {
      id: "rcg_ana",
      donor_id: "dnr_ana",
      amount_minor: 2500,
      currency: "USD",
      interval: "month",
      status: "active",
      next_charge_at: "2026-10-15T12:00:00.000Z",
    },
  ];
  return { donors, gifts, recurring };
}

const invalidGift = (c: Context, message: string) =>
  c.json(
    refusal("invalid_gift", message, "Fix that field and send it again."),
    422,
  );

export function fakeGiving() {
  const { donors, gifts, recurring } = seeded();
  /** each recorded gift by the idempotency key it came with */
  const byKey = new Map<string, Gift>();

  /** The donor a gift's `donor` names, created when it's new; else what's wrong with it. */
  function donorFor(donor: unknown): Donor | string {
    const { id, new: fresh } = (donor ?? {}) as { id?: unknown; new?: unknown };
    if (typeof id === "string") {
      return (
        donors.find((known) => known.id === id) ?? `No donor has the id ${id}.`
      );
    }
    const { name, email, kind } = (fresh ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || name === "") {
      return "donor must be { id } or { new: { name } }.";
    }
    const created: Donor = {
      id: `dnr_${crypto.randomUUID().slice(0, 12)}`,
      name,
      email: typeof email === "string" ? email : null,
      kind: typeof kind === "string" ? kind : "individual",
      created_at: new Date().toISOString(),
    };
    donors.push(created);
    return created;
  }

  return new Hono()
    .get("/gifts", (c) => {
      const formId = c.req.query("form_id");
      const since = c.req.query("since");
      return keysetPage(
        c,
        gifts.filter(
          (gift) =>
            (formId === undefined || gift.form_id === formId) &&
            (since === undefined || gift.created_at >= since),
        ),
      );
    })
    .post("/gifts", async (c) => {
      const body = await bodyOf(c);
      const key = body.idempotency_key;
      if (typeof key !== "string" || key === "") {
        return invalidGift(c, "idempotency_key is missing.");
      }
      const first = byKey.get(key);
      if (first !== undefined) return c.json(first, 200);
      const { amount_minor, dated, method } = body;
      if (
        typeof amount_minor !== "number" ||
        !Number.isInteger(amount_minor) ||
        amount_minor < 1
      ) {
        return invalidGift(
          c,
          "amount_minor must be a whole number of minor units above 0.",
        );
      }
      if (typeof dated !== "string" || !DAY.test(dated)) {
        return invalidGift(c, "dated must be a date, YYYY-MM-DD.");
      }
      if (method !== "cash" && method !== "check") {
        return invalidGift(
          c,
          "method must be cash or check; gifts made online are recorded as they arrive.",
        );
      }
      const donor = donorFor(body.donor);
      if (typeof donor === "string") return invalidGift(c, donor);
      const gift: Gift = {
        id: `gft_${crypto.randomUUID().slice(0, 12)}`,
        donor_id: donor.id,
        amount_minor,
        currency: "USD",
        dated,
        method,
        program_id:
          typeof body.program_id === "string" ? body.program_id : null,
        form_id: typeof body.form_id === "string" ? body.form_id : null,
        note: typeof body.note === "string" ? body.note : null,
        created_at: new Date().toISOString(),
      };
      gifts.push(gift);
      byKey.set(key, gift);
      return c.json(gift, 201);
    })
    .get("/recurring-gifts", (c) => keysetPage(c, recurring))
    .get("/results", (c) => {
      const from = c.req.query("from") ?? "";
      const to = c.req.query("to") ?? "";
      if (!DAY.test(from) || !DAY.test(to)) {
        return c.json(
          refusal(
            "invalid_range",
            "from and to must be dates, YYYY-MM-DD.",
            "Send both dates.",
          ),
          422,
        );
      }
      const inRange = gifts.filter(({ dated }) => dated >= from && dated <= to);
      const firstGiftOf = new Map<string, string>();
      for (const { donor_id, dated } of gifts) {
        const first = firstGiftOf.get(donor_id);
        if (first === undefined || dated < first) {
          firstGiftOf.set(donor_id, dated);
        }
      }
      const months = new Map<string, { raised_minor: number; gifts: number }>();
      for (const { dated, amount_minor } of inRange) {
        const month = months.get(dated.slice(0, 7)) ?? {
          raised_minor: 0,
          gifts: 0,
        };
        month.raised_minor += amount_minor;
        month.gifts += 1;
        months.set(dated.slice(0, 7), month);
      }
      return c.json(
        {
          raised_minor: inRange.reduce(
            (sum, gift) => sum + gift.amount_minor,
            0,
          ),
          gifts: inRange.length,
          donors_new: [...firstGiftOf.values()].filter(
            (first) => first >= from && first <= to,
          ).length,
          recurring_active: recurring.filter(
            ({ status }) => status === "active",
          ).length,
          by_month: [...months].map(([month, totals]) => ({
            month,
            ...totals,
          })),
          currency: "USD",
        },
        200,
      );
    })
    .get("/donors", (c) => {
      const q = c.req.query("q")?.toLowerCase();
      return keysetPage(
        c,
        q === undefined
          ? donors
          : donors.filter((donor) =>
              `${donor.name} ${donor.email ?? ""}`.toLowerCase().includes(q),
            ),
      );
    })
    .get("/donors/:id", (c) => {
      const donor = donors.find(({ id }) => id === c.req.param("id"));
      if (donor === undefined) {
        return c.json(
          refusal(
            "not_found",
            `No donor has the id ${c.req.param("id")}.`,
            "List the donors to get their id.",
          ),
          404,
        );
      }
      const given = gifts.filter(({ donor_id }) => donor_id === donor.id);
      return c.json(
        {
          ...donor,
          gifts_count: given.length,
          given_minor: given.reduce((sum, gift) => sum + gift.amount_minor, 0),
          last_gift_at: given.at(-1)?.created_at ?? null,
        },
        200,
      );
    });
}
