import { raw } from "hono/html";
import type { Child } from "hono/jsx";

// No design system exists yet (sheet: `screens`), so the look is this sheet:
// system font, one column, made for a 375 px phone.
const STYLE = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:18px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#fff}
main{max-width:30rem;margin:0 auto;padding:2.5rem 1rem}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .75rem}
p{margin:0 0 1.5rem}
label{display:block;font-weight:600;margin-bottom:.4rem}
input{display:block;width:100%;font:inherit;padding:.75rem;border:2px solid #767676;border-radius:.5rem}
input[aria-invalid=true]{border-color:#b00020}
.hint{color:#555;font-size:.9rem;margin:.5rem 0 0}
.error{color:#b00020;margin:.5rem 0 0}
button{display:block;width:100%;margin-top:1.5rem;font:inherit;font-weight:600;padding:.9rem;border:2px solid #1d4ed8;border-radius:.5rem;color:#fff;background:#1d4ed8}
button:disabled{opacity:.7}
.secondary{margin-top:.75rem;color:#1d4ed8;background:transparent}
:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#121212}.hint{color:#bbb}input{color:inherit;background:#1e1e1e;border-color:#8a8a8a}input[aria-invalid=true],.error{color:#ff8a80;border-color:#ff8a80}button{background:#3b82f6;border-color:#3b82f6}.secondary{color:#93c5fd;background:transparent}}
`;

function Page({ heading, children }: { heading: string; children: Child }) {
	return (
		<>
			{raw("<!doctype html>")}
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>{heading}</title>
					<style>{STYLE}</style>
				</head>
				<body>
					<main>
						<h1>{heading}</h1>
						{children}
					</main>
				</body>
			</html>
		</>
	);
}

// hello can take seconds; the button says so and refuses a second press. A
// page restored from the back-forward cache gets its button back.
const PENDING = `
var form = document.getElementById("address-form");
var button = document.getElementById("continue");
form.addEventListener("submit", function () {
	button.disabled = true;
	button.textContent = "Checking your address…";
});
addEventListener("pageshow", function () {
	button.disabled = false;
	button.textContent = "Continue";
});
`;

const ERROR_ID = "address-error";
const HINT_ID = "address-hint";

/**
 * The address form. `action` is the request's own path and query: the signed
 * login request rides in it from GET to POST.
 */
export function AddressPage(props: {
	action: string;
	/** Where Cancel posts. */
	cancel: string;
	value?: string;
	error?: string;
}) {
	const { action, cancel, value, error } = props;
	const invalid = error !== undefined;
	return (
		<Page heading="Connect Better Giving">
			<p>
				Type your Better Giving site's address. You'll sign in to your dashboard
				there and press Allow.
			</p>
			<form id="address-form" method="post" action={action}>
				<label for="address">Your Better Giving site address</label>
				<input
					id="address"
					name="address"
					type="text"
					inputmode="url"
					autocomplete="url"
					autocapitalize="none"
					spellcheck={false}
					required
					placeholder="give.yourcharity.org"
					value={value}
					autofocus={invalid}
					aria-invalid={invalid ? "true" : undefined}
					aria-describedby={invalid ? `${ERROR_ID} ${HINT_ID}` : HINT_ID}
				/>
				{invalid && (
					<p id={ERROR_ID} class="error">
						{error}
					</p>
				)}
				<p id={HINT_ID} class="hint">
					The address of your donation page or Better Giving dashboard, like
					give.yourcharity.org.
				</p>
				<button id="continue" type="submit">
					Continue
				</button>
			</form>
			<script dangerouslySetInnerHTML={{ __html: PENDING }} />
			<WayOut action={cancel} label="Cancel" />
		</Page>
	);
}

/**
 * A dead end with one thing to do, said in `message`. `back` is where "Back
 * to the chat" posts, given only while the login request still verifies.
 */
export function MessagePage(props: {
	heading: string;
	message: string;
	back?: string;
}) {
	return (
		<Page heading={props.heading}>
			<p role="alert">{props.message}</p>
			{props.back !== undefined && (
				<WayOut action={props.back} label="Back to the chat" />
			)}
		</Page>
	);
}

// Ends the chat app's request as declined.
function WayOut(props: { action: string; label: string }) {
	return (
		<form method="post" action={props.action}>
			<button type="submit" class="secondary">
				{props.label}
			</button>
		</form>
	);
}
