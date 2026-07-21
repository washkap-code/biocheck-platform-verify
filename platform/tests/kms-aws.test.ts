/**
 * Unit tests for AwsKmsAdapter (src/server/security/kms-aws.ts).
 *
 * Honest scope: these tests mock the AWS KMS client's `send()` method — they
 * verify the adapter's request shapes, response handling and error paths
 * against the AWS SDK's documented contract. They do NOT exercise a real AWS
 * KMS key, IAM policy or network path, because no AWS account is available
 * in this environment. See kms-aws.ts's file header for the same caveat.
 */
import { describe, expect, it } from "vitest";
import { EncryptCommand, DecryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import { AwsKmsAdapter } from "../src/server/security/kms-aws";
import { assertProductionKeyConfig } from "../src/server/security/kms";

function fakeClient(send: (cmd: unknown) => Promise<unknown>): KMSClient {
  return { send } as unknown as KMSClient;
}

describe("AwsKmsAdapter", () => {
  it("requires a keyId", () => {
    expect(() => new AwsKmsAdapter({ keyId: "" })).toThrow(/keyId/);
  });

  it("keyRef is the real key id, not a local-dev label, so production key config passes", () => {
    const adapter = new AwsKmsAdapter({ keyId: "arn:aws:kms:eu-west-1:123456789012:key/abc-123", client: fakeClient(async () => ({})) });
    expect(adapter.keyRef).toBe("arn:aws:kms:eu-west-1:123456789012:key/abc-123");
    expect(() => assertProductionKeyConfig(adapter, "production")).not.toThrow();
  });

  it("wrapKey sends an EncryptCommand with the DEK and key id, and base64url-encodes the ciphertext blob", async () => {
    let received: unknown;
    const client = fakeClient(async (cmd) => {
      received = cmd;
      return { CiphertextBlob: new Uint8Array([1, 2, 3, 4]) };
    });
    const adapter = new AwsKmsAdapter({ keyId: "key-1", client });
    const dek = Buffer.alloc(32, 7);
    const wrapped = await adapter.wrapKey(dek);

    expect(received).toBeInstanceOf(EncryptCommand);
    expect((received as EncryptCommand).input.KeyId).toBe("key-1");
    expect(Buffer.from((received as EncryptCommand).input.Plaintext as Uint8Array)).toEqual(dek);
    expect(wrapped).toBe(Buffer.from([1, 2, 3, 4]).toString("base64url"));
  });

  it("unwrapKey sends a DecryptCommand and returns the plaintext DEK", async () => {
    const dek = Buffer.alloc(32, 9);
    let received: unknown;
    const client = fakeClient(async (cmd) => {
      received = cmd;
      return { Plaintext: new Uint8Array(dek) };
    });
    const adapter = new AwsKmsAdapter({ keyId: "key-1", client });
    const wrapped = Buffer.from([9, 9, 9]).toString("base64url");
    const result = await adapter.unwrapKey(wrapped);

    expect(received).toBeInstanceOf(DecryptCommand);
    expect((received as DecryptCommand).input.KeyId).toBe("key-1");
    expect(Buffer.from((received as DecryptCommand).input.CiphertextBlob as Uint8Array)).toEqual(Buffer.from([9, 9, 9]));
    expect(result).toEqual(dek);
  });

  it("round-trips wrap -> unwrap through a single in-memory fake KMS", async () => {
    const store = new Map<string, Buffer>();
    let n = 0;
    const client = fakeClient(async (cmd) => {
      if (cmd instanceof EncryptCommand) {
        const id = String(n++);
        store.set(id, Buffer.from(cmd.input.Plaintext as Uint8Array));
        return { CiphertextBlob: Buffer.from(id) };
      }
      if (cmd instanceof DecryptCommand) {
        const id = Buffer.from(cmd.input.CiphertextBlob as Uint8Array).toString();
        return { Plaintext: store.get(id) };
      }
      throw new Error("unexpected command");
    });
    const adapter = new AwsKmsAdapter({ keyId: "key-1", client });
    const dek = Buffer.alloc(32, 5);
    const wrapped = await adapter.wrapKey(dek);
    const unwrapped = await adapter.unwrapKey(wrapped);
    expect(unwrapped).toEqual(dek);
  });

  it("refuses when Encrypt returns no CiphertextBlob", async () => {
    const adapter = new AwsKmsAdapter({ keyId: "key-1", client: fakeClient(async () => ({})) });
    await expect(adapter.wrapKey(Buffer.alloc(32))).rejects.toThrow(/CiphertextBlob/);
  });

  it("refuses when Decrypt returns no Plaintext", async () => {
    const adapter = new AwsKmsAdapter({ keyId: "key-1", client: fakeClient(async () => ({})) });
    await expect(adapter.unwrapKey(Buffer.from("x").toString("base64url"))).rejects.toThrow(/Plaintext/);
  });

  it("refuses an unwrapped key that is not 32 bytes", async () => {
    const client = fakeClient(async () => ({ Plaintext: new Uint8Array(16) }));
    const adapter = new AwsKmsAdapter({ keyId: "key-1", client });
    await expect(adapter.unwrapKey(Buffer.from("x").toString("base64url"))).rejects.toThrow(/expected 32/);
  });

  it("propagates client errors (e.g. AccessDeniedException) unchanged", async () => {
    const client = fakeClient(async () => {
      throw new Error("AccessDeniedException: not authorized to perform kms:Decrypt");
    });
    const adapter = new AwsKmsAdapter({ keyId: "key-1", client });
    await expect(adapter.unwrapKey(Buffer.from("x").toString("base64url"))).rejects.toThrow(/AccessDeniedException/);
  });
});
