import { Page, Placeholder } from "./page";

// The draft in the directory packet, with two changes the code forces:
// retention figures are the ones the service actually enforces, and the
// "not stored" / always-revoked lines are placeholders where the code does
// not make the stronger claim true.
export function PrivacyPage() {
	return (
		<Page
			heading="Privacy Policy"
			title="Privacy Policy — Better Giving Connector"
		>
			<p class="meta">
				Effective date: <Placeholder value="[EFFECTIVE DATE]" />
				<br />
				Last updated: <Placeholder value="[EFFECTIVE DATE]" />
			</p>
			<p class="note">
				Text highlighted in yellow is a placeholder. It is not a decided term.
			</p>
			<p>
				This Privacy Policy explains how{" "}
				<Placeholder value="[LEGAL ENTITY NAME]" /> ("we", "us") handles
				personal data in the Better Giving Connector (the "Connector"),
				available at https://app.connect.better.giving. The Connector is a Model
				Context Protocol (MCP) server that lets an operator of a self-hosted
				Better Giving site manage that site from an AI chat app such as Claude
				(Anthropic) or ChatGPT (OpenAI).
			</p>

			<h2>1. Who we are and how to contact us</h2>
			<p>
				<Placeholder value="[LEGAL ENTITY NAME]" />,{" "}
				<Placeholder value="[POSTAL ADDRESS]" />. Contact:{" "}
				<Placeholder value="[SUPPORT EMAIL]" />.
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
							<th>Category</th>
							<th>Examples</th>
							<th>Source</th>
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
								at rest with AES-256-GCM.
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

			<h3>2.2 Data relayed to your site</h3>
			<p>
				When you ask the AI app to do something, tool requests and results — for
				example campaigns, forms, donation records, and donor names, email
				addresses and donation amounts — travel between the chat app and{" "}
				<strong>your own Better Giving site</strong>. The Connector relays this
				data to complete the request. It does not write tool requests or tool
				results into its database.
			</p>
			<p>
				<Placeholder value="[HOSTING LOG RETENTION OF REQUEST BODIES]" />{" "}
				Hosting request logs are a separate copy. This policy does not state
				that those logs exclude relayed donor data, because this service does
				not set what the host keeps.
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
				<Placeholder value="[LAWFUL BASIS — confirm with counsel if EU/UK users are in scope: account and relay processing on performance of a contract (GDPR Art. 6(1)(b)); security logging on legitimate interests (Art. 6(1)(f)).]" />
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
							<th>Recipient</th>
							<th>Role</th>
							<th>Location</th>
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
					<strong>Refresh tokens:</strong> expire after 90 days without use. A
					chat app that keeps refreshing receives a new token and the 90 days
					start again.
				</li>
				<li>
					<strong>Sessions:</strong> up to 1 year. When the year ends, the
					connection ends even if a refresh token has time left.
				</li>
				<li>
					<strong>Connections that are no longer usable:</strong> a daily
					automatic process deletes a connection whose session has ended, or
					whose refresh token and access token are both expired. A sign-in that
					never finished is deleted by that same process after an hour. The
					process asks your site to revoke the connection key.
				</li>
				<li>
					<strong>Disconnected connections:</strong> deleted when the chat app
					disconnects the Connector or revokes its refresh token. The Connector
					then asks your Better Giving site to revoke the connection key. If
					that request does not reach the site, the stored connection is still
					deleted.{" "}
					<Placeholder value="[KEY LIFETIME ON THE SITE WHEN REVOKE DOES NOT ARRIVE]" />
				</li>
				<li>
					<strong>Hosting request logs:</strong>{" "}
					<Placeholder value="[VERCEL LOG RETENTION PERIOD]" />.
				</li>
				<li>
					<strong>Application logs:</strong>{" "}
					<Placeholder value="[APPLICATION LOG RETENTION PERIOD]" />.
				</li>
				<li>
					<strong>Relayed tool requests and results:</strong> not written to the
					Connector's database.{" "}
					<Placeholder value="[HOSTING LOG RETENTION OF REQUEST BODIES]" />
				</li>
			</ul>

			<h2>6. Your controls and rights</h2>
			<ul>
				<li>
					<strong>Disconnect</strong> the Connector in Claude or ChatGPT. This
					deletes the stored connection and asks your site to revoke the key.{" "}
					<Placeholder value="[DISCONNECT FROM THE BETTER GIVING DASHBOARD]" />
				</li>
				<li>
					<strong>Request deletion or access</strong> by emailing{" "}
					<Placeholder value="[SUPPORT EMAIL]" />. We respond within{" "}
					<Placeholder value="[30]" /> days.
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
				HTTPS; logs exclude keys and content. No system is perfectly secure.
				Report vulnerabilities to <Placeholder value="[SECURITY EMAIL]" />.
			</p>

			<h2>8. International transfers</h2>
			<p>
				We store data in the United States. If you are outside the US, your data
				is transferred there.{" "}
				<Placeholder value="[TRANSFER MECHANISM, e.g. Standard Contractual Clauses — confirm with counsel if EU/UK users are in scope.]" />
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
				material changes we will give notice{" "}
				<Placeholder value="[by email or in the dashboard]" /> before they take
				effect.
			</p>

			<h2>11. Contact</h2>
			<p>
				<Placeholder value="[LEGAL ENTITY NAME]" /> ·{" "}
				<Placeholder value="[POSTAL ADDRESS]" /> ·{" "}
				<Placeholder value="[SUPPORT EMAIL]" />
			</p>
		</Page>
	);
}
