const TITLE = {
  404: "Not Found",
  500: "Internal Server Error",
};

type ProblemStatus = keyof typeof TITLE;

/** RFC 9457 problem details; `code` is the stable value clients branch on. */
export function problem(
  status: ProblemStatus,
  code: string,
  detail: string,
): Response {
  return Response.json(
    { type: "about:blank", title: TITLE[status], status, detail, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
