import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { selectHeldVersions } from './update-hermesc.mjs';

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
