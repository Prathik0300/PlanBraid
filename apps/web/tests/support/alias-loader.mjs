/**
 * Resolves the app's "@/..." path alias (tsconfig.json's `paths`) when running source
 * under plain `node --test`, outside the vite/vinext bundler that normally handles it.
 * Lets tests import lib/store.ts unmodified rather than forking its import style.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = pathToFileURL(`${path.resolve(import.meta.dirname, "../../")}/`).href;

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
  const rest = specifier.slice(2);
  // Node's ESM resolver (unlike the vite/vinext bundler this alias is written for)
  // requires an explicit extension; every "@/..." import in this codebase without one
  // targets a .ts module.
  const withExtension = /\.[a-z]+$/i.test(rest) ? rest : `${rest}.ts`;
  return nextResolve(ROOT + withExtension, context);
}
