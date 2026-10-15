import { Document, Ph } from "./document";
import { PLACEHOLDERS as P } from "./placeholders";

export function SupportPage() {
	return (
		<Document title="Support" current="support">
			<p class="note">
				Highlighted text is a placeholder. It is not a final statement.
			</p>
			<p>
				For help with the Better Giving Connector, email{" "}
				<Ph>{P.supportEmail}</Ph>.
			</p>
			<p>
				Report a security vulnerability to <Ph>{P.securityEmail}</Ph>.
			</p>

			<h2>Disconnect</h2>
			<p>
				Disconnect the Connector in Claude or ChatGPT. This service then deletes
				the stored connection and asks your Better Giving site to revoke the
				connection key. If the site cannot be reached, the stored connection is
				still deleted. <Ph>{P.keyRevocationUnreachable}</Ph>
			</p>
			<p>
				<Ph>{P.dashboardDisconnect}</Ph>
			</p>

			<h2>Money</h2>
			<p>
				The connector cannot refund a gift, charge a card, or move funds.
				Recording a donation only writes a record of a gift already received
				outside the site. Questions about a charge belong with the nonprofit's
				own payment setup, not with this connector.
			</p>

			<h2>More</h2>
			<ul>
				<li>
					<a href="/docs">Documentation</a>
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
