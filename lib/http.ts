/**
 * fetch with a hard timeout via AbortController, plus friendly error messages.
 * Copied verbatim from `leads AI/lib/http.ts`.
 *
 * Errors name the host only, never the full URL, so an API key sitting in a
 * query string can't leak into a log line.
 */

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw url if it isn't parseable */
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    if (err?.name === "AbortError") {
      throw new Error(`Request to ${host} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Request to ${host} failed: ${err?.message ?? String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
