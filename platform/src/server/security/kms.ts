/**
 * Envelope encryption. A KMS/HSM adapter wraps per-tenant data-encryption
 * keys (DEKs); data is encrypted with AES-256-GCM under the tenant DEK.
 *
 * Production startup REFUSES a weak, missing or dev-labelled master key —
 * see assertProductionKeyConfig(). The LocalKmsAdapter is for development and
 * tests only and says so at every layer.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/client";

export interface KmsAdapter {
  /** Identifier recorded next to every wrapped key (rotation forensics). */
  readonly keyRef: string;
  wrapKey(plainDek: Buffer): Promise<string>;
  unwrapKey(wrappedDek: string): Promise<Buffer>;
}

/**
 * DEVELOPMENT ONLY. Master key from BIOCHECK_MASTER_KEY_B64 (32 bytes,
 * urlsafe base64) — the same convention as biocheck_engine. A production
 * deployment must supply a real KMS/HSM adapter (AWS KMS / GCP KMS / CloudHSM
 * / on-prem HSM) implementing KmsAdapter.
 */
export class LocalKmsAdapter implements KmsAdapter {
  readonly keyRef: string;
  private readonly masterKey: Buffer;

  constructor() {
    const encoded = process.env.BIOCHECK_MASTER_KEY_B64;
    if (!encoded) throw new Error("BIOCHECK_MASTER_KEY_B64 must be set for the local KMS adapter (dev only).");
    this.masterKey = Buffer.from(encoded, "base64url");
    if (this.masterKey.length !== 32) throw new Error("BIOCHECK_MASTER_KEY_B64 must decode to exactly 32 bytes.");
    this.keyRef = "local-dev-master-v1"; // the 'local-dev' prefix is checked at production startup
  }

  async wrapKey(plainDek: Buffer): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ct = Buffer.concat([cipher.update(plainDek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
  }

  async unwrapKey(wrappedDek: string): Promise<Buffer> {
    const raw = Buffer.from(wrappedDek, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }
}

/**
 * Called at startup. In production it refuses to boot with a missing master
 * configuration or a dev-labelled adapter, so a misconfigured deployment
 * cannot silently run on a weak key.
 */
export function assertProductionKeyConfig(kms: KmsAdapter, nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv !== "production") return;
  if (kms.keyRef.startsWith("local-dev")) {
    throw new Error("Production refuses the local development KMS adapter. Configure a KMS/HSM.");
  }
}

const ROTATION_DAYS = 180;

/** Fetches (or creates) the active DEK for a tenant. Plaintext DEK lives only in memory. */
export async function getTenantDek(db: Db, kms: KmsAdapter, organisationId: string | null): Promise<{ dek: Buffer; keyVersion: number }> {
  const { rows } = await db.query<{ wrapped_dek: string; key_version: number }>(
    `SELECT wrapped_dek, key_version FROM tenant_keys
     WHERE organisation_id IS NOT DISTINCT FROM $1 AND status = 'active' ORDER BY key_version DESC LIMIT 1`,
    [organisationId],
  );
  if (rows[0]) return { dek: await kms.unwrapKey(rows[0].wrapped_dek), keyVersion: rows[0].key_version };
  const dek = randomBytes(32);
  const wrapped = await kms.wrapKey(dek);
  await db.query(
    `INSERT INTO tenant_keys (id, organisation_id, key_version, wrapped_dek, kms_key_ref, rotate_due_at)
     VALUES ($1, $2, 1, $3, $4, now() + interval '${ROTATION_DAYS} days')`,
    [randomUUID(), organisationId, wrapped, kms.keyRef],
  );
  return { dek, keyVersion: 1 };
}

/** Rotation: new DEK version; old version retired for decrypt-only use. */
export async function rotateTenantDek(db: Db, kms: KmsAdapter, organisationId: string | null): Promise<number> {
  const current = await getTenantDek(db, kms, organisationId);
  const next = randomBytes(32);
  const wrapped = await kms.wrapKey(next);
  await db.query(
    `UPDATE tenant_keys SET status = 'retired', retired_at = now() WHERE organisation_id IS NOT DISTINCT FROM $1 AND status = 'active'`,
    [organisationId],
  );
  await db.query(
    `INSERT INTO tenant_keys (id, organisation_id, key_version, wrapped_dek, kms_key_ref, rotate_due_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '${ROTATION_DAYS} days')`,
    [randomUUID(), organisationId, current.keyVersion + 1, wrapped, kms.keyRef],
  );
  return current.keyVersion + 1;
}

/** Decrypt with a specific retired version (old records after rotation). */
export async function getTenantDekVersion(db: Db, kms: KmsAdapter, organisationId: string | null, keyVersion: number): Promise<Buffer> {
  const { rows } = await db.query<{ wrapped_dek: string }>(
    `SELECT wrapped_dek FROM tenant_keys WHERE organisation_id IS NOT DISTINCT FROM $1 AND key_version = $2`,
    [organisationId, keyVersion],
  );
  if (!rows[0]) throw new Error("Tenant key version not found.");
  return kms.unwrapKey(rows[0].wrapped_dek);
}

/* ---------------- envelope helpers (AES-256-GCM, AAD = orgId:context) ---------------- */

export function encryptWithDek(dek: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

export function decryptWithDek(dek: Buffer, blob: string, aad: string): Buffer {
  if (!blob.startsWith("enc1:")) throw new Error("Not an envelope-encrypted value.");
  const raw = Buffer.from(blob.slice(5), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", dek, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

export function isEnvelopeCiphertext(value: string): boolean {
  return value.startsWith("enc1:");
}

/* ---------------- singleton wiring ---------------- */

let adapter: KmsAdapter | null = null;

export function getKms(): KmsAdapter {
  if (!adapter) {
    adapter = new LocalKmsAdapter(); // replaced by a real adapter via setKms() in production wiring
    assertProductionKeyConfig(adapter);
  }
  return adapter;
}

export function setKms(kms: KmsAdapter): void {
  assertProductionKeyConfig(kms);
  adapter = kms;
}
