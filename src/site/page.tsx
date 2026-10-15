import { raw } from "hono/html";
import type { Child } from "hono/jsx";

// Same sheet as the connect flow: system font, one column, a 375 px phone.
// Legal pages are a little wider so a table can sit in the column.
const STYLE = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:18px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#fff}
main{max-width:40rem;margin:0 auto;padding:2.5rem 1rem 4rem}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .75rem}
h2{font-size:1.2rem;line-height:1.3;margin:2rem 0 .5rem}
h3{font-size:1.05rem;line-height:1.3;margin:1.5rem 0 .4rem}
p,ul,ol{margin:0 0 1rem}
ul,ol{padding-left:1.25rem}
a{color:#1d4ed8}
nav{display:flex;flex-wrap:wrap;gap:.75rem 1rem;margin:0 0 1.5rem;font-size:.95rem}
nav a{font-weight:600}
.meta{color:#555;font-size:.95rem}
.table-wrap{overflow-x:auto;margin:0 0 1rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{border:1px solid #ccc;padding:.45rem .55rem;text-align:left;vertical-align:top}
th{background:#f6f6f6}
img.mark{display:block;width:4rem;height:4rem;margin:0 0 1rem}
:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
@media (prefers-color-scheme:dark){
body{color:#f2f2f2;background:#121212}
a{color:#93c5fd}
.meta{color:#bbb}
th,td{border-color:#444}
th{background:#1e1e1e;color:#f2f2f2}
:focus-visible{outline-color:#93c5fd}
}
`;

export function Page({
	heading,
	title = heading,
	children,
}: {
	heading: string;
	title?: string;
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
						<nav>
							<a href="/docs">Docs</a>
							<a href="/support">Support</a>
							<a href="/privacy">Privacy</a>
							<a href="/terms">Terms</a>
						</nav>
						<h1>{heading}</h1>
						{children}
					</main>
				</body>
			</html>
		</>
	);
}
