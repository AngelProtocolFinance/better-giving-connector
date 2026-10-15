import { Page } from "./page";

export function DocsPage() {
	return (
		<Page
			heading="Documentation"
			title="Documentation — Better Giving Connector"
		>
			<img
				class="mark"
				src="/icon.svg"
				width={64}
				height={64}
				alt="Better Giving logo"
			/>
			<p>
				The Better Giving Connector is an MCP server that lets an operator of a
				self-hosted Better Giving site manage that site from Claude or ChatGPT.
			</p>

			<h2>Demo</h2>
			<p>
				A short recording of an MCP test client: connecting to a Better Giving
				site, then listing campaigns, reading fundraising results, creating a
				draft campaign, recording an offline gift, and listing donors. It also
				shows three requests the connector refuses.
			</p>
			<p>
				<a href="/demo.mp4">Demo recording</a>
			</p>
			<video controls preload="metadata" src="/demo.mp4" width={640}>
				<track
					default
					kind="captions"
					src="/demo.vtt"
					srcLang="en"
					label="English"
				/>
				<a href="/demo.mp4">Demo recording</a>
			</video>

			<h2>Address</h2>
			<p>
				Server URL:{" "}
				<a href="https://app.connect.better.giving/mcp">
					https://app.connect.better.giving/mcp
				</a>
			</p>

			<h2>Before you connect</h2>
			<p>You need both of these:</p>
			<ul>
				<li>
					A Better Giving standalone site that speaks connector contract version
					1. An older release answers that Better Giving needs an update.
				</li>
				<li>A dashboard account on that site.</li>
			</ul>

			<h2>Connect</h2>
			<ol>
				<li>
					In Claude or ChatGPT, add the connector at the server URL above.
				</li>
				<li>
					When this site opens, type your Better Giving site's address. Use the
					donation page or the dashboard address, not your organization's main
					website.
				</li>
				<li>Sign in on your site's dashboard and press Allow.</li>
				<li>You return to the chat app, connected to that one site.</li>
			</ol>

			<h2>What it can do</h2>
			<ul>
				<li>List and read campaigns, and create a draft campaign.</li>
				<li>Edit a campaign's page and its goal, end date, and share text.</li>
				<li>
					Publish, unpublish, or end a campaign. These change what donors see.
					The connector tells the chat app to confirm with you first.
				</li>
				<li>
					Read and edit the main donation page, or put it back to the starting
					page. Resetting it discards the current blocks and is also meant to be
					confirmed first.
				</li>
				<li>List, read, create, and edit donation forms.</li>
				<li>
					Read fundraising totals, donations, donors, and monthly gifts. Monthly
					gifts cannot be changed from here.
				</li>
				<li>
					Record a donation that was already received offline (cash, check, bank
					transfer, or other). This writes a record on your site. It moves no
					money, charges no card, and issues no refund.
				</li>
				<li>
					Make a short-lived, single-use link so you can add a photo from your
					phone. The connector does not upload the file itself.
				</li>
			</ul>

			<h2>What it cannot do</h2>
			<p>
				It cannot charge a card, refund a gift, or pay out funds. It acts only
				on the site you connected. It does not accept or return your site's
				connection key.
			</p>

			<h2>Disconnect</h2>
			<p>
				Disconnect the connector in Claude or ChatGPT. That deletes the
				connection stored here and asks your site to revoke the key. If a tool
				says the site has moved or no longer accepts the connection, connect
				again and type the current address.
			</p>

			<h2>More</h2>
			<ul>
				<li>
					<a href="/support">Support</a>
				</li>
				<li>
					<a href="/privacy">Privacy policy</a>
				</li>
				<li>
					<a href="/terms">Terms of service</a>
				</li>
				<li>
					<a href="https://better.giving">better.giving</a>
				</li>
			</ul>
		</Page>
	);
}
