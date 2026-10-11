import { type Context, Hono } from "hono";
import { bodyOf, keysetPage, refusal, versionClock } from "./common.ts";

/**
 * A deployment's forms and programs (docs/connector-v1.md → Forms, programs, catalog), in memory:
 * versioned forms, one of them owned by the donation page and so read-only here.
 */

interface StoredForm {
  id: string;
  name: string;
  status: "draft" | "live" | "archived";
  suggested_amounts_minor: number[];
  min_minor: number | null;
  max_minor: number | null;
  program_mode: "none" | "pinned" | "choice";
  program_id: string | null;
  allowed_origins: string[];
  owned_by_page_id: string | null;
  version: string;
}

/** The fields a create or an edit may send, each applied as sent. */
const FORM_FIELDS = [
  "name",
  "suggested_amounts_minor",
  "min_minor",
  "max_minor",
  "program_mode",
  "program_id",
  "allowed_origins",
] as const;

const PROGRAM_MODES = new Set(["none", "pinned", "choice"]);

const PROGRAMS = [
  {
    id: "prg_meals",
    name: "Hot meals",
    description: "A hot meal every night.",
    status: "active",
  },
  {
    id: "prg_beds",
    name: "Shelter beds",
    description: "A safe bed for the night.",
    status: "active",
  },
];

/** What a create or edit body fails, naming the field; null when it passes the fake's rules. */
function formProblem(body: Record<string, unknown>): string | null {
  if ("name" in body && (typeof body.name !== "string" || body.name === "")) {
    return "name is empty.";
  }
  if (
    "program_mode" in body &&
    !PROGRAM_MODES.has(body.program_mode as string)
  ) {
    return "program_mode is not none, pinned or choice.";
  }
  return null;
}

export function fakeForms() {
  const nextVersion = versionClock();
  const forms = new Map<string, StoredForm>();
  const donationPageForm: StoredForm = {
    id: "frm_donation_page",
    name: "Donation page",
    status: "live",
    suggested_amounts_minor: [2500, 5000, 10000],
    min_minor: 500,
    max_minor: null,
    program_mode: "none",
    program_id: null,
    allowed_origins: [],
    owned_by_page_id: "donation_page",
    version: nextVersion(),
  };
  forms.set(donationPageForm.id, donationPageForm);

  function formView(form: StoredForm, origin: string) {
    return {
      ...form,
      currency: "USD",
      embed_url: `${origin}/embed/${form.id}`,
    };
  }

  const invalid = (c: Context, message: string) =>
    c.json(
      refusal("invalid_form", message, "Fix that field and send it again."),
      422,
    );

  /** The form `:id` names when this surface may change it at the body's `version`; else the refusal. */
  async function writable(c: Context) {
    const id = c.req.param("id") ?? "";
    const form = forms.get(id);
    if (form === undefined) {
      return {
        refused: c.json(
          refusal(
            "not_found",
            `No form has the id ${id}.`,
            "List the forms to get its id.",
          ),
          404,
        ),
      } as const;
    }
    if (form.owned_by_page_id !== null) {
      return {
        refused: c.json(
          refusal(
            "owned_by_page",
            "This form belongs to a page, so it changes only with that page.",
            "Edit the page's donation box instead.",
          ),
          409,
        ),
      } as const;
    }
    const body = await bodyOf(c);
    if (body.version !== form.version) {
      return {
        refused: c.json(
          refusal(
            "stale",
            "The form changed since it was read.",
            "Read it again, then make the change.",
          ),
          409,
        ),
      } as const;
    }
    return { form, body } as const;
  }

  return new Hono()
    .get("/forms", (c) => {
      const { origin } = new URL(c.req.url);
      return keysetPage(
        c,
        [...forms.values()].map((form) => formView(form, origin)),
      );
    })
    .post("/forms", async (c) => {
      const body = await bodyOf(c);
      if (typeof body.name !== "string") return invalid(c, "name is missing.");
      const problem = formProblem(body);
      if (problem !== null) return invalid(c, problem);
      const form: StoredForm = {
        id: `frm_${crypto.randomUUID().slice(0, 12)}`,
        name: body.name,
        status: "live",
        suggested_amounts_minor: [],
        min_minor: null,
        max_minor: null,
        program_mode: "none",
        program_id: null,
        allowed_origins: [],
        owned_by_page_id: null,
        version: nextVersion(),
      };
      Object.assign(form, pick(body));
      forms.set(form.id, form);
      return c.json(formView(form, new URL(c.req.url).origin), 201);
    })
    .get("/forms/:id", (c) => {
      const form = forms.get(c.req.param("id"));
      return form === undefined
        ? c.json(
            refusal(
              "not_found",
              `No form has the id ${c.req.param("id")}.`,
              "List the forms to get its id.",
            ),
            404,
          )
        : c.json(formView(form, new URL(c.req.url).origin), 200);
    })
    .patch("/forms/:id", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { form, body } = found;
      const problem = formProblem(body);
      if (problem !== null) return invalid(c, problem);
      Object.assign(form, pick(body));
      form.version = nextVersion();
      return c.json(formView(form, new URL(c.req.url).origin), 200);
    })
    .post("/forms/:id/archive", async (c) => {
      const found = await writable(c);
      if ("refused" in found) return found.refused;
      const { form } = found;
      form.status = "archived";
      form.version = nextVersion();
      return c.json(formView(form, new URL(c.req.url).origin), 200);
    })
    .get("/programs", (c) => keysetPage(c, PROGRAMS));
}

/** The form fields `body` sends. */
function pick(body: Record<string, unknown>): Partial<StoredForm> {
  return Object.fromEntries(
    FORM_FIELDS.filter((field) => field in body).map((field) => [
      field,
      body[field],
    ]),
  );
}
