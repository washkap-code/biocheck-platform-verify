/**
 * Secrets-at-rest helper: envelope-encrypts small secrets (webhook signing
 * secrets, TOTP seeds) under the tenant DEK (platform scope = null org).
 * Values are bound to their context via AAD so a ciphertext cannot be
 * replayed into a different column/row.
 */
import type { Db } from "../db/client";
import { getKms, getTenantDek, getTenantDekVersion, encryptWithDek, decryptWithDek, isEnvelopeCiphertext } from "./kms";

export async function encryptSecret(db: Db, organisationId: string | null, context: string, plaintext: string): Promise<string> {
  const { dek, keyVersion } = await getTenantDek(db, getKms(), organisationId);
  return `v${keyVersion}.${encryptWithDek(dek, Buffer.from(plaintext, "utf8"), `${organisationId ?? "platform"}:${context}`)}`;
}

export async function decryptSecret(db: Db, organisationId: string | null, context: string, stored: string): Promise<string> {
  const match = /^v(\d+)\.(enc1:.+)$/.exec(stored);
  if (!match) {
    // Pre-Prompt-3 rows (plaintext in the reserved column). Callers should
    // re-encrypt on next write; reading is tolerated so rotation is gradual.
    return stored;
  }
  const dek = await getTenantDekVersion(db, getKms(), organisationId, Number(match[1]));
  return decryptWithDek(dek, match[2], `${organisationId ?? "platform"}:${context}`).toString("utf8");
}

export function isEncryptedSecret(value: string): boolean {
  return /^v\d+\.enc1:/.test(value) && isEnvelopeCiphertext(value.replace(/^v\d+\./, ""));
}
