import { html } from "hono/html";
import { type Child, jsx as h } from "hono/jsx";

// `jsx()` calls rather than JSX syntax: `node src/dev.ts` strips types but can't load a .tsx file

/** The address box's error, by the note's E codes. */
export type AddressError =
  | "required"
  | "not_an_address"
  | "email"
  | "no_such_host"
  | "no_answer"
  | "not_better_giving"
  | "outdated";

const ADDRESS_ERRORS: Record<AddressError, string> = {
  required: "required",
  not_an_address: "not a web address — type it like give.yourcharity.org",
  email: "that's an email address — type your donation page address",
  no_such_host: "no site at this address — check the spelling",
  no_answer: "the site didn't answer — try again in a minute",
  not_better_giving:
    "not a Better Giving site — use the address donors give on, not your main website",
  outdated:
    "needs a newer Better Giving — update Better Giving, then start again from the chat app",
};

const CONNECT_AGAIN = "Go back to the chat app and press Connect again.";

const STYLE = `
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;font:1.0625rem/1.5 system-ui,sans-serif;color:CanvasText;background:Canvas}
main{max-width:34rem;margin:0 auto;padding:2.5rem 1rem 3rem}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 1rem}
p{margin:0 0 1rem}
label{display:block;font-weight:600;margin-top:1.5rem}
.hint{margin:.25rem 0 .5rem;font-size:.9375rem;opacity:.85}
input{display:block;width:100%;font:inherit;padding:.625rem .75rem;border:2px solid currentColor;border-radius:.375rem;color:inherit;background:Field}
input[aria-invalid=true]{border-color:#c62828}
.error{margin:.5rem 0 0;color:#c62828;font-weight:600}
@media (prefers-color-scheme:dark){input[aria-invalid=true]{border-color:#ff8a80}.error{color:#ff8a80}}
button{display:block;width:100%;margin-top:1.5rem;font:inherit;font-weight:600;padding:.75rem 1rem;border:0;border-radius:.375rem;color:#fff;background:#1a56db;cursor:pointer}
.after{margin-top:.5rem;font-size:.9375rem}
.privacy{margin-top:2.5rem;font-size:.9375rem;opacity:.85}
a{color:LinkText}
:focus-visible{outline:3px solid #1a56db;outline-offset:2px}
`;

/** The whole document around `body`; `nonce` lets its one inline stylesheet past the CSP. */
function document(title: string, nonce: string, ...body: Child[]) {
  return html`<!doctype html>${h(
    "html",
    { lang: "en" },
    h(
      "head",
      null,
      h("meta", { charset: "utf-8" }),
      h("meta", {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      }),
      h("title", null, title),
      h("style", { nonce }, STYLE),
    ),
    h("body", null, h("main", null, ...body)),
  )}`;
}

export interface AddressPageProps {
  /** the action the form posts to: `/connect` with the signed query */
  action: string;
  /** what the operator typed, kept on an error */
  typed?: string;
  error?: AddressError;
}

/** §1 and §2: the address form, first shown or with an error under the box. */
export function addressPage(
  nonce: string,
  { action, typed = "", error }: AddressPageProps,
) {
  const invalid = error !== undefined;
  return document(
    invalid
      ? "Check the address · Connect Better Giving"
      : "Connect Better Giving",
    nonce,
    h("h1", null, "Connect Better Giving"),
    h(
      "p",
      null,
      "Once connected, the chat can make, edit and publish your campaigns, and read your results and donors.",
    ),
    h(
      "form",
      { method: "post", action, novalidate: true },
      h("label", { for: "address" }, "Donation page address"),
      h(
        "p",
        { id: "address-hint", class: "hint" },
        "The address donors use to give, like give.yourcharity.org. A link to any page on it works.",
      ),
      h("input", {
        id: "address",
        type: "text",
        name: "address",
        value: typed,
        inputmode: "url",
        autocomplete: "url",
        autocapitalize: "none",
        autocorrect: "off",
        spellcheck: "false",
        enterkeyhint: "go",
        "aria-describedby": invalid
          ? "address-hint address-error"
          : "address-hint",
        ...(invalid ? { "aria-invalid": "true", autofocus: true } : {}),
      }),
      invalid
        ? h("p", { id: "address-error", class: "error" }, ADDRESS_ERRORS[error])
        : null,
      h("button", { type: "submit" }, "Continue to your dashboard"),
      h(
        "p",
        { class: "after" },
        "You'll sign in there if you need to, then press Allow.",
      ),
    ),
    h(
      "p",
      { class: "privacy" },
      "Better Giving's connector keeps only your donation page address and an encrypted key to it. It never stores donor data. Disconnect anytime from your dashboard.",
    ),
  );
}

/** §3: a page that ends the attempt — one heading, what happened, what to do next. */
function finalPage(
  nonce: string,
  title: string,
  heading: string,
  ...body: Child[]
) {
  return document(title, nonce, h("h1", null, heading), ...body);
}

/** S0: `/connect` reached other than from a chat app's Connect. */
export function startFromChatAppPage(nonce: string) {
  return finalPage(
    nonce,
    "Connect Better Giving",
    "Start from your chat app",
    h(
      "p",
      null,
      "In Claude or ChatGPT, add Better Giving from the connectors and press Connect. This page opens from there.",
    ),
  );
}

/** R1: the operator pressed Cancel; `allowUrl` while the attempt can still finish. */
export function cancelledPage(nonce: string, allowUrl?: string) {
  return finalPage(
    nonce,
    "Not connected · Better Giving",
    "Not connected",
    h(
      "p",
      null,
      "You pressed Cancel on your dashboard, so the chat app isn't connected.",
    ),
    ...(allowUrl === undefined
      ? [h("p", null, CONNECT_AGAIN)]
      : [
          h("p", null, "Pressed Cancel by mistake?"),
          h("p", null, h("a", { href: allowUrl }, "Go back to Allow")),
          h("p", null, "Or go back to the chat app and press Connect again."),
        ]),
  );
}

/** R2: the deployment's answer couldn't be tied to an attempt or redeemed. */
export function unconfirmedPage(nonce: string) {
  return finalPage(
    nonce,
    "Couldn't connect · Better Giving",
    "Couldn't connect",
    h(
      "p",
      null,
      "Your dashboard's answer couldn't be confirmed, so the chat app isn't connected.",
    ),
    h("p", null, CONNECT_AGAIN),
  );
}

/** R3: the chat app's authorization ran out first. */
export function expiredPage(nonce: string) {
  return finalPage(
    nonce,
    "Time ran out · Better Giving",
    "Time ran out",
    h(
      "p",
      null,
      "Connecting has to finish within 10 minutes of pressing Connect, so the chat app isn't connected.",
    ),
    h("p", null, CONNECT_AGAIN),
  );
}

/** R4: a failure on this side, or the deployment not answering the exchange. */
export function failedPage(nonce: string, cause: "ours" | "deployment") {
  return finalPage(
    nonce,
    "Something went wrong · Better Giving",
    "Something went wrong",
    h(
      "p",
      null,
      cause === "deployment"
        ? "Your donation page didn't answer while connecting, so the chat app isn't connected."
        : "Connecting failed on our side, so the chat app isn't connected.",
    ),
    h("p", null, CONNECT_AGAIN),
  );
}
