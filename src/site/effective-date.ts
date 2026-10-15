// The calendar day this process's bundle was built, UTC `YYYY-MM-DD`.
// `pnpm build` replaces BUILD_DATE. A runner that executes this file directly
// (tsx, vitest) has no stamp, so it uses the UTC day that process started.
declare const BUILD_DATE: string;

function stampedBuildDate(): string {
	if (typeof BUILD_DATE === "string") return BUILD_DATE;
	return new Date().toISOString().slice(0, 10);
}

export const EFFECTIVE_DATE = stampedBuildDate();
