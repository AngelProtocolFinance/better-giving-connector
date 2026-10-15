import { PRODUCTION_ORIGIN } from "./document";
import { ICON_PNG } from "./icon";
import { type ZipEntry, zipStore } from "./zip";

const LONG_DESCRIPTION = [
	"Connect ChatGPT to a self-hosted Better Giving donation site. List and edit campaigns, build donation forms, update the donation page, look up donations, donors, and monthly gifts, see fundraising results, and record offline donations.",
	"Publishing, unpublishing, ending a campaign, replacing page blocks, and resetting the donation page change what donors see and take effect when they run.",
	"Requires a Better Giving standalone site that speaks the connector, and a dashboard account on that site.",
	"The connector does not process payments, move funds, charge cards, or issue refunds. record_donation only records a gift that was already received off the site.",
].join(" ");

/**
 * The ChatGPT app package described for directory upload.
 * Undecided listing fields (author email, license, category, brand color,
 * countries, demo recording) are omitted rather than filled with a guess.
 */
export function chatGptPackageEntries(): ZipEntry[] {
	const plugin = {
		$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
		name: "better-giving",
		version: "1.0.0",
		description: LONG_DESCRIPTION,
		author: {
			name: "Better Giving",
			url: "https://better.giving",
		},
		homepage: "https://better.giving",
		repository:
			"https://github.com/AngelProtocolFinance/better-giving-connector",
		keywords: ["nonprofit", "donations", "fundraising"],
		extensions: {
			"com.openai": {
				interface: {
					displayName: "Better Giving",
					shortDescription: "Run your donation site",
					longDescription: LONG_DESCRIPTION,
					developerName: "Better Giving",
					capabilities: [
						"Manage campaigns",
						"Manage donation forms",
						"Review donations and donors",
						"Record offline donations",
					],
					websiteURL: "https://better.giving",
					supportURL: `${PRODUCTION_ORIGIN}/support`,
					privacyPolicyURL: `${PRODUCTION_ORIGIN}/privacy`,
					termsOfServiceURL: `${PRODUCTION_ORIGIN}/terms`,
					defaultPrompt: [
						"List my published campaigns.",
						"How much did we raise this month?",
						"Create a draft campaign for our winter appeal.",
					],
					composerIcon: "./assets/icon.png",
					logo: "./assets/logo.png",
				},
				review: {
					test_cases: {
						positive: [
							{
								description: "List campaigns",
								prompt: "List my campaigns",
								tools_triggered: "list_campaigns",
								expected_behavior:
									"Calls list_campaigns and returns the connected site's campaigns with status and public link.",
							},
							{
								description: "Campaign fundraising total",
								prompt: "How much has the Winter Appeal raised?",
								tools_triggered: "list_campaigns, get_results",
								expected_behavior:
									"Finds the Winter Appeal with list_campaigns and returns its totals from get_results.",
							},
							{
								description: "Recent donations",
								prompt: "Show the last 10 donations",
								tools_triggered: "list_donations",
								expected_behavior:
									"Calls list_donations and returns the latest gifts on the connected site.",
							},
							{
								description: "Create a draft campaign",
								prompt: "Create a draft campaign called Spring Drive",
								tools_triggered: "create_campaign",
								expected_behavior:
									"Calls create_campaign and returns the new draft, which donors cannot see until it is published.",
							},
							{
								description: "Record an offline donation",
								prompt: "Record a $50 cash donation from Jane Doe today",
								tools_triggered: "record_donation",
								expected_behavior:
									"Calls record_donation and confirms the offline gift was recorded. No money moves.",
							},
						],
						negative: [
							{
								description: "No refund tool",
								prompt: "Refund Jane's donation",
							},
							{
								description: "Publish waits for confirmation",
								prompt: "Publish the Spring Drive campaign",
							},
							{
								description: "Only the connected site",
								prompt: "Show donations for a different nonprofit",
							},
						],
					},
					commerce: false,
					commerce_description:
						"Does not sell goods or process payments; record_donation logs an offline gift.",
				},
				publication: {
					release_notes: "Initial release.",
				},
			},
		},
	};
	const mcp = {
		$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
		mcpServers: {
			"better-giving": {
				type: "streamable-http",
				url: `${PRODUCTION_ORIGIN}/mcp`,
				extensions: {
					"com.openai": {
						auth: {
							type: "oauth",
							client: { mode: "dcr" },
							baseScopes: ["offline_access"],
						},
					},
				},
			},
		},
	};
	const json = (value: unknown) =>
		new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
	return [
		{ name: "plugin.json", data: json(plugin) },
		{ name: "mcp.json", data: json(mcp) },
		{ name: "assets/logo.png", data: ICON_PNG },
		{ name: "assets/icon.png", data: ICON_PNG },
	];
}

export function chatGptPackageZip(): Buffer {
	return zipStore(chatGptPackageEntries());
}
