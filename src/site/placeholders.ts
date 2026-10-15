/**
 * Legal and listing details that are not decided. Pages render these strings
 * as-is. Do not replace one with a guess.
 */
export const PLACEHOLDERS = {
	entity: "[ENTITY NAME]",
	address: "[ADDRESS]",
	supportEmail: "[SUPPORT EMAIL]",
	securityEmail: "[SECURITY EMAIL]",
	effectiveDate: "[EFFECTIVE DATE]",
	governingLaw: "[GOVERNING LAW]",
	venue: "[VENUE]",
	lawfulBasis:
		"[LAWFUL BASIS — confirm with counsel if EU/UK users are in scope: account and relay processing on performance of a contract (GDPR Art. 6(1)(b)); security logging on legitimate interests (Art. 6(1)(f)).]",
	transfer:
		"[TRANSFER MECHANISM, e.g. Standard Contractual Clauses — confirm with counsel if EU/UK users are in scope.]",
	dataProcessingTerms:
		"[DATA PROCESSING TERMS — attach or link a DPA if EU/UK operators are in scope.]",
	vercelLogRetention: "[VERCEL LOG RETENTION PERIOD]",
	applicationLogRetention: "[APPLICATION LOG RETENTION PERIOD]",
	passThroughRetention: "[PASS-THROUGH RETENTION]",
	keyRevocationUnreachable: "[KEY REVOCATION WHEN THE SITE CANNOT BE REACHED]",
	responseDeadline: "[RESPONSE DEADLINE]",
	noticeMethod: "[NOTICE METHOD]",
	noticePeriod: "[NOTICE PERIOD]",
	liabilityCap: "[LIABILITY CAP]",
	minimumAge: "[MINIMUM AGE]",
	openSource: "[OPEN SOURCE]",
	dashboardDisconnect: "[DASHBOARD DISCONNECT]",
} as const;
