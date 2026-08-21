import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/query-keys.ts";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
}

test("concurrent consumers with the same key share one request", async () => {
  const queryClient = client();
  let calls = 0;
  const queryFn = async () => {
    calls += 1;
    await Promise.resolve();
    return { revision: 7 };
  };

  const [first, second] = await Promise.all([
    queryClient.fetchQuery({ queryKey: queryKeys.dashboard, queryFn }),
    queryClient.fetchQuery({ queryKey: queryKeys.dashboard, queryFn }),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test("fresh cached data is returned without another request", async () => {
  const queryClient = client();
  let calls = 0;
  const queryFn = async () => ++calls;

  assert.equal(await queryClient.fetchQuery({ queryKey: queryKeys.github, queryFn }), 1);
  assert.equal(await queryClient.fetchQuery({ queryKey: queryKeys.github, queryFn }), 1);
  assert.equal(calls, 1);
});

test("invalidation makes the next consumer refresh", async () => {
  const queryClient = client();
  let calls = 0;
  const queryFn = async () => ++calls;

  await queryClient.fetchQuery({ queryKey: queryKeys.integrations("project-1"), queryFn });
  await queryClient.invalidateQueries({ queryKey: queryKeys.integrations("project-1") });
  assert.equal(await queryClient.fetchQuery({ queryKey: queryKeys.integrations("project-1"), queryFn }), 2);
});

test("project revision produces a new derived-data cache entry", () => {
  assert.notDeepEqual(queryKeys.plan("project-1", 4), queryKeys.plan("project-1", 5));
  assert.deepEqual(queryKeys.plan("project-1", 4), ["project", "project-1", 4, "execution-plan"]);
});
