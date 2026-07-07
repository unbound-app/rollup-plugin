#!/usr/bin/env node
// Decides whether the publish workflow should run `npm publish`. The gate is a
// pure version comparison: publish only when package.json's version differs from
// what's on npm. This is the idempotency / loop guard - unrelated pushes to main
// and replayed events (same version already published) skip cleanly instead of
// attempting a duplicate publish. A package that isn't on npm yet (no published
// version) always publishes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function shouldPublish(localVersion, publishedVersion) {
	if (!publishedVersion) return true; // never published - first publish
	return localVersion !== publishedVersion;
}

// Reads the version npm has for a package, returning '' when the package (or
// this version line) isn't published yet. `npm view <pkg> version` exits
// non-zero for a package that has never been published; that's the first-publish
// case, not an error.
function fetchPublishedVersion(pkgName) {
	try {
		return execFileSync('npm', ['view', pkgName, 'version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

function main() {
	const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
	const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));

	const publishedVersion = fetchPublishedVersion(pkg.name);
	const publish = shouldPublish(pkg.version, publishedVersion);

	console.log(`local=${pkg.version} published=${publishedVersion || '(none)'} -> ${publish ? 'publish' : 'skip'}`);

	if (process.env.GITHUB_OUTPUT) {
		writeFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\nversion=${pkg.version}\n`, { flag: 'a' });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
