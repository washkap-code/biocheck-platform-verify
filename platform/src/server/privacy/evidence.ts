/**
 * Encrypted evidence storage. DEFAULT RETENTION IS ZERO: capture media is
 * analysed and discarded; nothing reaches this module unless tenant policy
 * explicitly retains evidence with a purpose and a retention date.
 *
 * There are no public URLs — access goes through fetchEvidence(), which is
 * policy-layer guarded and audited. Ciphertext only in the storage adapter.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { authorize, type AuthContext } from "../authz/policy";
import { appendAudit } from "../audit/service";
import { sha256Hex } from "../security/crypto";
import { getKms, getTenantDek, getTenantDekVersion, encryptWithDek, decryptWithDek } from "../security/kms";

export interface ObjectStorageAdapter {
  put(ref: string, bytes: Buffer): Promise<void>;
  get(ref: string): Promise<Buffer | null>;
  delete(ref: string): Promise<void>;
}

/** In-memory adapter for tests/local dev. Production: S3-compatible bucket with no public access. */
export class MemoryStorageAdapter implements ObjectStorageAdapter {
  private objects = new Map<string, Buffer>();
  async put(ref: string, bytes: Buffer) { this.objects.set(ref, bytes); }
  async get(ref: string) { return this.objects.get(ref) ?? null; }
  async delete(ref: string) { this.objects.delete(ref); }
  get size() { return this.objects.size; }
}

export interface RetainEvidenceInput {
  organisationId: string;
  subjectId?: string;
  relatedType: string;
  relatedId?: string;
  purpose: string;               // mandatory
  retentionExpiresAt: Date;      // mandatory
  bytes: Buffer;
  createdBy: string;             // user id or api key id
}

export class EvidenceService {
  constructor(private readonly db: Db, private readonly storage: ObjectStorageAdapter) {}

  /** Explicit retention only. Refuses missing purpose/retention. Encrypts before storage. */
  async retain(input: RetainEvidenceInput): Promise<string> {
    if (!input.purpose?.trim()) throw new Error("Evidence retention requires an explicit purpose.");
    if (!(input.retentionExpiresAt instanceof Date) || input.retentionExpiresAt <= new Date()) {
      throw new Error("Evidence retention requires a future retention expiry date.");
    }
    const id = randomUUID();
    const storageRef = `evidence/${input.organisationId}/${id}`;
    const { dek, keyVersion } = await getTenantDek(this.db, getKms(), input.organisationId);
    const ciphertext = encryptWithDek(dek, input.bytes, `${input.organisationId}:evidence:${id}`);
    await this.storage.put(storageRef, Buffer.from(ciphertext, "utf8"));
    await this.db.query(
      `INSERT INTO evidence_objects (id, organisation_id, subject_id, related_type, related_id, purpose,
         retention_expires_at, storage_ref, content_sha256, key_version, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, input.organisationId, input.subjectId ?? null, input.relatedType, input.relatedId ?? null,
       input.purpose, input.retentionExpiresAt, storageRef, sha256Hex(input.bytes), keyVersion, input.createdBy],
    );
    await appendAudit(this.db, {
      organisationId: input.organisationId, actorType: "system", actorId: input.createdBy,
      action: "evidence.retained", resourceType: "evidence_object", resourceId: id, outcome: "success",
      details: { purpose: input.purpose, relatedType: input.relatedType },
    });
    return id;
  }

  /** Role-guarded, audited access. Only reviewers/compliance via reviews:decide or audit:read. */
  async fetch(ctx: AuthContext, organisationId: string, evidenceId: string): Promise<Buffer> {
    await authorize(this.db, ctx, organisationId, "reviews:decide");
    const { rows } = await this.db.query<{ storage_ref: string; key_version: number; deleted_at: string | null }>(
      `SELECT storage_ref, key_version, deleted_at FROM evidence_objects WHERE id = $1 AND organisation_id = $2`,
      [evidenceId, organisationId],
    );
    const row = rows[0];
    if (!row || row.deleted_at) throw new Error("Evidence not found or deleted.");
    const stored = await this.storage.get(row.storage_ref);
    if (!stored) throw new Error("Evidence object missing from storage.");
    const dek = await getTenantDekVersion(this.db, getKms(), organisationId, row.key_version);
    const plaintext = decryptWithDek(dek, stored.toString("utf8"), `${organisationId}:evidence:${evidenceId}`);
    await appendAudit(this.db, {
      organisationId, actorType: "user", actorId: ctx.userId,
      action: "evidence.accessed", resourceType: "evidence_object", resourceId: evidenceId, outcome: "success",
    });
    return plaintext;
  }

  async deleteObject(organisationId: string, evidenceId: string, reason: string, actorId: string): Promise<void> {
    const { rows } = await this.db.query<{ storage_ref: string }>(
      `UPDATE evidence_objects SET deleted_at = now()
       WHERE id = $1 AND organisation_id = $2 AND deleted_at IS NULL RETURNING storage_ref`,
      [evidenceId, organisationId],
    );
    if (!rows[0]) return;
    await this.storage.delete(rows[0].storage_ref);
    await appendAudit(this.db, {
      organisationId, actorType: "system", actorId,
      action: "evidence.deleted", resourceType: "evidence_object", resourceId: evidenceId,
      outcome: "success", details: { reason },
    });
  }

  /** Retention sweep — run by the job framework. Deletes everything past expiry. */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.db.query<{ id: string; organisation_id: string }>(
      `SELECT id, organisation_id FROM evidence_objects WHERE retention_expires_at <= now() AND deleted_at IS NULL`,
    );
    for (const row of rows) {
      await this.deleteObject(row.organisation_id, row.id, "retention_expired", "retention-job");
    }
    return rows.length;
  }
}
