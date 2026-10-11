import { McpServer } from "@modelcontextprotocol/server";
import type { AppDeps } from "../app.ts";
import {
  createCampaign,
  deleteCampaign,
  discardCampaignChanges,
  editCampaignPage,
  endCampaign,
  getCampaign,
  listCampaigns,
  publishCampaign,
  renameCampaign,
  unpublishCampaign,
} from "./campaigns.ts";
import { connectionStatus } from "./connection-status.ts";
import {
  editDonationPage,
  getDonationPage,
  publishDonationPage,
  resetDonationPage,
} from "./donation-page.ts";
import { getPageCatalog, getPhotoUploadLink } from "./page-catalog.ts";

/** What a tool acts with: the app's deps, and the connection-user the `/mcp` guard let in. */
export interface ToolScope extends AppDeps {
  userId: string;
}

/** The tools, each registering itself on a request's server: one per `/connector/v1` action, plus `connection_status`. */
const TOOLS: ((server: McpServer, scope: ToolScope) => void)[] = [
  connectionStatus,
  listCampaigns,
  getCampaign,
  createCampaign,
  renameCampaign,
  editCampaignPage,
  discardCampaignChanges,
  publishCampaign,
  unpublishCampaign,
  endCampaign,
  deleteCampaign,
  getDonationPage,
  editDonationPage,
  publishDonationPage,
  resetDonationPage,
  getPageCatalog,
  getPhotoUploadLink,
];

/** The MCP server for one request: stateless, so built per request with its caller in scope. */
export function connectorServer(scope: ToolScope): McpServer {
  const server = new McpServer(
    { name: "Better Giving", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const register of TOOLS) register(server, scope);
  return server;
}
