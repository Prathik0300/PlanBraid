"use client";

import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { DashboardState } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

export { queryKeys } from "@/lib/query-keys";

export class ApiClientError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

/** One cache per authenticated app mount. AuthGate keys this provider by user ID, so a
 * logout/login on the same browser can never expose the prior account's cached data. */
export function PlanbraidQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (failureCount, error) => failureCount < 2 && (!(error instanceof ApiClientError) || error.status >= 500),
      },
      mutations: { retry: false },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function dashboardQuery() {
  return queryOptions({
    queryKey: queryKeys.dashboard,
    queryFn: ({ signal }) => fetchJson<DashboardState>("/api/state", { signal }),
    staleTime: 15_000,
  });
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!response.ok) throw new ApiClientError(body?.error?.message ?? `Request failed (${response.status})`, response.status, body?.error?.code ?? null);
  if (body === null) throw new ApiClientError("The server returned an empty response", 502);
  return body;
}

export async function fetchData<T>(url: string, init?: RequestInit): Promise<T> {
  const body = await fetchJson<{ data?: T }>(url, init);
  if (body.data === undefined) throw new ApiClientError("The server response did not contain data", 502);
  return body.data;
}
