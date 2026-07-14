/**
 * Platform cryptographic primitives. Pure-JS (@noble/hashes) so the same code
 * runs in CI, local dev and production without native build steps.
 * Biometric material NEVER passes through this module — that stays in verify-core.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { scrypt } from "@noble/hashes/scrypt";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === "string" ? utf8ToBytes(input) : input));
}

/** Canonical JSON digest — identical scheme to biocheck_engine.crypto.digest. */
export function chainDigest(event: Record<string, unknown>, previousHash: string): string {
  const canonical = JSON.stringify(sortKeysDeep(event));
  return sha256Hex(previousHash + canonical);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function randomToken(bytes = 32): string {
  return Buffer.from(randomBytes(bytes)).toString("base64url");
}

/** Salted, versioned scrypt password hash: v1$N$r$p$salt$hash */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scrypt(utf8ToBytes(password), salt, SCRYPT);
  return `v1$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${Buffer.from(key).toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "v1") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const key = scrypt(utf8ToBytes(password), Buffer.from(saltB64, "base64url"), {
    N: Number(n), r: Number(r), p: Number(p), dkLen: 32,
  });
  const expected = Buffer.from(hashB64, "base64url");
  return expected.length === key.length && timingSafeEqual(Buffer.from(key), expected);
}

/** Privacy-minimised IP: salted hash, never the raw address. */
export function minimiseIp(ip: string | null | undefined, salt: string): string | null {
  if (!ip) return null;
  return sha256Hex(`${salt}:${ip}`).slice(0, 24);
}

export function hmacSha256Hex(key: string, message: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(key), utf8ToBytes(message)));
}

/**
 * Constant-time equality for hex-encoded digests (API key hashes, token
 * hashes, etc). Plain `===`/`!==` on secret-derived strings leaks timing
 * information proportional to the matching prefix length; this is the same
 * defence hashPassword/verifyPassword already use via node:crypto's
 * timingSafeEqual, just generalised for any two hex strings of equal length.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
