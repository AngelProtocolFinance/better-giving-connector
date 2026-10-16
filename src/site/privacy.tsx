import {
	ACCESS_TOKEN_EXPIRES_IN,
	lifetimeLabel,
	RATE_LIMIT_RETENTION,
	REFRESH_TOKEN_EXPIRES_IN,
	REFRESH_TOKEN_REUSE_INTERVAL,
	SESSION_EXPIRES_IN,
} from "../auth/token-lifetimes";
import { EFFECTIVE_DATE } from "./effective-date";
import { Page } from "./page";

// Entity, address, emails, the GDPR section, and the CCPA line are proposed
// and waiting on Justin. Token lifetimes come from src/auth/token-lifetimes.ts.
// The effective date is the build stamp in src/site/effective-date.ts.
export function PrivacyPage() {
	return (
		<Page
			heading="Privacy Policy"
			title="Privacy Policy — Better Giving Connector"
		>
			<p class="meta">
				Effective date: {EFFECTIVE_DATE}
				<br />
				Last updated: {EFFECTIVE_DATE}
			</p>
			<p>
				This Privacy Policy explains how Better Giving, Inc. ("we", "us")
				handles personal data in the Better Giving Connector (the "Connector"),
				available at https://app.connect.better.giving. The Connector is a Model
				Context Protocol (MCP) server that lets an operator of a self-hosted
				Better Giving site manage that site from an AI chat app such as Claude
				(Anthropic) or ChatGPT (OpenAI).
			</p>

			<h2>1. Who we are and how to contact us</h2>
			<p>
				Better Giving, Inc., 18 Cottekill Rd, Rosendale, NY 12472. Contact:
				support@better.giving.
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
							<td>
								A random ID and a placeholder email address at
								@connection.invalid. The stored account name is the constant
								"Better Giving connection". No name or email address is
								collected.
							</td>
							<td>Created when you connect a site</td>
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
								at rest with AES-256-GCM, under a key held in our hosting
								provider's production environment, separate from the database.
							</td>
							<td>Your Better Giving site</td>
						</tr>
						<tr>
							<td>OAuth client records</td>
							<td>
								Client ID, name, redirect URLs, optional contacts, logo, policy
								URLs, and metadata supplied by the app developer, and an
								encrypted client secret. Contacts may include the developer's
								email.
							</td>
							<td>The chat app</td>
						</tr>
						<tr>
							<td>Rate-limit counters</td>
							<td>
								A counter whose key is the client IP address and the endpoint.
								An IPv6 address is stored as its /64. When a client IP address
								is not available, that endpoint has one shared counter.
							</td>
							<td>The request</td>
						</tr>
						<tr>
							<td>Sessions and tokens</td>
							<td>
								A session record for each connection. Access tokens and refresh
								tokens are stored as one-way (SHA-256) hashes, not the tokens
								themselves. To handle a retried refresh, the latest token
								response is also kept encrypted. It can be used only for{" "}
								{REFRESH_TOKEN_REUSE_INTERVAL} seconds, and the daily sweep
								deletes it within a day after that.
							</td>
							<td>Generated when you connect</td>
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
				data to complete the request. Tool requests and results are held in
				memory only while a request runs. They are not written to our database
				or logs.
			</p>

			<h3>2.3 Logs</h3>
			<ul>
				<li>
					<strong>Application logs:</strong> the tool name, the outcome, and how
					long the call took; the connect step and its outcome; how many
					connections a sweep removed and how long that took; and, for an error,
					where it happened and the error's name. They do not include tool
					arguments, tool results, tokens, or keys.
				</li>
				<li>
					<strong>Hosting request logs:</strong> Our hosting provider keeps
					request logs, including the request path, the approximate region from
					your IP address, and your browser or client type.
				</li>
				<li>
					Logs are kept for a limited period set by our hosting provider, then
					deleted. We don't send these logs to any other service.
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
				<li>To detect abuse and diagnose errors (logs).</li>
			</ul>
			<p>
				We do <strong>not</strong> sell or share personal data for advertising,
				we do not use it for profiling or automated decisions with legal or
				similar effects, and we do not use it to train AI models.
			</p>
			<p>
				We do not sell personal information, and we do not share it for
				cross-context behavioral advertising, as those terms are used in the
				California Consumer Privacy Act.
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
				Your Better Giving site receives the connection key with each request.
				It also receives tool requests, and disconnect and revoke calls.
			</p>
			<p>
				We do not use analytics or telemetry. The Connector's code is{" "}
				<a href="https://github.com/AngelProtocolFinance/better-giving-connector">
					open source
				</a>
				.
			</p>
			<p>
				We may also disclose data where required by law or to protect rights and
				safety, and to a successor in a merger or acquisition, subject to this
				policy.
			</p>

			<h2>5. How long we keep it (retention)</h2>
			<ul>
				<li>
					<strong>Connection key:</strong> the Connector stores its own
					encrypted copy of each connection key. It deletes that copy when you
					disconnect, when the chat app revokes the refresh token, when the
					refresh token expires, or when the session ends. It asks your site to
					revoke the key, and still deletes its copy if that request fails.
				</li>
				<li>
					The Better Giving Standalone site you connect to revokes a connection
					key after 90 days without use, and deletes revoked keys 30 days later.
				</li>
				<li>
					<strong>Access and refresh tokens</strong> are stored as one-way
					(SHA-256) hashes, not the tokens themselves. To handle a retried
					refresh, the latest token response is also kept encrypted. It can be
					used only for {REFRESH_TOKEN_REUSE_INTERVAL} seconds, and the daily
					sweep deletes it within a day after that. A refresh token expires
					after {lifetimeLabel(REFRESH_TOKEN_EXPIRES_IN)} without use. A chat
					app that keeps refreshing receives a new token and the{" "}
					{lifetimeLabel(REFRESH_TOKEN_EXPIRES_IN)} start again. An access token
					expires after {lifetimeLabel(ACCESS_TOKEN_EXPIRES_IN)}.
				</li>
				<li>
					A server-side session record for each connection, with no IP address
					or browser details. The session token is stored as the token itself. A
					session lasts up to {lifetimeLabel(SESSION_EXPIRES_IN)}. When the year
					ends, the connection ends even if a refresh token has time left.
				</li>
				<li>
					OAuth client registrations store a client ID, a name, redirect URLs,
					optional contacts, a logo, policy URLs, and metadata supplied by the
					app developer, and an encrypted client secret. Contacts may include
					the developer's email. They are kept while the app remains registered;
					contact us to have one removed.
				</li>
				<li>
					A consent record of which app was authorized, and which scopes, is
					deleted with the connection.
				</li>
				<li>
					Authorization codes are single-use, stored as one-way (SHA-256)
					hashes, not the codes themselves, and expire within minutes. The row
					holds the authorization request details, not the code, until the code
					is used or it expires.
				</li>
				<li>
					A rate-limit counter whose key is the client IP address and the
					endpoint. An IPv6 address is stored as its /64. When a client IP
					address is not available, that endpoint has one shared counter. A
					counter is deleted when its last request is more than{" "}
					{lifetimeLabel(RATE_LIMIT_RETENTION)} old.
				</li>
				<li>
					A sign-in that is not finished is deleted by the daily sweep once it
					is more than 1 hour old.
				</li>
				<li>
					<strong>Logs:</strong> logs are kept for a limited period set by our
					hosting provider, then deleted. We don't send these logs to any other
					service.
				</li>
			</ul>

			<h2>6. Your controls and rights</h2>
			<ul>
				<li>
					<strong>Disconnect</strong> the Connector in Claude or ChatGPT, or
					revoke its refresh token. This deletes the encrypted connection key
					and the OAuth tokens stored here, and asks your site to revoke the
					key.
				</li>
				<li>
					<strong>Request deletion or access</strong> by emailing
					support@better.giving. We respond within 30 days.
				</li>
				<li>
					Depending on where you live, you may have rights to access, correct,
					delete, or port your data, object to or restrict processing, and
					complain to your local data protection authority.
				</li>
			</ul>

			<h2>7. Security</h2>
			<p>
				Connection keys are encrypted at rest with AES-256-GCM, under a key held
				in our hosting provider's production environment, separate from the
				database. Traffic uses HTTPS. Logs do not include keys or request
				content. No system is perfectly secure. Report vulnerabilities to
				security@better.giving.
			</p>

			<h2>8. International transfers</h2>
			<p>
				We process data in the United States. Where EU or UK law requires it, we
				rely on the European Commission's Standard Contractual Clauses and the
				UK Addendum.
			</p>

			<h2>9. GDPR</h2>
			<p>
				If you are in the European Economic Area or the United Kingdom, you can
				ask for access to, correction of, or deletion of the operator account
				and connection data we store, and you can object to or ask us to
				restrict that processing, or ask for a copy of it. Email
				support@better.giving. You can also complain to your local data
				protection authority. We process that account and connection data to
				provide the Connector (GDPR Article 6(1)(b)) and we process security
				logs to protect the service (Article 6(1)(f)). Donor data that passes
				through the Connector is controlled by the nonprofit.
			</p>

			<h2>10. Children</h2>
			<p>
				The Connector is for nonprofit operators who are at least 18. It is not
				directed to children, and we do not knowingly collect their data.
			</p>

			<h2>11. Changes</h2>
			<p>
				We will post updates here and change the "Last updated" date. For
				material changes we will give notice by email to the nonprofit's account
				administrator and by posting the updated page, at least 7 days before
				the change takes effect.
			</p>

			<h2>12. Contact</h2>
			<p>
				Better Giving, Inc. · 18 Cottekill Rd, Rosendale, NY 12472 ·
				support@better.giving
			</p>
		</Page>
	);
}
