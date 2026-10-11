import type { webcrypto } from "node:crypto";
import { Secret } from "../secret";

// The prefix names the scheme so a later one can be told apart row by row.
const VERSION = "v1";
const HKDF_INFO = new TextEncoder().encode(
	"better-giving-connector/connection-key/v1",
);
const IV_BYTES = 12;

export class ConnectionKeyUnreadable extends Error {
	override name = "ConnectionKeyUnreadable";

	constructor() {
		super("a connection's stored key could not be decrypted");
	}
}

type KeyCipher = {
	seal(key: Secret, aad: string): Promise<string>;
	open(sealed: string, aad: string): Promise<Secret>;
};

// AES-256-GCM under a key derived from CONNECTION_KEY_SECRET; `aad` names the row.
export function keyCipher(cipherSecret: string): KeyCipher {
	let aesKey: Promise<webcrypto.CryptoKey> | undefined;
	const key = () => {
		aesKey ??= deriveKey(cipherSecret);
		return aesKey;
	};

	return {
		async seal(plain, aad) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const ct = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: utf8(aad) },
				await key(),
				utf8(plain.reveal()),
			);
			return [VERSION, b64(iv), b64(new Uint8Array(ct))].join(".");
		},
		async open(sealed, aad) {
			try {
				const [version, iv, ct, ...rest] = sealed.split(".");
				if (version !== VERSION || !iv || !ct || rest.length > 0) {
					throw new ConnectionKeyUnreadable();
				}
				const plain = await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: unb64(iv), additionalData: utf8(aad) },
					await key(),
					unb64(ct),
				);
				return new Secret(new TextDecoder().decode(plain));
			} catch {
				// a fixed message: the cause could echo ciphertext or key material
				throw new ConnectionKeyUnreadable();
			}
		},
	};
}

async function deriveKey(cipherSecret: string): Promise<webcrypto.CryptoKey> {
	const ikm = await crypto.subtle.importKey(
		"raw",
		utf8(cipherSecret),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
		ikm,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
