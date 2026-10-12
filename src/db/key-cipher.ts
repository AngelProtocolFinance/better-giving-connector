import type { webcrypto } from "node:crypto";
import { Secret } from "../secret";

// The prefix names the scheme so a later one can be told apart row by row.
const VERSION = "v1";
const AES_INFO = new TextEncoder().encode(
	"better-giving-connector/connection-key/v1",
);
const KID_INFO = new TextEncoder().encode(
	"better-giving-connector/connection-key/kid",
);
const KID_BYTES = 8;
const IV_BYTES = 12;

/** A stored key is corrupt or bound to another row: it can never be read again. */
export class ConnectionKeyUnreadable extends Error {
	override name = "ConnectionKeyUnreadable";

	constructor() {
		super("a connection's stored key could not be decrypted");
	}
}

/**
 * A stored key was sealed under another CONNECTION_KEY_SECRET: the deploy
 * carries the wrong secret, a configuration fault rather than a bad row.
 */
export class ConnectionKeySecretMismatch extends Error {
	override name = "ConnectionKeySecretMismatch";

	constructor() {
		super("a connection's stored key was sealed under another secret");
	}
}

type KeyCipher = {
	seal(key: Secret, aad: string): Promise<string>;
	open(sealed: string, aad: string): Promise<Secret>;
};

type Derived = { aesKey: webcrypto.CryptoKey; kid: string };

// AES-256-GCM under a key derived from CONNECTION_KEY_SECRET; `aad` names the row.
// Sealed as `v1.<kid>.<iv>.<ct>`, where kid identifies the secret without revealing it.
export function keyCipher(cipherSecret: string): KeyCipher {
	let derived: Promise<Derived> | undefined;
	const keys = () => {
		derived ??= derive(cipherSecret);
		return derived;
	};

	return {
		async seal(plain, aad) {
			const { aesKey, kid } = await keys();
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const ct = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: utf8(aad) },
				aesKey,
				utf8(plain.reveal()),
			);
			return [VERSION, kid, b64(iv), b64(new Uint8Array(ct))].join(".");
		},
		async open(sealed, aad) {
			const { aesKey, kid } = await keys();
			const [version, sealedKid, iv, ct, ...rest] = sealed.split(".");
			if (version !== VERSION || !sealedKid || !iv || !ct || rest.length > 0) {
				throw new ConnectionKeyUnreadable();
			}
			if (sealedKid !== kid) throw new ConnectionKeySecretMismatch();
			try {
				const plain = await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: unb64(iv), additionalData: utf8(aad) },
					aesKey,
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

async function derive(cipherSecret: string): Promise<Derived> {
	const ikm = await crypto.subtle.importKey(
		"raw",
		utf8(cipherSecret),
		"HKDF",
		false,
		["deriveKey", "deriveBits"],
	);
	const hkdf = (info: Uint8Array) => ({
		name: "HKDF",
		hash: "SHA-256",
		salt: new Uint8Array(0),
		info,
	});
	const [aesKey, kidBits] = await Promise.all([
		crypto.subtle.deriveKey(
			hkdf(AES_INFO),
			ikm,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		),
		crypto.subtle.deriveBits(hkdf(KID_INFO), ikm, KID_BYTES * 8),
	]);
	return { aesKey, kid: b64(new Uint8Array(kidBits)) };
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
