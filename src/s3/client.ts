/**
 * The few S3 operations the plugin needs (PUT, GET, LIST of one prefix) over
 * Obsidian's requestUrl, so they work on desktop and Android without CORS.
 */
import { requestUrl, type RequestUrlParam } from "obsidian";
import { sha256, toHex } from "../bytes";
import {
	EMPTY_PAYLOAD_HASH,
	canonicalQuery,
	encodeKeyPath,
	sign,
} from "./sigv4";

export interface S3Credentials {
	endpoint: string;
	region: string;
	bucket: string;
	accessKey: string;
	secretKey: string;
	forcePathStyle: boolean;
	customHeaders: Record<string, string>;
}

export interface S3Object {
	key: string;
	size: number;
	lastModified: string;
}

export interface S3Response {
	status: number;
	body: Uint8Array;
	text: string;
}

export type RequestFn = (params: RequestUrlParam) => Promise<{
	status: number;
	arrayBuffer: ArrayBuffer;
	text: string;
}>;

export class S3Error extends Error {
	constructor(
		public readonly operation: string,
		public readonly status: number,
		detail: string,
	) {
		super(`S3 ${operation} answered ${status}: ${detail}`);
	}
}

/** Parse LiveSync's "Header-Name: Value" lines into a header map. */
export function parseCustomHeaders(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) {
			continue;
		}
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (name && value) {
			out[name] = value;
		}
	}
	return out;
}

function decodeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) =>
			String.fromCodePoint(parseInt(n, 16)),
		)
		.replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | undefined {
	const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
	return match ? decodeXml(match[1] ?? "") : undefined;
}

/** Parse a ListObjectsV2 response; URL-encoded keys are decoded. */
export function parseListResponse(xml: string): {
	objects: S3Object[];
	nextToken?: string;
} {
	const objects: S3Object[] = [];
	const encoded = tag(xml, "EncodingType") === "url";
	for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const block = match[1] ?? "";
		let key = tag(block, "Key") ?? "";
		if (encoded) {
			key = decodeURIComponent(key);
		}
		objects.push({
			key,
			size: Number(tag(block, "Size") ?? 0),
			lastModified: tag(block, "LastModified") ?? "",
		});
	}
	const truncated = tag(xml, "IsTruncated") === "true";
	return {
		objects,
		nextToken: truncated ? tag(xml, "NextContinuationToken") : undefined,
	};
}

export class S3Client {
	private readonly url: URL;

	constructor(
		private readonly creds: S3Credentials,
		private readonly request: RequestFn = requestUrl,
	) {
		this.url = new URL(creds.endpoint);
	}

	/** Host header and absolute URL for one key (or "" for the bucket). */
	target(key: string): { host: string; path: string; url: string } {
		const basePath = this.url.pathname.replace(/\/+$/, "");
		const encodedKey = encodeKeyPath(key);
		if (this.creds.forcePathStyle) {
			const path = `${basePath}/${this.creds.bucket}/${encodedKey}`;
			return {
				host: this.url.host,
				path,
				url: `${this.url.protocol}//${this.url.host}${path}`,
			};
		}
		const host = `${this.creds.bucket}.${this.url.host}`;
		const path = `${basePath}/${encodedKey}`;
		return { host, path, url: `${this.url.protocol}//${host}${path}` };
	}

	private async call(
		operation: string,
		method: string,
		key: string,
		query: Record<string, string>,
		body?: Uint8Array,
		extraHeaders: Record<string, string> = {},
	): Promise<S3Response> {
		const { host, path, url } = this.target(key);
		const payloadHash = body
			? toHex(await sha256(body))
			: EMPTY_PAYLOAD_HASH;
		const signed = await sign({
			method,
			host,
			path,
			query,
			headers: { ...this.creds.customHeaders, ...extraHeaders },
			payloadHash,
			accessKey: this.creds.accessKey,
			secretKey: this.creds.secretKey,
			region: this.creds.region,
		});
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(signed)) {
			if (name !== "host") {
				headers[name] = value;
			}
		}
		const queryString = canonicalQuery(query);
		const response = await this.request({
			url: queryString ? `${url}?${queryString}` : url,
			method,
			headers,
			body: body ? body.slice().buffer : undefined,
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new S3Error(
				operation,
				response.status,
				response.text.slice(0, 300),
			);
		}
		return {
			status: response.status,
			body: new Uint8Array(response.arrayBuffer),
			text: response.text,
		};
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		await this.call("PUT", "PUT", key, {}, body, {
			"content-type": "application/octet-stream",
		});
	}

	async get(key: string): Promise<Uint8Array> {
		return (await this.call("GET", "GET", key, {})).body;
	}

	/** Every object under the prefix, following continuation tokens. */
	async list(prefix: string): Promise<S3Object[]> {
		const objects: S3Object[] = [];
		let token: string | undefined;
		do {
			const query: Record<string, string> = { "list-type": "2", prefix };
			if (token) {
				query["continuation-token"] = token;
			}
			const response = await this.call("LIST", "GET", "", query);
			const page = parseListResponse(response.text);
			objects.push(...page.objects);
			token = page.nextToken;
		} while (token);
		return objects;
	}
}
