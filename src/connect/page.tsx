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
.error{color:#b00020;margin:.5rem 0 0}
button{display:block;width:100%;margin-top:1.5rem;font:inherit;font-weight:600;padding:.9rem;border:0;border-radius:.5rem;color:#fff;background:#1d4ed8}
:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#121212}input{color:inherit;background:#1e1e1e;border-color:#8a8a8a}input[aria-invalid=true],.error{color:#ff8a80;border-color:#ff8a80}button{background:#3b82f6}}
`;

function Page({ children }: { children: Child }) {
	return (
		<>
			{raw("<!doctype html>")}
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>Connect Better Giving</title>
					<style>{STYLE}</style>
				</head>
				<body>
					<main>
						<h1>Connect Better Giving</h1>
						{children}
					</main>
				</body>
			</html>
		</>
	);
}

const ERROR_ID = "address-error";

/**
 * The address form. `action` is the request's own path and query: the signed
 * login request rides in it from GET to POST.
 */
export function AddressPage(props: {
	action: string;
	value?: string;
	error?: string;
}) {
	const { action, value, error } = props;
	return (
		<Page>
			<p>
				Type your donation page's address. You'll sign in to your Better Giving
				dashboard there and press Allow.
			</p>
			<form method="post" action={action}>
				<label for="address">Donation page address</label>
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
					autofocus={error !== undefined}
					aria-invalid={error !== undefined ? "true" : undefined}
					aria-describedby={error !== undefined ? ERROR_ID : undefined}
				/>
				{error !== undefined && (
					<p id={ERROR_ID} class="error">
						{error}
					</p>
				)}
				<button type="submit">Continue</button>
			</form>
		</Page>
	);
}

/** A dead end with one thing to do, said in `message`. */
export function MessagePage({ message }: { message: string }) {
	return (
		<Page>
			<p role="alert">{message}</p>
		</Page>
	);
}
