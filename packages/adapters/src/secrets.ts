import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/** Encrypts tenant secrets. The tenant is bound to the ciphertext: a value copied to
 * another tenant's row cannot be decrypted there. */
export interface SecretCipher {
  encrypt(plaintext: string, tenantId: string): Promise<string>;
  decrypt(ciphertext: string, tenantId: string): Promise<string>;
}

export class KmsSecretCipher implements SecretCipher {
  constructor(private readonly keyId: string, private readonly kms = new KMSClient({})) {}
  async encrypt(plaintext: string, tenantId: string) {
    const result = await this.kms.send(new EncryptCommand({
      KeyId: this.keyId, Plaintext: new TextEncoder().encode(plaintext), EncryptionContext: { tenantId },
    }));
    return `kms:${Buffer.from(result.CiphertextBlob!).toString("base64")}`;
  }
  async decrypt(ciphertext: string, tenantId: string) {
    if (!ciphertext.startsWith("kms:")) throw new Error("Secret was not encrypted with KMS");
    const result = await this.kms.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext.slice(4), "base64"), EncryptionContext: { tenantId },
    }));
    return new TextDecoder().decode(result.Plaintext);
  }
}

/** Development only: AES-256-GCM with a key from LOCAL_SECRET_KEY, tenant as authenticated data. */
export class LocalSecretCipher implements SecretCipher {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("LOCAL_SECRET_KEY must be 32 bytes, base64 encoded");
  }
  async encrypt(plaintext: string, tenantId: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv).setAAD(Buffer.from(tenantId));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `local:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
  }
  async decrypt(ciphertext: string, tenantId: string) {
    if (!ciphertext.startsWith("local:")) throw new Error("Secret was not encrypted with the local key");
    const raw = Buffer.from(ciphertext.slice(6), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12)).setAAD(Buffer.from(tenantId));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** KMS when SECRET_KMS_KEY_ID is set; the local key only outside production. */
export function secretCipherFromEnv(environment: Readonly<Record<string, string | undefined>> = process.env): SecretCipher {
  if (environment.SECRET_KMS_KEY_ID) return new KmsSecretCipher(environment.SECRET_KMS_KEY_ID);
  if (environment.NODE_ENV !== "production" && environment.LOCAL_SECRET_KEY) return new LocalSecretCipher(environment.LOCAL_SECRET_KEY);
  throw new Error("Configure SECRET_KMS_KEY_ID (or LOCAL_SECRET_KEY outside production) to store store credentials");
}
