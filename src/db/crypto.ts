/** A sealed key that won't open: sealed under another secret or for another row, or corrupted. */
export class ConnectionKeyUnreadable extends Error {
  override name = "ConnectionKeyUnreadable";
  constructor() {
    super("the connection key could not be decrypted");
  }
}

const KEY_VERSION = 1;
const IV_BYTES = 12;

function boundTo(version: number, rowId: string): Uint8Array<ArrayBuffer> {
  const id = new TextEncoder().encode(rowId);
  const data = new Uint8Array(1 + id.byteLength);
  data[0] = version;
  data.set(id, 1);
  return data;
}

/**
 * Seals a deployment key with AES-GCM under `secret`, the value of
 * `CONNECTION_KEY_SECRET`: 32 random bytes, base64 (`openssl rand -base64 32`).
 * A sealed key is the key-version byte, the 96-bit IV, then the ciphertext,
 * authenticated with the version and the id of the row that holds it, so it
 * opens on no other row.
 */
export function keyCipher(secret: string) {
  const raw = Buffer.from(secret, "base64");
  // AES-GCM would also take a 16- or 24-byte key
  if (raw.byteLength !== 32) {
    throw new Error(
      "CONNECTION_KEY_SECRET must be 32 random bytes, base64-encoded",
    );
  }
  const aesKey = crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    async seal(rowId: string, plaintext: string): Promise<Uint8Array> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: boundTo(KEY_VERSION, rowId) },
        await aesKey,
        new TextEncoder().encode(plaintext),
      );
      const sealed = new Uint8Array(1 + IV_BYTES + ciphertext.byteLength);
      sealed[0] = KEY_VERSION;
      sealed.set(iv, 1);
      sealed.set(new Uint8Array(ciphertext), 1 + IV_BYTES);
      return sealed;
    },
    async open(rowId: string, sealed: Uint8Array): Promise<string> {
      const key = await aesKey;
      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: sealed.subarray(1, 1 + IV_BYTES),
            additionalData: boundTo(KEY_VERSION, rowId),
          },
          key,
          sealed.subarray(1 + IV_BYTES),
        );
      } catch {
        throw new ConnectionKeyUnreadable();
      }
      return new TextDecoder().decode(plaintext);
    },
  };
}
