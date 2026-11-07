/**
 * Keys derived from the LiveSync E2EE passphrase, and the encrypted manifest
 * container: [version 1][salt 16][iv 12][AES-256-GCM ciphertext].
 */
import { concat, randomBytes, toArrayBuffer, utf8 } from "../bytes";

const FORMAT_VERSION = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 100_000;
/** Fixed salt so every device derives the same file-hash key. */
const HASH_KEY_SALT = "t7-livesync-integrity/hmac/v1";

async function passphraseKey(passphrase: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		toArrayBuffer(utf8(passphrase)),
		"PBKDF2",
		false,
		["deriveBits", "deriveKey"],
	);
}

function pbkdf2(salt: Uint8Array): Pbkdf2Params {
	return {
		name: "PBKDF2",
		salt: toArrayBuffer(salt),
		iterations: PBKDF2_ITERATIONS,
		hash: "SHA-256",
	};
}

/** The HMAC key used for file hashes; identical on every device. */
export async function deriveHashKey(passphrase: string): Promise<CryptoKey> {
	const base = await passphraseKey(passphrase);
	return crypto.subtle.deriveKey(
		pbkdf2(utf8(HASH_KEY_SALT)),
		base,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign"],
	);
}

export async function hashFile(
	key: CryptoKey,
	content: ArrayBuffer,
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, content),
	);
	let out = "";
	for (const b of digest) {
		out += b.toString(16).padStart(2, "0");
	}
	return out;
}

async function aesKey(
	passphrase: string,
	salt: Uint8Array,
): Promise<CryptoKey> {
	const base = await passphraseKey(passphrase);
	return crypto.subtle.deriveKey(
		pbkdf2(salt),
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptBytes(
	passphrase: string,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	const salt = randomBytes(SALT_LENGTH);
	const iv = randomBytes(IV_LENGTH);
	const key = await aesKey(passphrase, salt);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: toArrayBuffer(iv) },
			key,
			toArrayBuffer(plaintext),
		),
	);
	return concat(new Uint8Array([FORMAT_VERSION]), salt, iv, ciphertext);
}

export class ManifestFormatError extends Error {}

export async function decryptBytes(
	passphrase: string,
	container: Uint8Array,
): Promise<Uint8Array> {
	const headerLength = 1 + SALT_LENGTH + IV_LENGTH;
	if (container.length <= headerLength) {
		throw new ManifestFormatError("manifest is too short");
	}
	if (container[0] !== FORMAT_VERSION) {
		throw new ManifestFormatError(
			`unknown manifest container version ${container[0]}`,
		);
	}
	const salt = container.subarray(1, 1 + SALT_LENGTH);
	const iv = container.subarray(1 + SALT_LENGTH, headerLength);
	const key = await aesKey(passphrase, salt);
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: toArrayBuffer(iv) },
				key,
				toArrayBuffer(container.subarray(headerLength)),
			),
		);
	} catch {
		throw new ManifestFormatError(
			"cannot decrypt the manifest (different passphrase or damaged file)",
		);
	}
}
