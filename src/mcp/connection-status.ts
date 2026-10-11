import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolScope } from "./server.ts";
import { observed, reconnectRequired, usableConnection } from "./tool.ts";

const NAME = "connection_status";

export function connectionStatus(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    NAME,
    {
      title: "Better Giving connection status",
      description:
        "Shows which Better Giving deployment this connector reaches, and the Better Giving release that deployment reported when it was connected, if it reported one.",
      outputSchema: z.object({
        deploymentUrl: z.string(),
        release: z.string(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    observed(scope, NAME, async () => {
      const connection = await usableConnection(scope);
      if (connection === null) return reconnectRequired();
      const { deploymentUrl, release } = connection;
      return {
        content: [
          {
            type: "text",
            text: `Connected to the Better Giving deployment at ${deploymentUrl}${release === "" ? "" : `, release ${release}`}.`,
          },
        ],
        structuredContent: { deploymentUrl, release },
      };
    }),
  );
}
