/**
 * Authenticated encryption for third-party credentials held at rest (currently GitHub
 * tokens). A leaked database dump should not hand out working access to someone's
 * repositories, so these are never stored as plaintext.
 *
 * AES-256-GCM with a key derived from BETTER_AUTH_SECRET, which every deployment
 * already sets. Rotating that secret invalidates stored tokens by design: decryption
 * fails closed and the user is asked to reconnect, rather than the app silently
 * presenting a credential it can no longer vouch for.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: Promise<CryptoKey> | null = null;
let cachedFor: string | null = null;

function keyFor(secret: string) {
  if (cachedKey && cachedFor === secret) return cachedKey;
  cachedFor = secret;
  cachedKey = crypto.subtle.digest("SHA-256", encoder.encode(`planbraid:credential-encryption:${secret}`))
    .then((material) => crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]));
  return cachedKey;
}

function secretOrThrow() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw Object.assign(new Error("BETTER_AUTH_SECRET must be set before third-party credentials can be stored"), { code: "CONFIGURATION_ERROR", status: 503 });
  return secret;
}

/** Returns `iv.ciphertext`, both base64url, safe to persist in a TEXT column. */
export async function sealSecret(plaintext: string) {
  const key = await keyFor(secretOrThrow());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** Returns null rather than throwing when the value cannot be decrypted, so callers
 * treat an unreadable credential the same as a missing one and prompt to reconnect. */
export async function openSecret(sealed: string): Promise<string | null> {
  const [ivPart, bodyPart] = sealed.split(".");
  if (!ivPart || !bodyPart) return null;
  try {
    const key = await keyFor(secretOrThrow());
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(ivPart) }, key, fromBase64url(bodyPart));
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
