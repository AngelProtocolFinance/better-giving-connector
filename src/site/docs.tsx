import { Page } from "./page";

export function DocsPage() {
	return (
		<Page
			heading="Documentation"
			title="Documentation: Better Giving Connector"
		>
			<img
				class="mark"
				src="/icon.svg"
				width={64}
				height={64}
				alt="Better Giving logo"
			/>
			<p>
				The Better Giving Connector lets a nonprofit manage its Better Giving
				account from your AI assistant. Sign in at better.giving, or connect
				your own Better Giving site's address.
			</p>

			<h2>Demo</h2>
			<p>
				A short recording of an MCP test client: connecting a Better Giving
				account, then listing campaigns, reading fundraising results, creating a
				draft campaign, recording a cash gift, and listing donors. It also shows
				three requests the connector refuses.
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
					A Better Giving account. Sign in at better.giving, or use your own
					Better Giving site's address. An older site that does not speak this
					connector cannot connect yet.
				</li>
				<li>Permission to manage that account.</li>
			</ul>

			<h2>Connect</h2>
			<ol>
				<li>
					In your AI assistant, add the connector at the server URL above.
				</li>
				<li>
					When this site opens, continue with better.giving, or type your own
					Better Giving site's address. Use that address, not your
					organization's main website.
				</li>
				<li>Sign in to your Better Giving account and press Allow.</li>
				<li>You return to your AI assistant, connected to that one account.</li>
			</ol>

			<h2>What it can do</h2>
			<ul>
				<li>
					List and read campaigns, and create a draft campaign. Donors cannot
					see a draft until it is published. For the amount raised, use
					fundraising results.
				</li>
				<li>
					Edit a campaign's page, and set its goal, end date, time zone, or the
					message and channels shown when it is shared.
				</li>
				<li>
					Publish, unpublish, or end a campaign. These change what donors see.
					Your AI assistant says what will change and waits for your explicit
					yes. The first time a campaign is published, it asks where the gifts
					go: a program, or the general fund.
				</li>
				<li>
					Read and edit the main donation page, or put it back to the starting
					page. Resetting discards the current blocks. Your AI assistant waits
					for your explicit yes before it resets the page.
				</li>
				<li>
					List, read, create, and edit donation forms, including the donation
					page's form and each campaign's form. On a live form, a change donors
					would see waits for your yes.
				</li>
				<li>
					Read fundraising totals, donations, donors, and monthly gifts. Monthly
					gifts cannot be changed from here.
				</li>
				<li>
					Record a donation already received in cash or by check. It is not tied
					to a campaign. This writes a record. It moves no money, charges no
					card, and issues no refund. The same details again match the earlier
					gift and record nothing new. Add a distinguishing note to record a
					second gift with the same details.
				</li>
				<li>
					Make a short-lived, single-use link so you can add a photo from your
					phone. The connector does not upload the file itself.
				</li>
			</ul>

			<h2>What it cannot do</h2>
			<p>
				It cannot charge a card, refund a gift, or pay out funds. It acts only
				on the account you connected. It does not accept or return the
				connection key.
			</p>

			<h2>Disconnect</h2>
			<p>
				Disconnect the connector in your AI assistant. That deletes the
				connection stored here and asks that account to revoke the key. If a
				tool says the account has moved or no longer accepts the connection,
				connect again and type the current address.
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
