import { Document, PRODUCTION_ORIGIN } from "./document";

export function DocsPage() {
	return (
		<Document title="Better Giving Connector" current="docs">
			<p>
				The Better Giving Connector lets an operator of a self-hosted Better
				Giving donation site manage that site from Claude or ChatGPT. The chat
				app talks to one MCP server. During connect, you choose which Better
				Giving site it acts on.
			</p>
			<p>
				Server URL:{" "}
				<a href={`${PRODUCTION_ORIGIN}/mcp`}>{PRODUCTION_ORIGIN}/mcp</a>
			</p>

			<h2>What you need</h2>
			<ul>
				<li>
					A Better Giving standalone site that speaks connector contract v1.
				</li>
				<li>A dashboard account on that site, for the person connecting it.</li>
			</ul>

			<h2>Connect</h2>
			<ol>
				<li>
					In Claude or ChatGPT, add the connector at the server URL above.
				</li>
				<li>Press Connect. The chat app sends you to this service.</li>
				<li>Enter your Better Giving site's address.</li>
				<li>Sign in on that site's dashboard and press Allow.</li>
				<li>You return to the chat app, connected to that one site.</li>
			</ol>
			<p>
				Each connection acts only on the site you allowed. It cannot reach a
				different nonprofit's site.
			</p>

			<h2>What you can do</h2>
			<ul>
				<li>
					Campaigns: list and read them, create a draft, edit the page and
					settings, publish, unpublish, or end.
				</li>
				<li>
					Donation page: read it, replace its blocks, or put it back to the
					starting page.
				</li>
				<li>Donation forms: list, read, create, and edit.</li>
				<li>
					Look up fundraising totals, donations, donors, and monthly gifts.
					Monthly gifts can be read here and cannot be changed here.
				</li>
				<li>
					Record an offline donation (cash, check, bank transfer, or other) that
					was already received outside the site. This writes a record in US
					dollars. It moves no money.
				</li>
				<li>
					Make a short-lived link the operator opens to add a photo. The
					connector does not upload the file.
				</li>
			</ul>
			<p>
				Publishing, unpublishing, ending a campaign, replacing page blocks, and
				resetting the donation page change what donors see, and they take effect
				when they run. Confirm those changes in the chat before they run.
			</p>

			<h2>What it does not do</h2>
			<p>
				The connector does not charge a card, take a payment, move funds, issue
				a refund, or pay anyone out. <code>record_donation</code> only records a
				gift that was already received off the site.
			</p>

			<h2>Icon</h2>
			<p>
				A placeholder icon, not the Better Giving logo, is served at{" "}
				<a href="/icon.svg">/icon.svg</a> and{" "}
				<a href="/icon-512.png">/icon-512.png</a> (512×512 PNG).
			</p>

			<h2>More</h2>
			<ul>
				<li>
					<a href="/support">Support</a>
				</li>
				<li>
					<a href="/privacy">Privacy Policy</a>
				</li>
				<li>
					<a href="/terms">Terms of Service</a>
				</li>
			</ul>
		</Document>
	);
}
