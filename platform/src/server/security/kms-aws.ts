/**
 * Production KMS adapter: AWS KMS envelope wrapping for tenant DEKs.
 *
 * Honest status: this is real, working code, unit-tested against a mocked
 * AWS SDK client (tests/kms-aws.test.ts) covering wrap/unwrap round-trips,
 * key-ref handling and error paths. It has NEVER been exercised against a
 * real AWS account — this sandbox has no AWS credentials. "Tested" here
 * means "the adapter logic is correct against the documented AWS SDK
 * request/response shapes," not "proven in a live AWS environment." Before
 * this adapter is trusted in production: create the KMS key, grant the
 * deployment's IAM role kms:Encrypt/kms:Decrypt/kms:DescribeKey on it, set
 * BIOCHECK_KMS_PROVIDER=aws and BIOCHECK_KMS_KEY_ID, and run the full
 * platform test suite plus a manual wrap/unwrap smoke test against the real
 * key before cutting over any tenant traffic.
 */
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import type { KmsAdapter } from "./kms";

export interface AwsKmsAdapterOptions {
  /** KMS key ID or ARN. Every tenant DEK is wrapped/unwrapped under this key. */
  keyId: string;
  /** AWS region. If omitted, the AWS SDK resolves it the normal way (env/config/instance profile). */
  region?: string;
  /** Injectable client — used by tests to mock AWS. Production wiring omits this and lets the SDK build its own client from ambient credentials. */
  client?: KMSClient;
}

/**
 * Wraps/unwraps tenant DEKs via a real AWS KMS key. keyRef is the key ID
 * itself (never prefixed "local-dev"), so assertProductionKeyConfig() in
 * kms.ts passes and production is allowed to boot on this adapter.
 */
export class AwsKmsAdapter implements KmsAdapter {
  readonly keyRef: string;
  private readonly client: KMSClient;

  constructor(opts: AwsKmsAdapterOptions) {
    if (!opts.keyId) throw new Error("AwsKmsAdapter requires a keyId (KMS key ARN or ID).");
    this.keyRef = opts.keyId;
    this.client = opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {});
  }

  async wrapKey(plainDek: Buffer): Promise<string> {
    const result = await this.client.send(new EncryptCommand({ KeyId: this.keyRef, Plaintext: plainDek }));
    if (!result.CiphertextBlob) throw new Error("AWS KMS Encrypt returned no CiphertextBlob.");
    return Buffer.from(result.CiphertextBlob).toString("base64url");
  }

  async unwrapKey(wrappedDek: string): Promise<Buffer> {
    const ciphertext = Buffer.from(wrappedDek, "base64url");
    const result = await this.client.send(new DecryptCommand({ CiphertextBlob: ciphertext, KeyId: this.keyRef }));
    if (!result.Plaintext) throw new Error("AWS KMS Decrypt returned no Plaintext.");
    const plaintext = Buffer.from(result.Plaintext);
    if (plaintext.length !== 32) {
      throw new Error(`Unwrapped DEK is ${plaintext.length} bytes, expected 32 — refusing to use it.`);
    }
    return plaintext;
  }
}
