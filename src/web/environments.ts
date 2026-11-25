import type { Environment, Environments } from "../t3/adapter.js";
import { T3ToolError } from "../t3/connection.js";
import { escapeHtml, layout } from "./html.js";
import { sendHtml, sendJson, type Route } from "./http.js";

export interface EnvironmentSource {
  environments(): Promise<Environments>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A short reason that is safe to show: T3's error code, or a system error
 * code such as ECONNREFUSED. Upstream message text is left out, because it can
 * carry response bodies. The full error goes to the service log.
 */
export function publicReason(error: unknown): string {
  console.error("T3 request failed", error);
  if (error instanceof T3ToolError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof cause === "string" && /^[A-Z_]+$/.test(cause)) return cause;
  return "unknown error";
}
/** Overview warns this long before a link expires. */
export const LINK_WARNING_MS = 7 * DAY_MS;

function expiresIn(environment: Environment, now: number): string {
  const left = Date.parse(environment.expiresAt) - now;
  if (left <= 0) return "expired";
  const days = Math.floor(left / DAY_MS);
  return days === 1 ? "expires in 1 day" : `expires in ${String(days)} days`;
}

function expiringSoon(environment: Environment, now: number): boolean {
  return Date.parse(environment.expiresAt) - now <= LINK_WARNING_MS;
}

/** The Environments page: T3's linked environments with reachability, access and link expiry. */
export function environmentRoutes(
  source: EnvironmentSource,
  now: () => number = Date.now,
): Route[] {
  return [
    {
      method: "GET",
      path: /^\/environments$/,
      handle: async ({ response }) => {
        let result: Environments;
        try {
          result = await source.environments();
        } catch (error) {
          sendHtml(
            response,
            502,
            layout(
              "Environments",
              `<h1>Environments</h1>\n<p class="error">T3 could not be reached: ${escapeHtml(publicReason(error))}</p>`,
            ),
          );
          return;
        }
        const rows = result.environments
          .map(
            (environment) => `<tr>
  <td>${escapeHtml(environment.label)}</td>
  <td><code>${escapeHtml(environment.environmentId)}</code></td>
  <td>${escapeHtml(environment.status)}${environment.lastCallFailed ? '<br><span class="error">last call failed</span>' : ""}</td>
  <td>${escapeHtml(environment.access)}</td>
  <td>${escapeHtml(environment.expiresAt)}<br><span${expiringSoon(environment, now()) ? ' class="error"' : ""}>${expiresIn(environment, now())}</span></td>
</tr>`,
          )
          .join("\n");
        sendHtml(
          response,
          200,
          layout(
            "Environments",
            `<h1>Environments</h1>
<p>Environments linked to this host's T3 server. Factory threads run only on workers, which later setup steps mark.</p>
<table>
<thead><tr><th>Name</th><th>Id</th><th>Reachability</th><th>Access</th><th>Link expiry</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
          ),
        );
      },
    },
    {
      method: "GET",
      path: /^\/api\/environments$/,
      handle: async ({ response }) => {
        try {
          sendJson(response, 200, await source.environments());
        } catch (error) {
          sendJson(response, 502, { error: publicReason(error) });
        }
      },
    },
  ];
}

/** Overview warnings for links that expire within 7 days, as HTML. */
export async function linkExpiryWarnings(
  source: EnvironmentSource,
  now: () => number = Date.now,
): Promise<string> {
  let result: Environments;
  try {
    result = await source.environments();
  } catch (error) {
    return `<p class="error">T3 could not be reached: ${escapeHtml(publicReason(error))}</p>`;
  }
  const soon = result.environments.filter((environment) => expiringSoon(environment, now()));
  if (soon.length === 0) return "";
  const items = soon
    .map(
      (environment) =>
        `<li>${escapeHtml(environment.label)}: the T3 link ${expiresIn(environment, now())}. Link it again from this host before then.</li>`,
    )
    .join("");
  return `<h2>Needs you</h2>\n<ul class="error">${items}</ul>`;
}
