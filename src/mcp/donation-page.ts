import { z } from "zod";
import { forwarding } from "./forward.ts";
import {
  NEEDS_A_YES,
  pageDocument,
  READ,
  versionFromLastRead,
  WRITE,
} from "./page-tool.ts";

const donationPageVersion = versionFromLastRead(
  "donation page",
  "get_donation_page",
);

/** "Donation page: changed, https://…" */
function donationPageLine(body: Record<string, unknown> | null): string {
  const { editor_state, url } = body ?? {};
  return `Donation page: ${String(editor_state)}, ${String(url)}`;
}

export const getDonationPage = forwarding({
  name: "get_donation_page",
  title: "Read the donation page",
  description:
    "Reads the operator's main donation page: its address, its editor_state (live, or changed when the draft holds unpublished changes), its draft and published page documents, and the version every change to it must send.",
  revision: 1,
  annotations: READ,
  input: z.object({}),
  request: () => ({ method: "GET", path: "/donation-page" }),
  summary: donationPageLine,
});

export const editDonationPage = forwarding({
  name: "edit_donation_page",
  title: "Edit the donation page",
  description:
    "Replaces the donation page's draft with a whole new page document. Donors see none of it until publish_donation_page. Start from the draft get_donation_page answers and change what the operator asked for.",
  revision: 1,
  annotations: WRITE,
  input: z.object({ version: donationPageVersion, document: pageDocument }),
  request: (body) => ({ method: "PUT", path: "/donation-page/draft", body }),
  summary: donationPageLine,
});

export const publishDonationPage = forwarding({
  name: "publish_donation_page",
  title: "Publish the donation page",
  description:
    "Ask the operator “Publish these changes to your donation page? Donors will see them right away.” and call only after they say yes. Puts the donation page's draft live.",
  revision: 1,
  annotations: NEEDS_A_YES,
  input: z.object({ version: donationPageVersion }),
  request: (body) => ({ method: "POST", path: "/donation-page/publish", body }),
  summary: donationPageLine,
});

export const resetDonationPage = forwarding({
  name: "reset_donation_page",
  title: "Reset the donation page",
  description:
    "Ask the operator “Reset your donation page's draft? The changes you haven't published will be lost.” and call only after they say yes. Resets the donation page's draft.",
  revision: 1,
  annotations: NEEDS_A_YES,
  input: z.object({ version: donationPageVersion }),
  request: (body) => ({ method: "POST", path: "/donation-page/reset", body }),
  summary: donationPageLine,
});
