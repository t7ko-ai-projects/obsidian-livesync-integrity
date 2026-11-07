/**
 * Publish the version in manifest.json as a BRAT-compatible GitHub release:
 * the tag equals the version, and main.js, manifest.json and styles.css are
 * attached as separate assets.
 *
 * Usage: node scripts/release-github.mjs [--stable] [--dry-run] [--skip-checks]
 *
 * Releases are marked pre-release unless --stable is given. The token comes
 * from the file named by GITHUB_TOKEN_FILE (or the GITHUB_TOKEN variable) and
 * is never printed. The release is created as a draft, its assets are
 * uploaded and verified, and only then it is published.
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import process from "node:process";

const ASSETS = ["main.js", "manifest.json", "styles.css"];
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const stable = args.has("--stable");

function fail(message) {
	console.error(`Release failed: ${message}`);
	process.exit(1);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function git(...gitArgs) {
	return execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
}

function readToken() {
	const file = process.env.GITHUB_TOKEN_FILE;
	const token = file
		? readFileSync(file, "utf8").replace(/[\r\n]/g, "")
		: process.env.GITHUB_TOKEN;
	if (!token) {
		fail("set GITHUB_TOKEN_FILE (or GITHUB_TOKEN)");
	}
	return token;
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const version = manifest.version;
if (packageJson.version !== version) {
	fail(`package.json is ${packageJson.version}, manifest.json is ${version}`);
}
if (versions[version] !== manifest.minAppVersion) {
	fail(`versions.json does not map ${version} to ${manifest.minAppVersion}`);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	fail(`BRAT needs a plain x.y.z tag, got ${version}`);
}

const branch = git("branch", "--show-current");
if (git("status", "--porcelain") !== "") {
	fail("the working tree is not clean; commit first");
}
const sha = git("rev-parse", "HEAD");
const remote = git("remote", "get-url", "origin");
const match = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(remote);
if (!match) {
	fail(`origin is not a GitHub repository: ${remote}`);
}
const [, owner, repo] = match;

const changelog = readFileSync("CHANGELOG.md", "utf8");
const section = new RegExp(
	`^## ${version.replace(/\./g, "\\.")}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
	"m",
).exec(changelog);
if (!section || !section[1].trim()) {
	fail(`CHANGELOG.md has no "## ${version}" section`);
}
const notes = section[1].trim();

if (!args.has("--skip-checks")) {
	for (const command of ["npm test", "npm run lint", "npm run build"]) {
		console.log(`> ${command}`);
		execSync(command, { stdio: "inherit" });
	}
}
for (const name of ASSETS) {
	const path = `build/${name}`;
	if (statSync(path, { throwIfNoEntry: false })?.size === undefined) {
		fail(`${path} is missing; run npm run build`);
	}
}
const builtVersion = readJson("build/manifest.json").version;
if (builtVersion !== version) {
	fail(`build/manifest.json is ${builtVersion}, expected ${version}`);
}
if (git("status", "--porcelain") !== "") {
	fail("the build changed tracked files; review and commit them first");
}

console.log(
	`${dryRun ? "[dry run] " : ""}Release ${version} of ${owner}/${repo} from ${branch} ` +
		`(${sha.slice(0, 9)}), ${stable ? "stable" : "pre-release"}`,
);
for (const name of ASSETS) {
	console.log(`  ${name}: ${statSync(`build/${name}`).size} bytes`);
}
if (dryRun) {
	console.log("Release notes:\n" + notes);
	process.exit(0);
}

const token = readToken();
const headers = {
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
};
const api = `https://api.github.com/repos/${owner}/${repo}`;

async function call(url, init = {}, expected = [200, 201]) {
	const response = await fetch(url, {
		...init,
		headers: { ...headers, ...init.headers },
	});
	if (!expected.includes(response.status)) {
		fail(`${init.method ?? "GET"} ${url} answered ${response.status}`);
	}
	return response.status === 204 ? null : await response.json();
}

// Push the branch so the tag points at a commit the remote has. The token
// reaches git as an HTTP header, never on the command line.
const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
execFileSync(
	"git",
	["push", `https://github.com/${owner}/${repo}.git`, `${branch}:${branch}`],
	{
		stdio: "inherit",
		env: {
			...process.env,
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
			GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
			GIT_CONFIG_KEY_1: "credential.helper",
			GIT_CONFIG_VALUE_1: "",
			GIT_TERMINAL_PROMPT: "0",
		},
	},
);

const existing = await fetch(`${api}/releases/tags/${version}`, { headers });
if (existing.status !== 404) {
	fail(`a release for ${version} already exists (status ${existing.status})`);
}

const release = await call(`${api}/releases`, {
	method: "POST",
	body: JSON.stringify({
		tag_name: version,
		target_commitish: sha,
		name: version,
		body: notes,
		draft: true,
		prerelease: !stable,
	}),
});
console.log(`Draft release created: ${release.html_url}`);

for (const name of ASSETS) {
	const content = readFileSync(`build/${name}`);
	const uploaded = await call(
		`https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${name}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: content,
		},
	);
	if (uploaded.size !== content.length || uploaded.state !== "uploaded") {
		fail(`asset ${name} was not stored correctly; draft left for review`);
	}
	console.log(`  uploaded ${name}`);
}

const published = await call(`${api}/releases/${release.id}`, {
	method: "PATCH",
	body: JSON.stringify({ draft: false }),
});
console.log(`Published: ${published.html_url}`);
console.log(
	`BRAT: add the repository ${owner}/${repo}; tag ${version} is the version it installs.`,
);
