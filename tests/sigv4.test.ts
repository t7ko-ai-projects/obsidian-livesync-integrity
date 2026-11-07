import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_PAYLOAD_HASH, encodeKeyPath, sign } from "../src/s3/sigv4";
import {
	describeErrorBody,
	MAX_LIST_PAGES,
	parseCustomHeaders,
	parseListResponse,
	S3Client,
} from "../src/s3/client";

const AWS_EXAMPLE = {
	accessKey: "AKIAIOSFODNN7EXAMPLE",
	secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
	now: new Date("2013-05-24T00:00:00Z"),
};

test("matches the AWS SigV4 GET object example", async () => {
	const headers = await sign({
		method: "GET",
		host: "examplebucket.s3.amazonaws.com",
		path: "/test.txt",
		headers: { Range: "bytes=0-9" },
		payloadHash: EMPTY_PAYLOAD_HASH,
		...AWS_EXAMPLE,
	});
	assert.equal(headers["x-amz-date"], "20130524T000000Z");
	assert.equal(
		headers.authorization,
		"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
			"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
			"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
	);
});

test("matches the AWS SigV4 list objects example", async () => {
	const headers = await sign({
		method: "GET",
		host: "examplebucket.s3.amazonaws.com",
		path: "/",
		query: { "max-keys": "2", prefix: "J" },
		payloadHash: EMPTY_PAYLOAD_HASH,
		...AWS_EXAMPLE,
	});
	assert.match(
		headers.authorization ?? "",
		/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/,
	);
});

test("encodes keys per segment with RFC 3986 reserved characters", () => {
	assert.equal(encodeKeyPath("a b/c'(d)*!.md"), "a%20b/c%27%28d%29%2A%21.md");
});

test("builds path-style and virtual-host URLs", () => {
	const base = {
		region: "r",
		bucket: "b",
		accessKey: "a",
		secretKey: "s",
		customHeaders: {},
	};
	const pathStyle = new S3Client({
		...base,
		endpoint: "http://127.0.0.1:9000",
		forcePathStyle: true,
	});
	assert.deepEqual(pathStyle.target("x/y z.json"), {
		host: "127.0.0.1:9000",
		path: "/b/x/y%20z.json",
		url: "http://127.0.0.1:9000/b/x/y%20z.json",
	});
	const virtualHost = new S3Client({
		...base,
		endpoint: "https://s3.example.com/",
		forcePathStyle: false,
	});
	assert.deepEqual(virtualHost.target(""), {
		host: "b.s3.example.com",
		path: "/",
		url: "https://b.s3.example.com/",
	});
});

test("parses LiveSync custom header lines", () => {
	assert.deepEqual(
		parseCustomHeaders("X-A: 1\r\nbad line\n X-B :two:three\n"),
		{
			"X-A": "1",
			"X-B": "two:three",
		},
	);
});

test("parses a ListObjectsV2 page with entities and continuation", () => {
	const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
		<NextContinuationToken>tok&amp;1</NextContinuationToken>
		<Contents><Key>p/_integrity/a&amp;b.json</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>12</Size></Contents>
		<Contents><Key>p/_integrity/c.json</Key><Size>3</Size></Contents></ListBucketResult>`;
	const page = parseListResponse(xml);
	assert.equal(page.nextToken, "tok&1");
	assert.deepEqual(
		page.objects.map((o) => [o.key, o.size]),
		[
			["p/_integrity/a&b.json", 12],
			["p/_integrity/c.json", 3],
		],
	);
	assert.equal(page.malformed, 0);
	assert.equal(
		parseListResponse("<ListBucketResult></ListBucketResult>").nextToken,
		undefined,
	);
});

test("an undecodable listing entry is skipped, not fatal", () => {
	const xml =
		"<R><EncodingType>url</EncodingType>" +
		"<Contents><Key>bad&#99999999999;</Key><Size>1</Size></Contents>" +
		"<Contents><Key>bad%E0%A4%A</Key><Size>1</Size></Contents>" +
		"<Contents><Key>ok%20key</Key><Size>x</Size></Contents>" +
		"<Contents><Key>ok%20key</Key><Size>2</Size></Contents></R>";
	const page = parseListResponse(xml);
	assert.deepEqual(
		page.objects.map((o) => [o.key, o.size]),
		[["ok key", 2]],
	);
	assert.equal(page.malformed, 3);
});

test("error bodies are reduced to code and a short message", () => {
	assert.equal(
		describeErrorBody(
			"<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided. Check your key and signing method.</Message><StringToSign>AWS4-HMAC-SHA256 secret</StringToSign></Error>",
		),
		"SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. C",
	);
	assert.equal(
		describeErrorBody("<Error><Code>AccessDenied</Code></Error>"),
		"AccessDenied",
	);
	assert.equal(
		describeErrorBody("<html>nginx 502</html>"),
		"no error code in the response",
	);
	assert.equal(
		describeErrorBody(
			"<Error><Code>X\u0007y</Code><Message>é</Message></Error>",
		),
		"X?y: ?",
	);
});

test("listing stops on a repeated continuation token or too many pages", async () => {
	const stuck = new S3Client(
		{
			endpoint: "https://s3.example.com",
			region: "eu",
			bucket: "vault",
			accessKey: "a",
			secretKey: "s",
			forcePathStyle: true,
			customHeaders: {},
		},
		async () => ({
			status: 200,
			text: "<R><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></R>",
			arrayBuffer: new ArrayBuffer(0),
		}),
	);
	await assert.rejects(stuck.list("p/"), /did not advance/);
	let pages = 0;
	const endless = new S3Client(
		{
			endpoint: "https://s3.example.com",
			region: "eu",
			bucket: "vault",
			accessKey: "a",
			secretKey: "s",
			forcePathStyle: true,
			customHeaders: {},
		},
		async () => {
			pages += 1;
			return {
				status: 200,
				text: `<R><IsTruncated>true</IsTruncated><NextContinuationToken>t${pages}</NextContinuationToken></R>`,
				arrayBuffer: new ArrayBuffer(0),
			};
		},
	);
	await assert.rejects(endless.list("p/"), /more than 100 pages/);
	assert.equal(pages, MAX_LIST_PAGES);
});

test("sends signed requests and follows continuation tokens", async () => {
	const calls: {
		url: string;
		method: string;
		headers: Record<string, string>;
	}[] = [];
	const client = new S3Client(
		{
			endpoint: "https://s3.example.com",
			region: "eu",
			bucket: "vault",
			accessKey: "a",
			secretKey: "s",
			forcePathStyle: true,
			customHeaders: { "X-Custom": "yes" },
		},
		async (params) => {
			calls.push({
				url: params.url,
				method: params.method ?? "GET",
				headers: params.headers ?? {},
			});
			const text =
				calls.length === 1
					? "<R><IsTruncated>true</IsTruncated><NextContinuationToken>n/1</NextContinuationToken><Contents><Key>k1</Key><Size>1</Size></Contents></R>"
					: "<R><Contents><Key>k2</Key><Size>1</Size></Contents></R>";
			return { status: 200, text, arrayBuffer: new ArrayBuffer(0) };
		},
	);
	const listing = await client.list("pre/_integrity/");
	assert.deepEqual(
		listing.objects.map((o) => o.key),
		["k1", "k2"],
	);
	assert.equal(
		calls[0]?.url,
		"https://s3.example.com/vault/?list-type=2&prefix=pre%2F_integrity%2F",
	);
	assert.equal(
		calls[1]?.url,
		"https://s3.example.com/vault/?continuation-token=n%2F1&list-type=2&prefix=pre%2F_integrity%2F",
	);
	const headers = calls[0]?.headers ?? {};
	assert.equal(headers.host, undefined);
	assert.equal(headers["x-custom"], "yes");
	assert.match(
		headers.authorization ?? "",
		/SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-custom,/,
	);
});

test("reports S3 errors with status and operation", async () => {
	const client = new S3Client(
		{
			endpoint: "https://s3.example.com",
			region: "eu",
			bucket: "vault",
			accessKey: "a",
			secretKey: "s",
			forcePathStyle: false,
			customHeaders: {},
		},
		async () => ({
			status: 403,
			text: "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>",
			arrayBuffer: new ArrayBuffer(0),
		}),
	);
	await assert.rejects(
		client.get("k"),
		/^Error: S3 GET answered 403 \(AccessDenied: denied\)$/,
	);
});

test("get rejects a body above the size limit", async () => {
	const client = new S3Client(
		{
			endpoint: "https://s3.example.com",
			region: "eu",
			bucket: "vault",
			accessKey: "a",
			secretKey: "s",
			forcePathStyle: true,
			customHeaders: {},
		},
		async () => ({
			status: 200,
			text: "",
			arrayBuffer: new ArrayBuffer(10),
		}),
	);
	await assert.rejects(client.get("k", 9), /larger than 9 bytes/);
	assert.equal((await client.get("k", 10)).length, 10);
});
