import type { ProviderRequest } from "@/lib/integrations/types";

export type ProviderFetchOptions = RequestInit & {
  provider: string;
  fetcher?: ProviderRequest;
  maxRetries?: number;
  maxInlineDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class ProviderHttpError extends Error {
  code: string;
  status: number;
  responseStatus: number;
  retryAfterSeconds: number | null;
  constructor(provider: string, status: number, retryAfterSeconds: number | null, message?: string) {
    super(message ?? `${provider} request failed (${status})`);
    this.code = status === 429 ? "PROVIDER_RATE_LIMITED" : status === 401 ? "PROVIDER_RECONNECT_REQUIRED" : "PROVIDER_REQUEST_FAILED";
    this.status = status === 401 ? 401 : 502;
    this.responseStatus = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function providerFetch(url: string, options: ProviderFetchOptions) {
  const { provider, fetcher = fetch, maxRetries = 3, maxInlineDelayMs = 2_000, sleep = defaultSleep, ...request } = options;
  let attempt = 0;
  while (true) {
    const response = await fetcher(url, { ...request, cache: "no-store" });
    if (response.ok || response.status === 304) return response;

    const retryAfterSeconds = retryAfter(response.headers.get("retry-after"));
    const retryable = response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;
    const exponential = Math.min(250 * (2 ** attempt), maxInlineDelayMs);
    const delay = Math.max(retryAfterSeconds === null ? 0 : retryAfterSeconds * 1000, exponential);
    if (!retryable || attempt >= maxRetries || delay > maxInlineDelayMs) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 300); } catch { /* response bodies are optional */ }
      throw new ProviderHttpError(provider, response.status, retryAfterSeconds, detail || undefined);
    }
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    await sleep(jittered);
    attempt += 1;
  }
}

function retryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** RFC 8288/RFC 5988 next-link extraction. Provider URLs are followed exactly; callers
 * never synthesize page numbers because Basecamp explicitly requires Link pagination. */
export function nextLink(header: string | null) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel=(?:"next"|next)/i.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}
