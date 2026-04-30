/**
 * REST-only helpers for the site-picker mode -- listing workspaces and
 * docs accessible to the user, before any WebSocket connection is opened.
 *
 * Lives apart from `ConsoleConnection` because that class is per-doc and
 * owns a WebSocket; the site picker runs ahead of any of that.
 */

import fetch from "node-fetch";

/** A doc as returned by GET /api/orgs/<slug>/workspaces. */
export interface SiteDoc {
  id: string;
  name: string;
  workspaceId: number;
  workspaceName: string;
  /** ISO timestamp; Grist returns this as a string. */
  updatedAt: string;
  /** ISO timestamp or null when not in trash. */
  removedAt: string | null;
}

/**
 * Fetch workspaces+docs from a Grist site. Trashed docs (removedAt set)
 * are filtered out. Docs are returned flat, sorted by `updatedAt` desc
 * so the most recent activity floats to the top.
 *
 * "current" only resolves on the server side when the request URL
 * carries org context -- a team subdomain (`myteam.getgrist.com`) or an
 * `/o/<slug>` prefix. On a bare hostname, "current" comes back as 400
 * "No organization chosen"; we fall back to GET /api/orgs and pick the
 * first one available to the user.
 */
export async function listSiteDocs(
  serverUrl: string, orgSlug: string, apiKey?: string,
): Promise<SiteDoc[]> {
  const headers: Record<string, string> = {};
  if (apiKey) { headers.Authorization = `Bearer ${apiKey}`; }

  let resolvedSlug = orgSlug;
  let resp = await fetch(workspacesUrl(serverUrl, resolvedSlug), { headers });
  if (!resp.ok && resp.status === 400 && orgSlug === "current") {
    resolvedSlug = await resolveDefaultOrg(serverUrl, headers);
    resp = await fetch(workspacesUrl(serverUrl, resolvedSlug), { headers });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GET ${workspacesUrl(serverUrl, resolvedSlug)} failed: ${resp.status} ${body}`);
  }
  const workspaces = await resp.json() as Array<{
    id: number;
    name: string;
    docs: Array<{
      id: string; name: string;
      updatedAt?: string; removedAt?: string | null;
    }>;
  }>;
  const docs: SiteDoc[] = [];
  for (const ws of workspaces) {
    for (const d of (ws.docs || [])) {
      if (d.removedAt) { continue; }
      docs.push({
        id: d.id,
        name: d.name,
        workspaceId: ws.id,
        workspaceName: ws.name,
        updatedAt: d.updatedAt || "",
        removedAt: d.removedAt || null,
      });
    }
  }
  docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return docs;
}

function workspacesUrl(serverUrl: string, orgSlug: string): string {
  return `${serverUrl}/api/orgs/${encodeURIComponent(orgSlug)}/workspaces`;
}

async function resolveDefaultOrg(serverUrl: string, headers: Record<string, string>): Promise<string> {
  const resp = await fetch(`${serverUrl}/api/orgs`, { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GET ${serverUrl}/api/orgs failed: ${resp.status} ${body}`);
  }
  const orgs = await resp.json() as Array<{ id: number; domain?: string | null }>;
  if (!orgs.length) { throw new Error("No orgs accessible to this user"); }
  // Domain is the human-readable slug; on personal orgs it can be null,
  // in which case the numeric id still works as the path component.
  const first = orgs[0];
  return first.domain || String(first.id);
}

/**
 * Format an ISO timestamp as a short relative string ("5 min ago",
 * "2 hr ago", "yesterday", "3 days ago", "Mar 4"). `now` is parameterised
 * so tests don't depend on the wall clock.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  if (!iso) { return ""; }
  const t = Date.parse(iso);
  if (isNaN(t)) { return ""; }
  const diffMs = now.getTime() - t;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) { return "just now"; }
  const min = Math.round(sec / 60);
  if (min < 60) { return `${min} min ago`; }
  const hr = Math.round(min / 60);
  if (hr < 24) { return `${hr} hr ago`; }
  const day = Math.round(hr / 24);
  if (day === 1) { return "yesterday"; }
  if (day < 14) { return `${day} days ago`; }
  if (day < 60) { return `${Math.round(day / 7)} weeks ago`; }
  // Older than ~2 months: show short month + day.
  const d = new Date(t);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
