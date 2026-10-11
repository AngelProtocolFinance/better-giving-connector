import { z } from "zod";
import { forwarding } from "./forward.ts";
import { cursor, listLine, withQuery } from "./list-tool.ts";
import {
  NEEDS_A_YES,
  pathId,
  READ,
  versionFromLastRead,
  WRITE,
} from "./page-tool.ts";

const formId = pathId.describe(
  "The form's id (frm_…), from list_forms or create_form.",
);

const formVersion = versionFromLastRead("form", "get_form or list_forms");

const amountMinor = z.number().int().positive();

/** The fields create_form sends and edit_form may change. */
const formFields = {
  name: z
    .string()
    .min(1)
    .describe("The form's name, as the operator sees it in the dashboard."),
  suggested_amounts_minor: z
    .array(amountMinor)
    .describe(
      "The amounts the form offers the donor, in minor units: cents, so 2500 is $25.00. Show the operator dollars.",
    ),
  min_minor: amountMinor
    .nullable()
    .describe(
      "The smallest gift the form takes, in minor units: cents, so 500 is $5.00; null for no minimum. Show the operator dollars.",
    ),
  max_minor: amountMinor
    .nullable()
    .describe(
      "The largest gift the form takes, in minor units: cents, so 100000 is $1,000.00; null for no maximum. Show the operator dollars.",
    ),
  program_mode: z
    .enum(["none", "pinned", "choice"])
    .describe(
      "Where the form's gifts go: none for the general fund, pinned for the one program in program_id, choice for the program the donor picks.",
    ),
  program_id: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "The program pinned gifts go to, from list_programs; null for none.",
    ),
  allowed_origins: z
    .array(z.url())
    .describe(
      "The websites allowed to embed the form, each as an origin like https://hopeshelter.org.",
    ),
};

/** "Coat drive: live" */
function formLine(body: Record<string, unknown> | null): string {
  const { name, status } = body ?? {};
  return `${String(name)}: ${String(status)}`;
}

function formPath(id: string): `/${string}` {
  return `/forms/${encodeURIComponent(id)}`;
}

export const listForms = forwarding({
  name: "list_forms",
  title: "List forms",
  description:
    "Lists the operator's donation forms: each one's id, name, status (draft, live or archived), amounts, embed_url and version. A form with owned_by_page_id set belongs to a page and changes only with that page.",
  annotations: READ,
  input: z.object({ cursor }),
  request: (query) => ({ method: "GET", path: withQuery("/forms", query) }),
  summary: (body) =>
    listLine(
      body,
      ["form", "forms"],
      ({ name, status }) => `${String(name)} (${String(status)})`,
    ),
});

export const getForm = forwarding({
  name: "get_form",
  title: "Read a form",
  description:
    "Reads one donation form: its name, status (draft, live or archived), suggested amounts and limits in minor units (cents; show the operator dollars), where its gifts go, the websites allowed to embed it, its embed_url, and the version every change to it must send.",
  annotations: READ,
  input: z.object({ form_id: formId }),
  request: ({ form_id }) => ({ method: "GET", path: formPath(form_id) }),
  summary: formLine,
});

export const createForm = forwarding({
  name: "create_form",
  title: "Create a form",
  description:
    "Creates a donation form the operator can embed on their own website with its embed_url. Answers the form with its id, embed_url and version.",
  annotations: WRITE,
  input: z.object({
    name: formFields.name,
    suggested_amounts_minor: formFields.suggested_amounts_minor.optional(),
    min_minor: formFields.min_minor.optional(),
    max_minor: formFields.max_minor.optional(),
    program_mode: formFields.program_mode.optional(),
    program_id: formFields.program_id.optional(),
    allowed_origins: formFields.allowed_origins.optional(),
  }),
  request: (body) => ({ method: "POST", path: "/forms", body }),
  summary: formLine,
});

export const editForm = forwarding({
  name: "edit_form",
  title: "Edit a form",
  description:
    "Ask the operator “Change this form? The change reaches every website it's embedded on at once.” and call only after they say yes. Changes a donation form's settings: send only the fields to change. A form with owned_by_page_id set belongs to a page and can't be changed here; edit that page instead.",
  annotations: NEEDS_A_YES,
  input: z.object({
    form_id: formId,
    version: formVersion,
    ...z.object(formFields).partial().shape,
  }),
  request: ({ form_id, ...body }) => ({
    method: "PATCH",
    path: formPath(form_id),
    body,
  }),
  summary: formLine,
});

export const archiveForm = forwarding({
  name: "archive_form",
  title: "Archive a form",
  description:
    "Ask the operator “Archive this form? It will stop taking gifts wherever it's embedded.” and call only after they say yes. Archives a form: every website it's embedded on stops taking gifts through it.",
  annotations: NEEDS_A_YES,
  input: z.object({ form_id: formId, version: formVersion }),
  request: ({ form_id, version }) => ({
    method: "POST",
    path: `${formPath(form_id)}/archive`,
    body: { version },
  }),
  summary: formLine,
});

export const listPrograms = forwarding({
  name: "list_programs",
  title: "List programs",
  description:
    "Lists the operator's programs: each one's id, name, description and status. A program id goes into a form's program_id, a campaign's gifts_go_to, or a recorded gift's program_id.",
  annotations: READ,
  input: z.object({ cursor }),
  request: (query) => ({ method: "GET", path: withQuery("/programs", query) }),
  summary: (body) =>
    listLine(body, ["program", "programs"], ({ name }) => String(name)),
});
