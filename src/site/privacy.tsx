import { Document, Ph, PRODUCTION_ORIGIN } from "./document";
import { PLACEHOLDERS as P } from "./placeholders";

export function PrivacyPage() {
	return (
		<Document title="Privacy Policy" current="privacy">
			<p class="note">
				Highlighted text is a placeholder. It is not a final statement.
			</p>
			<p>
				<strong>Effective date:</strong> <Ph>{P.effectiveDate}</Ph>
				<br />
				<strong>Last updated:</strong> <Ph>{P.effectiveDate}</Ph>
			</p>
			<p>
				This Privacy Policy explains how <Ph>{P.entity}</Ph> ("we", "us")
				handles personal data in the Better Giving Connector (the "Connector"),
				available at {PRODUCTION_ORIGIN}. The Connector is a Model Context
				Protocol (MCP) server that lets an operator of a self-hosted Better
				Giving site manage that site from an AI chat app such as Claude
				(Anthropic) or ChatGPT (OpenAI).
			</p>

			<h2>1. Who we are and how to contact us</h2>
			<p>
				<Ph>{P.entity}</Ph>, <Ph>{P.address}</Ph>. Contact:{" "}
				<Ph>{P.supportEmail}</Ph>.
			</p>
			<p>
				<strong>Our role.</strong>
			</p>
			<ul>
				<li>
					For the operator's account and connection data (Section 2.1), we are
					the <strong>controller</strong>.
				</li>
				<li>
					For data about a nonprofit's donors, supporters and campaigns that
					passes through the Connector (Section 2.2), the{" "}
					<strong>nonprofit operator is the controller</strong> and we act only
					as its <strong>processor / service provider</strong>, processing it
					solely on the operator's instructions to carry out the requested
					action. Donors who want to exercise rights over their data should
					contact the nonprofit that holds it.
				</li>
			</ul>

			<h2>2. Data we process</h2>
			<h3>2.1 Data we store</h3>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">Category</th>
							<th scope="col">Examples</th>
							<th scope="col">Source</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>Operator account identifier</td>
							<td>Operator user ID</td>
							<td>Your sign-in</td>
						</tr>
						<tr>
							<td>Connected site details</td>
							<td>Site origin (URL) and organization name</td>
							<td>You, when you connect a site</td>
						</tr>
						<tr>
							<td>Site connection key</td>
							<td>
								Credential that lets the Connector act on your site. Encrypted
								at rest (AES-256-GCM).
							</td>
							<td>Your Better Giving site</td>
						</tr>
						<tr>
							<td>OAuth client records</td>
							<td>Client registrations created by Claude or ChatGPT</td>
							<td>The chat app</td>
						</tr>
						<tr>
							<td>Sessions and tokens</td>
							<td>Session records, access tokens, refresh tokens</td>
							<td>Generated at sign-in</td>
						</tr>
					</tbody>
				</table>
			</div>

			<h3>2.2 Data passed through</h3>
			<p>
				When you ask the chat app to do something, tool requests and results —
				for example campaigns, forms, donation records, and donor names, email
				addresses and donation amounts — travel between the chat app and{" "}
				<strong>your own Better Giving site</strong>. The Connector relays this
				data to complete the request. It does not write tool requests or results
				to its database or its application logs.
			</p>
			<p>
				<Ph>{P.passThroughRetention}</Ph> Hosting request logs are described in
				Section 2.3. This policy does not state that pass-through data is absent
				from those logs.
			</p>

			<h3>2.3 Logs</h3>
			<ul>
				<li>
					<strong>Application logs:</strong> event type, tool name, outcome and
					error name only. They do not include connection keys, tool arguments
					or message content.
				</li>
				<li>
					<strong>Hosting request logs:</strong> our hosting provider records
					standard request data such as IP address and timestamps.
				</li>
			</ul>

			<h3>2.4 What we do not collect</h3>
			<p>
				We do not collect payment card data, and the Connector does not move
				money. We do not knowingly collect government identifiers or health
				information. We do not read your chat history; we only receive what the
				chat app sends to a tool.
			</p>

			<h2>3. Why we use it (purposes)</h2>
			<ul>
				<li>To authenticate you and keep you signed in.</li>
				<li>
					To relay your requests to your Better Giving site and return the
					results.
				</li>
				<li>
					To keep the service secure, detect abuse, and diagnose errors (logs).
				</li>
			</ul>
			<p>
				<Ph>{P.lawfulBasis}</Ph>
			</p>
			<p>
				We do <strong>not</strong> sell or share personal data for advertising,
				we do not use it for profiling or automated decisions with legal or
				similar effects, and we do not use it to train AI models.
			</p>

			<h2>4. Who receives it (recipients)</h2>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">Recipient</th>
							<th scope="col">Role</th>
							<th scope="col">Location</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>Vercel Inc.</td>
							<td>Hosting and request logs</td>
							<td>United States (iad1)</td>
						</tr>
						<tr>
							<td>Turso / ChiselStrike</td>
							<td>Database</td>
							<td>AWS us-east-1, United States</td>
						</tr>
						<tr>
							<td>Cloudflare</td>
							<td>DNS only (no access to Connector data)</td>
							<td>—</td>
						</tr>
						<tr>
							<td>Your Better Giving site</td>
							<td>Destination of your requests</td>
							<td>Wherever you host it</td>
						</tr>
						<tr>
							<td>Anthropic or OpenAI</td>
							<td>The chat app you chose to connect</td>
							<td>Governed by their own privacy policies</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p>
				We may also disclose data where required by law or to protect rights and
				safety, and to a successor in a merger or acquisition, subject to this
				policy.
			</p>

			<h2>5. How long we keep it (retention)</h2>
			<ul>
				<li>
					<strong>Refresh tokens:</strong> expire 90 days after they are issued.
					Refreshing replaces the token, so a chat app that keeps refreshing
					stays within this limit.
				</li>
				<li>
					<strong>Sessions:</strong> the connection session lasts 365 days.
					After that, the chat app has to connect again.
				</li>
				<li>
					<strong>Connections that can no longer be used:</strong> a daily job
					deletes a connection whose session has ended, or that has no unexpired
					refresh token and no unexpired access token. A sign-in that never
					finishes is deleted after one hour.
				</li>
				<li>
					<strong>Disconnect:</strong> disconnecting in Claude or ChatGPT
					deletes the stored connection. The Connector asks your Better Giving
					site to revoke the connection key. If the site cannot be reached, the
					stored connection is still deleted.{" "}
					<Ph>{P.keyRevocationUnreachable}</Ph>
				</li>
				<li>
					<strong>Hosting request logs:</strong> <Ph>{P.vercelLogRetention}</Ph>
					.
				</li>
				<li>
					<strong>Application logs:</strong>{" "}
					<Ph>{P.applicationLogRetention}</Ph>.
				</li>
				<li>
					<strong>Tool requests and results:</strong> not written to the
					Connector's database or application logs.{" "}
					<Ph>{P.passThroughRetention}</Ph>
				</li>
			</ul>

			<h2>6. Your controls and rights</h2>
			<ul>
				<li>
					<strong>Disconnect</strong> the Connector in Claude or ChatGPT. This
					deletes the stored connection. <Ph>{P.dashboardDisconnect}</Ph>
				</li>
				<li>
					<strong>Request deletion or access</strong> by emailing{" "}
					<Ph>{P.supportEmail}</Ph>. We respond within{" "}
					<Ph>{P.responseDeadline}</Ph>.
				</li>
				<li>
					Depending on where you live, you may have rights to access, correct,
					delete, or port your data, object to or restrict processing, and
					complain to your local data protection authority.
				</li>
			</ul>

			<h2>7. Security</h2>
			<p>
				Connection keys are encrypted at rest with AES-256-GCM; traffic uses
				HTTPS; application logs exclude keys and content. No system is perfectly
				secure. Report vulnerabilities to <Ph>{P.securityEmail}</Ph>.
			</p>

			<h2>8. International transfers</h2>
			<p>
				We store data in the United States. If you are outside the US, your data
				is transferred there. <Ph>{P.transfer}</Ph>
			</p>

			<h2>9. Children</h2>
			<p>
				The Connector is for nonprofit operators and is not directed to children
				under 13 (or the higher age required locally). We do not knowingly
				collect their data.
			</p>

			<h2>10. Changes</h2>
			<p>
				We will post updates here and change the "Last updated" date. For
				material changes we will give notice <Ph>{P.noticeMethod}</Ph> before
				they take effect.
			</p>

			<h2>11. Contact</h2>
			<p>
				<Ph>{P.entity}</Ph> · <Ph>{P.address}</Ph> · <Ph>{P.supportEmail}</Ph>
			</p>
		</Document>
	);
}
