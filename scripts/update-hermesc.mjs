#!/usr/bin/env node
// Inspects every published version of @unbound-mod/hermesc, groups them by the
// actual HBC bytecode version their binaries emit (not their npm semver, which
// is unrelated), and keeps the newest npm version for each of the last N
// distinct bytecode versions. package.json is updated to alias each held
// bytecode version to its npm version via `npm:` protocol dependencies, so
// multiple hermesc binaries can be installed side by side.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@unbound-mod/hermesc';
const HELD_VERSIONS = 3;
const ALIAS_PREFIX = 'hermesc-';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(rootDir, 'package.json');
const manifestPath = join(rootDir, 'hermesc-versions.json');

function compareSemver(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);

	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pb[i] - pa[i];
	}

	return 0;
}

async function fetchPublishedVersions() {
	const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`);
	if (!res.ok) throw new Error(`Failed to fetch npm metadata for ${PACKAGE_NAME}: ${res.status}`);

	const data = await res.json();
	return Object.keys(data.versions).sort(compareSemver);
}

export function getBytecodeVersion(npmVersion) {
	const workDir = mkdtempSync(join(tmpdir(), 'hermesc-'));

	try {
		execFileSync('npm', ['pack', `${PACKAGE_NAME}@${npmVersion}`, '--silent', '--pack-destination', workDir], { stdio: 'pipe' });

		const tarball = readdirSync(workDir).find((file) => file.endsWith('.tgz'));
		if (!tarball) throw new Error(`npm pack did not produce a tarball for ${npmVersion}`);

		execFileSync('tar', ['-xzf', tarball, '-C', workDir], { cwd: workDir });

		const bin = join(workDir, 'package', 'linux', 'hermesc');
		execFileSync('chmod', ['+x', bin]);

		const output = execFileSync(bin, ['-version'], { encoding: 'utf-8' });
		const match = output.match(/HBC bytecode version:\s*(\d+)/);
		if (!match) throw new Error(`Could not parse bytecode version from hermesc -version output for ${npmVersion}`);

		return Number(match[1]);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

// Walks candidate npm versions newest-first, deriving each one's real bytecode
// version, and keeps the newest npm version per distinct bucket up to
// HELD_VERSIONS. A candidate whose binary can't be inspected fails the run
// loudly instead of being skipped - a silent skip could drop a bytecode version
// that should have been held. Pure over its injected `getBytecodeVersion` so the
// selection logic is testable without touching npm/the network.
export function selectHeldVersions({ versions, getBytecodeVersion }) {
	const held = new Map(); // bytecodeVersion -> npmVersion, newest npm version wins per bucket

	for (const npmVersion of versions) {
		if (held.size >= HELD_VERSIONS) break;

		let bytecodeVersion;
		try {
			bytecodeVersion = getBytecodeVersion(npmVersion);
		} catch (e) {
			throw new Error(`Could not inspect hermesc ${npmVersion}: ${e.message}. Refusing to drop a bytecode version silently.`, { cause: e });
		}

		if (!held.has(bytecodeVersion)) held.set(bytecodeVersion, npmVersion);
	}

	if (held.size === 0) throw new Error('Could not determine the bytecode version of any published hermesc release.');

	return held;
}

export function bumpPatch(version) {
	const [major, minor, patch] = version.split('.').map(Number);
	return `${major}.${minor}.${patch + 1}`;
}

// Given the previous package.json/manifest sources and the selected held map,
// rewrites the hermesc-* aliases and the manifest, and bumps the package version
// (patch) - but only when the held set actually changed, so replayed dispatches
// and no-op runs neither move the version nor open a PR. `changed` is computed
// from the alias/manifest delta before the version is touched, so the bump can't
// make an unchanged run look changed. Pure so the bump gate is tested off npm.
export function buildUpdatedSources({ previousPkgSource, previousManifestSource, held }) {
	const heldVersions = [...held.keys()].sort((a, b) => b - a);

	const pkg = JSON.parse(previousPkgSource);

	for (const key of Object.keys(pkg.dependencies)) {
		if (key.startsWith(ALIAS_PREFIX)) delete pkg.dependencies[key];
	}

	for (const bytecodeVersion of heldVersions) {
		pkg.dependencies[`${ALIAS_PREFIX}${bytecodeVersion}`] = `npm:${PACKAGE_NAME}@${held.get(bytecodeVersion)}`;
	}

	pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));

	const nextManifestSource = JSON.stringify(heldVersions, null, '\t') + '\n';

	// Compare against the previous package.json with only the aliases swapped in -
	// i.e. before the version bump - so `changed` reflects the dependency/manifest
	// delta alone, not the bump we are about to apply.
	const depsChanged = JSON.stringify(pkg, null, '\t') + '\n' !== previousPkgSource;
	const changed = depsChanged || nextManifestSource !== previousManifestSource;

	if (changed) pkg.version = bumpPatch(pkg.version);

	const nextPkgSource = JSON.stringify(pkg, null, '\t') + '\n';

	return { nextPkgSource, nextManifestSource, changed, heldVersions };
}

async function main() {
	const versions = await fetchPublishedVersions();
	const held = selectHeldVersions({ versions, getBytecodeVersion });

	const previousPkgSource = readFileSync(pkgPath, 'utf-8');
	const previousManifestSource = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : '';

	const { nextPkgSource, nextManifestSource, changed, heldVersions } = buildUpdatedSources({
		previousPkgSource,
		previousManifestSource,
		held,
	});

	if (changed) {
		writeFileSync(pkgPath, nextPkgSource);
		writeFileSync(manifestPath, nextManifestSource);
	}

	console.log(`Held bytecode versions: ${heldVersions.join(', ')}`);

	if (process.env.GITHUB_OUTPUT) {
		writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nversions=${heldVersions.join(', ')}\n`, { flag: 'a' });
	}
}

// Only run when invoked directly, so tests can import the pure helpers above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
