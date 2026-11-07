/** Small byte helpers shared by the signer and the manifest crypto. */

const HEX = "0123456789abcdef";

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = "";
	for (const b of view) {
		out += HEX[b >> 4]! + HEX[b & 15]!;
	}
	return out;
}

export function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** A copy of the bytes as a plain ArrayBuffer (WebCrypto rejects shared views). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", toArrayBuffer(data)),
	);
}

export async function hmacSha256(
	key: Uint8Array,
	data: Uint8Array,
): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(
		await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(data)),
	);
}

export function randomBytes(length: number): Uint8Array {
	const out = new Uint8Array(length);
	crypto.getRandomValues(out);
	return out;
}
