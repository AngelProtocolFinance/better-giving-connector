import { raw } from "hono/html";
import type { Child } from "hono/jsx";

/** Production origin of this service. Mail-only `connect.better.giving` is not it. */
export const PRODUCTION_ORIGIN = "https://app.connect.better.giving";

const STYLE = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:18px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#fff}
main{max-width:40rem;margin:0 auto;padding:2rem 1rem 3rem}
nav{display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;margin:0 0 1.5rem;font-size:.95rem}
nav a{color:#1d4ed8}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .75rem}
h2{font-size:1.2rem;line-height:1.3;margin:1.75rem 0 .5rem}
h3{font-size:1.05rem;line-height:1.3;margin:1.25rem 0 .4rem}
p,ul,ol{margin:0 0 1rem}
ul,ol{padding-left:1.25rem}
a{color:#1d4ed8}
.note{color:#555;font-size:.95rem}
.placeholder{background:#fff3bf;color:#1a1a1a;padding:0 .2em;border-radius:.2em}
.table-wrap{overflow-x:auto;margin:0 0 1rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{border:1px solid #c8c8c8;padding:.45rem .55rem;text-align:left;vertical-align:top}
th{background:#f6f6f6}
:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
@media (prefers-color-scheme:dark){
body{color:#f2f2f2;background:#121212}
nav a,a{color:#93c5fd}
.note{color:#bbb}
.placeholder{background:#fff3bf;color:#1a1a1a}
th{background:#1e1e1e}
th,td{border-color:#555}
:focus-visible{outline-color:#93c5fd}
}
`;

export function Ph({ children }: { children: string }) {
	return <span class="placeholder">{children}</span>;
}

export function Document({
	title,
	current,
	children,
}: {
	title: string;
	current: "docs" | "support" | "privacy" | "terms";
	children: Child;
}) {
	return (
		<>
			{raw("<!doctype html>")}
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>{title}</title>
					<style dangerouslySetInnerHTML={{ __html: STYLE }} />
				</head>
				<body>
					<main>
						<nav aria-label="Pages">
							<NavLink href="/docs" current={current === "docs"}>
								Docs
							</NavLink>
							<NavLink href="/support" current={current === "support"}>
								Support
							</NavLink>
							<NavLink href="/privacy" current={current === "privacy"}>
								Privacy
							</NavLink>
							<NavLink href="/terms" current={current === "terms"}>
								Terms
							</NavLink>
						</nav>
						<h1>{title}</h1>
						{children}
					</main>
				</body>
			</html>
		</>
	);
}

function NavLink({
	href,
	current,
	children,
}: {
	href: string;
	current: boolean;
	children: string;
}) {
	return (
		<a href={href} aria-current={current ? "page" : undefined}>
			{children}
		</a>
	);
}
