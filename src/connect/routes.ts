import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { routePath } from "hono/route";
import {
  NONCE,
  type SecureHeadersVariables,
  secureHeaders,
} from "hono/secure-headers";
import { validator } from "hono/validator";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { CONNECT_PATH } from "../auth/index.ts";
import type { HelloProblem } from "../deployment/index.ts";
import { type ConnectOutcome, errorClass } from "../log.ts";
import { parseAddress } from "./address.ts";
import {
  connectFlow,
  hasTimeLeft,
  RESULT_OUTCOMES,
  type ResultOutcome,
} from "./flow.ts";
import {
  type AddressError,
  addressPage,
  cancelledPage,
  expiredPage,
  failedPage,
  startFromChatAppPage,
  unconfirmedPage,
} from "./pages.ts";

type ConnectEnv = { Variables: SecureHeadersVariables };

/** Sent as `__Host-connect`: Secure, Path=/ and no Domain, so no sibling subdomain can plant or overwrite it. */
const BROWSER_COOKIE = "connect";
/** Outlives an attempt's window (the chat app's 10 minutes) and nothing more. */
const BROWSER_COOKIE_SECONDS = 15 * 60;

const HELLO_OUTCOME: Record<HelloProblem, ConnectOutcome> = {
  no_such_host: "no-such-host",
  no_answer: "no-answer",
  not_better_giving: "not-better-giving",
  outdated: "outdated",
};

const ResultQuery = z.object({
  outcome: z.enum(RESULT_OUTCOMES),
  attempt: z.string().optional(),
});

/** The raw query a request arrived with, without its `?`: the signed query is verified over it as sent. */
function rawQuery(c: Context): string {
  return new URL(c.req.url).search.slice(1);
}

function nonceOf(c: Context<ConnectEnv>): string {
  return c.get("secureHeadersNonce") ?? "";
}

/** The connect flow's pages, mounted at `CONNECT_PATH`. */
export function connectRoutes(deps: AppDeps) {
  const flow = connectFlow(deps);
  /** The nonce in this browser's cookie, when it holds one. */
  const browserNonce = (c: Context) => {
    const value = getCookie(c, BROWSER_COOKIE, "host");
    return deps.attempts.isNonce(value) ? value : undefined;
  };
  const logOutcome = (outcome: ConnectOutcome) =>
    deps.log({ event: "connect_outcome", outcome });

  return (
    new Hono<ConnectEnv>()
      .use(
        secureHeaders({
          contentSecurityPolicy: {
            defaultSrc: ["'none'"],
            styleSrc: [NONCE],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"],
          },
          // the chat app's callback opens in this window after us; same-origin would cut it off from its opener
          crossOriginOpenerPolicy: false,
        }),
      )
      .use(async (c, next) => {
        await next();
        c.header("cache-control", "no-store");
      })
      .get("/", async (c) => {
        const oauthQuery = rawQuery(c);
        const window = await flow.window(oauthQuery, new Date());
        if (window.kind === "none") {
          return c.html(startFromChatAppPage(nonceOf(c)));
        }
        if (window.kind === "over") return c.html(expiredPage(nonceOf(c)));
        return c.html(
          addressPage(nonceOf(c), { action: `${CONNECT_PATH}?${oauthQuery}` }),
        );
      })
      // a body that isn't a form reads as no address: the page asks for one
      .post(
        "/",
        // the page this service served posts here; another site's would set this browser's cookie
        csrf({ origin: new URL(deps.publicUrl).origin }),
        validator("form", (form) => ({
          address: typeof form.address === "string" ? form.address : "",
        })),
        async (c) => {
          const oauthQuery = rawQuery(c);
          const window = await flow.window(oauthQuery, new Date());
          if (window.kind === "none") {
            return c.html(startFromChatAppPage(nonceOf(c)));
          }
          if (window.kind === "over") {
            logOutcome("window-over");
            return c.html(expiredPage(nonceOf(c)));
          }
          const { address } = c.req.valid("form");
          const refuse = (error: AddressError, outcome: ConnectOutcome) => {
            logOutcome(outcome);
            return c.html(
              addressPage(nonceOf(c), {
                action: `${CONNECT_PATH}?${oauthQuery}`,
                typed: address,
                error,
              }),
              422,
            );
          };
          const parsed = parseAddress(address);
          if (!parsed.ok) return refuse(parsed.error, "address-invalid");
          const hello = await deps.deployments.hello(parsed.origin);
          if (!hello.ok)
            return refuse(hello.problem, HELLO_OUTCOME[hello.problem]);

          // hello can take its whole timeout: the window is checked again after it
          const now = new Date();
          if (!hasTimeLeft(window.expiresAt, now)) {
            logOutcome("window-over");
            return c.html(expiredPage(nonceOf(c)));
          }
          // a browser already holding a nonce keeps it, so an attempt in another tab stays bound
          const browser = browserNonce(c) ?? deps.attempts.newNonce();
          const { allowUrl } = await flow.handOff(
            {
              oauthQuery,
              deploymentUrl: hello.origin,
              release: hello.release ?? "",
              expiresAt: window.expiresAt,
            },
            browser,
            now,
          );
          setCookie(c, BROWSER_COOKIE, browser, {
            prefix: "host",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
            maxAge: BROWSER_COOKIE_SECONDS,
          });
          logOutcome("handed-off");
          return c.redirect(allowUrl, 303);
        },
      )
      .get("/return", async (c) => {
        const { state, code, error, iss } = c.req.query();
        if (state === undefined && code === undefined && error === undefined) {
          return c.html(startFromChatAppPage(nonceOf(c)));
        }
        let finished: Awaited<ReturnType<typeof flow.finish>>;
        try {
          finished = await flow.finish(
            { state, code, error, iss },
            browserNonce(c),
            new Date(),
          );
        } catch (cause) {
          deps.log({
            event: "unhandled_error",
            method: c.req.method,
            route: routePath(c),
            ...errorClass(cause instanceof Error ? cause : new Error()),
          });
          finished = { outcome: "failed" };
        }
        logOutcome(finished.outcome);
        if (finished.outcome === "connected") {
          return c.redirect(finished.redirectTo, 303);
        }
        const result = new URLSearchParams({ outcome: finished.outcome });
        if (finished.outcome === "cancelled-retry") {
          result.set("attempt", finished.attempt);
        }
        return c.redirect(`${CONNECT_PATH}/result?${result}`, 303);
      })
      .get(
        "/result",
        validator("query", (query) => {
          const parsed = ResultQuery.safeParse(query);
          return parsed.success ? parsed.data : undefined;
        }),
        async (c) => {
          const nonce = nonceOf(c);
          const result = c.req.valid("query");
          if (result === undefined) return c.html(startFromChatAppPage(nonce));
          const pages: Record<
            Exclude<ResultOutcome, "cancelled-retry">,
            () => ReturnType<typeof expiredPage>
          > = {
            cancelled: () => cancelledPage(nonce),
            unconfirmed: () => unconfirmedPage(nonce),
            expired: () => expiredPage(nonce),
            failed: () => failedPage(nonce, "ours"),
            "deployment-down": () => failedPage(nonce, "deployment"),
          };
          if (result.outcome !== "cancelled-retry") {
            return c.html(pages[result.outcome]());
          }
          const allowUrl =
            result.attempt === undefined
              ? undefined
              : await flow.retryAllowUrl(result.attempt, new Date());
          return c.html(cancelledPage(nonce, allowUrl));
        },
      )
  );
}
