/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) — for privileged-role MFA. */
import { randomBytes } from "node:crypto";
import { hmac } from "@noble/hashes/hmac";
import { sha1 } from "@noble/hashes/legacy";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret: string): Uint8Array {
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(c);
    if (idx === -1) throw new Error("Invalid base32 character");
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

export function totpCode(secret: string, atMs = Date.now(), step = 30): string {
  const counter = Math.floor(atMs / 1000 / step);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const digestBytes = hmac(sha1, base32Decode(secret), msg);
  const offset = digestBytes[digestBytes.length - 1] & 0x0f;
  const code =
    (((digestBytes[offset] & 0x7f) << 24) |
      (digestBytes[offset + 1] << 16) |
      (digestBytes[offset + 2] << 8) |
      digestBytes[offset + 3]) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

/** Accepts the previous, current and next window to tolerate clock drift. */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  return [-30_000, 0, 30_000].some((offset) => totpCode(secret, atMs + offset) === code);
}
