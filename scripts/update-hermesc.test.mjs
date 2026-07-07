import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { selectHeldVersions, buildUpdatedSources, bumpPatch } from './update-hermesc.mjs';

const basePkg = {
	name: '@unbound-app/rollup-plugin-hermes',
	version: '1.1.2',
	dependencies: {
		'hermesc-94': 'npm:@unbound-mod/hermesc@1.0.1',
		'hermesc-96': 'npm:@unbound-mod/hermesc@1.0.3',
	},
};

const pkgSource = (pkg) => JSON.stringify(pkg, null, '\t') + '\n';
const manifestSource = (versions) => JSON.stringify(versions, null, '\t') + '\n';

test('keeps the newest npm version per distinct bytecode bucket', () => {
	// Newest npm version per bucket wins; versions arrive newest-first (as sorted upstream).
	const bytecode = { '1.0.3': 96, '1.0.2': 96, '1.0.1': 94 };

	const held = selectHeldVersions({
		versions: ['1.0.3', '1.0.2', '1.0.1'],
		getBytecodeVersion: (v) => bytecode[v],
	});

	assert.deepEqual(held, new Map([[96, '1.0.3'], [94, '1.0.1']]));
});

test('holds at most HELD_VERSIONS distinct buckets', () => {
	const bytecode = { '4.0.0': 99, '3.0.0': 98, '2.0.0': 97, '1.0.0': 96 };

	const held = selectHeldVersions({
		versions: ['4.0.0', '3.0.0', '2.0.0', '1.0.0'],
		getBytecodeVersion: (v) => bytecode[v],
	});

	assert.equal(held.size, 3);
	assert.deepEqual([...held.keys()], [99, 98, 97]);
});

test('fails loud (does not silently skip) when a candidate binary cannot be inspected', () => {
	assert.throws(
		() => selectHeldVersions({
			versions: ['2.0.0', '1.0.0'],
			getBytecodeVersion: (v) => {
				if (v === '2.0.0') throw new Error('missing linux/ platform dir');
				return 94;
			},
		}),
		(err) => {
			// Must name the offending version and the underlying reason.
			assert.match(err.message, /2\.0\.0/);
			assert.match(err.message, /missing linux\/ platform dir/);
			return true;
		},
	);
});

test('throws when no versions are published at all', () => {
	assert.throws(
		() => selectHeldVersions({ versions: [], getBytecodeVersion: () => 96 }),
		/could not determine/i,
	);
});

test('bumpPatch increments only the patch segment', () => {
	assert.equal(bumpPatch('1.1.2'), '1.1.3');
	assert.equal(bumpPatch('2.0.9'), '2.0.10');
});

test('no-op when held versions are unchanged: not changed, no version bump', () => {
	const held = new Map([[96, '1.0.3'], [94, '1.0.1']]);

	const result = buildUpdatedSources({
		previousPkgSource: pkgSource(basePkg),
		previousManifestSource: manifestSource([96, 94]),
		held,
	});

	assert.equal(result.changed, false);
	assert.deepEqual(result.heldVersions, [96, 94]);
	// Version must not move when nothing changed - keeps replayed dispatches idempotent.
	assert.equal(JSON.parse(result.nextPkgSource).version, '1.1.2');
});

test('held versions changed: bumps patch and rewrites aliases + manifest', () => {
	// A new bytecode bucket (97 via npm 1.0.4) appears; 94 falls off the end.
	const held = new Map([[97, '1.0.4'], [96, '1.0.3'], [94, '1.0.1']]);

	const result = buildUpdatedSources({
		previousPkgSource: pkgSource(basePkg),
		previousManifestSource: manifestSource([96, 94]),
		held,
	});

	assert.equal(result.changed, true);
	assert.deepEqual(result.heldVersions, [97, 96, 94]);

	const nextPkg = JSON.parse(result.nextPkgSource);
	assert.equal(nextPkg.version, '1.1.3');
	assert.deepEqual(nextPkg.dependencies, {
		'hermesc-94': 'npm:@unbound-mod/hermesc@1.0.1',
		'hermesc-96': 'npm:@unbound-mod/hermesc@1.0.3',
		'hermesc-97': 'npm:@unbound-mod/hermesc@1.0.4',
	});
	assert.equal(result.nextManifestSource, manifestSource([97, 96, 94]));
});

test('missing previous manifest counts as changed', () => {
	const held = new Map([[96, '1.0.3'], [94, '1.0.1']]);

	const result = buildUpdatedSources({
		previousPkgSource: pkgSource(basePkg),
		previousManifestSource: '',
		held,
	});

	assert.equal(result.changed, true);
	assert.equal(JSON.parse(result.nextPkgSource).version, '1.1.3');
});
