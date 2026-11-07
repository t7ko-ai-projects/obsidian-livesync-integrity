/**
 * AWS Signature Version 4 for S3, on WebCrypto only. Ported from the
 * dependency-free Node signer used by the S3 latency benchmark.
 */
import { hmacSha256, sha256, toHex, utf8 } from "../bytes";

export interface SignRequest {
	method: string;
	/** Host header value, including a non-default port. */
	host: string;
	/** Already URI-encoded absolute path, e.g. "/bucket/a%20b.txt". */
	path: string;
	query?: Record<string, string>;
	/** Extra headers; all of them are signed. */
	headers?: Record<string, string>;
	/** Hex SHA-256 of the body (EMPTY_PAYLOAD_HASH for no body). */
	payloadHash: string;
	accessKey: string;
	secretKey: string;
	region: string;
	now?: Date;
}

export const EMPTY_PAYLOAD_HASH =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** encodeURIComponent plus the characters RFC 3986 reserves that JS leaves alone. */
export function encodeRfc3986(text: string): string {
	return encodeURIComponent(text).replace(
		/[!'()*]/g,
		(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
	);
}

/** Encode an object key for the request path, keeping "/" between segments. */
export function encodeKeyPath(key: string): string {
	return key.split("/").map(encodeRfc3986).join("/");
}

export function amzDate(now: Date): string {
	return now.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

export function canonicalQuery(query: Record<string, string>): string {
	return Object.keys(query)
		.sort()
		.map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k] ?? "")}`)
		.join("&");
}

/**
 * Returns every header to send, including Authorization. The "host" entry is
 * part of the signature; drop it before handing the set to a client that sets
 * Host itself.
 */
export async function sign(req: SignRequest): Promise<Record<string, string>> {
	const now = req.now ?? new Date();
	const stamp = amzDate(now);
	const date = stamp.slice(0, 8);
	const headers: Record<string, string> = {
		host: req.host,
		"x-amz-content-sha256": req.payloadHash,
		"x-amz-date": stamp,
	};
	for (const [k, v] of Object.entries(req.headers ?? {})) {
		headers[k.toLowerCase()] = v.trim();
	}
	const names = Object.keys(headers).sort();
	const canonical = [
		req.method,
		req.path,
		canonicalQuery(req.query ?? {}),
		...names.map((n) => `${n}:${headers[n]}`),
		"",
		names.join(";"),
		req.payloadHash,
	].join("\n");
	const scope = `${date}/${req.region}/s3/aws4_request`;
	const toSign = [
		"AWS4-HMAC-SHA256",
		stamp,
		scope,
		toHex(await sha256(utf8(canonical))),
	].join("\n");
	let key = await hmacSha256(utf8("AWS4" + req.secretKey), utf8(date));
	for (const part of [req.region, "s3", "aws4_request"]) {
		key = await hmacSha256(key, utf8(part));
	}
	const signature = toHex(await hmacSha256(key, utf8(toSign)));
	headers.authorization =
		`AWS4-HMAC-SHA256 Credential=${req.accessKey}/${scope}, ` +
		`SignedHeaders=${names.join(";")}, Signature=${signature}`;
	return headers;
}
