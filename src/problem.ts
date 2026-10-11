const TITLE = {
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  500: "Internal Server Error",
};

type ProblemStatus = keyof typeof TITLE;

/** RFC 9457 problem details; `code` is the stable value clients branch on. */
export function problem(
  status: ProblemStatus,
  code: string,
  detail: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { type: "about:blank", title: TITLE[status], status, detail, code },
    {
      status,
      headers: { ...headers, "content-type": "application/problem+json" },
    },
  );
}
