import { Page, Placeholder } from "./page";

export function SupportPage() {
	return (
		<Page heading="Support" title="Support — Better Giving Connector">
			<p class="note">
				Text highlighted in yellow is a placeholder. It is not a decided term.
			</p>
			<p>Contact: support@better.giving.</p>
			<p>
				To ask for access to or deletion of connector data, use the address
				above. The <a href="/privacy">privacy policy</a> describes what the
				connector stores. Response time: <Placeholder value="[30]" /> days.
			</p>
			<p>Report a vulnerability to security@better.giving.</p>

			<h2>Connecting</h2>
			<ol>
				<li>
					Add the connector in Claude or ChatGPT at{" "}
					<a href="https://app.connect.better.giving/mcp">
						https://app.connect.better.giving/mcp
					</a>
					.
				</li>
				<li>
					Type your Better Giving site's address. Use the donation page or the
					dashboard, not your organization's main website.
				</li>
				<li>Sign in on that site and press Allow.</li>
			</ol>
			<p>
				If the page says the connection request timed out, or that connecting
				didn't finish, go back to the chat app and press Connect again. If the
				address didn't answer, check it. If Better Giving at that address needs
				an update, install the latest release and try again.
			</p>

			<h2>Disconnect</h2>
			<p>
				Disconnect Better Giving in the chat app's connector settings. That
				deletes the connection stored here and asks your site to revoke the key.
				If a tool tells you to reconnect, the site refused the key or moved:
				connect again and type the current address.
			</p>

			<h2>Money</h2>
			<p>
				The connector does not move money. It cannot refund a donation, charge a
				card, or pay out funds. Recording a donation only writes down a gift
				that was already received offline.
			</p>

			<h2>More</h2>
			<ul>
				<li>
					<a href="/docs">Documentation</a>
				</li>
				<li>
					<a href="/privacy">Privacy policy</a>
				</li>
				<li>
					<a href="/terms">Terms of service</a>
				</li>
			</ul>
		</Page>
	);
}
