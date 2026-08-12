/**
 * GITHUB_APP_SLUG normalization. Pasting the settings-page URL out of the address bar
 * produced https://github.com/apps/%20https%3A%2F%2F.../installations/new, a 404 with
 * nothing explaining why, so the slug is now extracted rather than blindly encoded.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAppSlug } from "@/lib/github.ts";

test("accepts a bare slug", () => {
  assert.equal(normalizeAppSlug("planbraid"), "planbraid");
  assert.equal(normalizeAppSlug("plan-braid-2"), "plan-braid-2");
});

test("recovers the slug from a pasted settings or app URL, including stray whitespace", () => {
  assert.equal(normalizeAppSlug(" https://github.com/settings/apps/planbraid"), "planbraid");
  assert.equal(normalizeAppSlug("https://github.com/apps/planbraid"), "planbraid");
  assert.equal(normalizeAppSlug("https://github.com/settings/apps/planbraid/"), "planbraid");
  assert.equal(normalizeAppSlug("  planbraid  "), "planbraid");
});

test("lowercases, matching how GitHub derives a slug from the app name", () => {
  assert.equal(normalizeAppSlug("Planbraid"), "planbraid");
});

test("treats unset or unusable values as not configured rather than building a dead link", () => {
  assert.equal(normalizeAppSlug(undefined), "");
  assert.equal(normalizeAppSlug(""), "");
  assert.equal(normalizeAppSlug("   "), "");
  assert.equal(normalizeAppSlug("my app"), "");
  assert.equal(normalizeAppSlug("https://github.com/settings/apps/"), "");
});
