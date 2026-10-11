// A deployment's https origin, only ever produced by `parseOrigin`.
export type Origin = string & { readonly __brand: "Origin" };

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
// The URL parser canonicalises every IPv4 spelling (`127.1`, `2130706433`) to dotted form.
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

// Reads the address an operator types — a bare host or any URL on the site —
// as the https origin of a public host. DNS that resolves to a private range
// still passes; only literals are refused.
export function parseOrigin(input: string): Origin | null {
	const typed = input.trim();
	if (typed === "") return null;
	let url: URL;
	try {
		url = new URL(HAS_SCHEME.test(typed) ? typed : `https://${typed}`);
	} catch {
		return null;
	}
	// `give.example.org.` is the same host as `give.example.org`; `localhost.` is localhost.
	if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
	const host = url.hostname;
	const refused =
		url.protocol !== "https:" ||
		url.port !== "" ||
		url.username !== "" ||
		url.password !== "" ||
		host.startsWith("[") ||
		IPV4.test(host) ||
		!host.includes(".") ||
		host.endsWith(".") ||
		host.endsWith(".localhost");
	return refused ? null : (url.origin as Origin);
}

/**
 * `parseOrigin` for the address an operator types, where `http://` means the
 * same site: deployments serve https only. A redirect's `http:` stays refused.
 */
export function parseTypedOrigin(input: string): Origin | null {
	return parseOrigin(input.trim().replace(/^http:\/\//i, "https://"));
}
