/**
 * Parse a Grist document URL into server URL and doc ID.
 * Handles URLs like:
 *   https://docs.getgrist.com/docId/slug/p/1
 *   https://server/o/org/doc/docId/p/1
 *   https://server/doc/docId
 *   https://server/docId/slug
 */
export function parseGristDocUrl(urlStr: string): { serverUrl: string, docId: string, pageId?: number } | null {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }
  const parts = url.pathname.slice(1).split("/");
  // Strip /o/org prefix if present
  let startIdx = 0;
  if (parts[0] === "o" && parts.length > 1) {
    startIdx = 2;
  }
  const rest = parts.slice(startIdx);
  let docId: string | undefined;
  // /doc/<docId>/... form
  if (rest[0] === "doc" && rest.length > 1) {
    docId = rest[1];
  }
  // /docs/<docId>/... form (API style)
  else if (rest[0] === "docs" && rest.length > 1) {
    docId = rest[1];
  }
  // /<docId>/slug/... form (when docId is long enough)
  else if (rest[0] && rest[0].length >= 12) {
    docId = rest[0];
  }
  if (!docId) { return null; }
  // Strip fork/snapshot suffixes to get the base doc ID
  docId = docId.split("~")[0];
  const serverUrl = `${url.protocol}//${url.host}`;
  // Extract page ID from /p/<pageId> suffix
  let pageId: number | undefined;
  const pIdx = rest.indexOf("p");
  if (pIdx >= 0 && pIdx + 1 < rest.length) {
    const parsed = parseInt(rest[pIdx + 1], 10);
    if (!isNaN(parsed)) { pageId = parsed; }
  }
  return { serverUrl, docId, pageId };
}
