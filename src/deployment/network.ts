import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

/** Whether a host may be reached from this server. */
export type HostLookup = "public" | "not_public" | "no_such_host";

/** How the connector reaches deployments: a deployment client never touches the network any other way. */
export interface DeploymentNetwork {
  lookup(hostname: string): Promise<HostLookup>;
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/**
 * Loopback, private, link-local, CGNAT and every other range no deployment is served from.
 * BlockList checks an IPv4-mapped IPv6 address against the IPv4 rules itself.
 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // NAT64 can carry a private IPv4 address
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string, family: 4 | 6): boolean {
  return !NOT_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The internet as the deployed service reaches it. The check runs before each request, so a name
 * that changes its answer between the check and the connection is not caught.
 */
export const publicInternet: DeploymentNetwork = {
  async lookup(hostname) {
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOTFOUND" || code === "ENODATA") return "no_such_host";
      throw error;
    }
    return addresses.every(({ address, family }) =>
      isPublicAddress(address, family === 4 ? 4 : 6),
    )
      ? "public"
      : "not_public";
  },
  fetch: (url, init) => fetch(url, init),
};
