// The privacy page states these lifetimes. Access tokens are set here, rather
// than left to the oauth-provider default, so the page and the issuer name
// the same hour. Rate-limit rows use the day below; the sweep deletes them.

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** Refresh token lifetime, in seconds. 90 days. */
export const REFRESH_TOKEN_EXPIRES_IN = 90 * DAY;

/** Access token lifetime, in seconds. 1 hour. */
export const ACCESS_TOKEN_EXPIRES_IN = HOUR;

/** Session lifetime, in seconds. 365 days, stated on the privacy page as 1 year. */
export const SESSION_EXPIRES_IN = 365 * DAY;

/** How long a rate-limit row is kept after its last request, in seconds. */
export const RATE_LIMIT_RETENTION = DAY;

/**
 * How long a retried refresh may receive the previous token response, in
 * seconds. Passed to the MCP plugin, which otherwise defaults to the same 30.
 * The daily sweep clears the encrypted copy once this window has passed.
 */
export const REFRESH_TOKEN_REUSE_INTERVAL = 30;

/** The words the privacy page uses for one of the lifetimes above. */
export function lifetimeLabel(seconds: number): string {
	if (seconds === 365 * DAY) return "1 year";
	if (seconds % DAY === 0) {
		const days = seconds / DAY;
		return days === 1 ? "1 day" : `${days} days`;
	}
	if (seconds % HOUR === 0) {
		const hours = seconds / HOUR;
		return hours === 1 ? "1 hour" : `${hours} hours`;
	}
	throw new Error(`no privacy-page label for ${seconds} seconds`);
}
