import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { shouldPublish } from './publish-gate.mjs';

test('publishes when local version differs from npm', () => {
	assert.equal(shouldPublish('1.1.3', '1.1.2'), true);
});

test('skips when local version matches npm (idempotency / loop guard)', () => {
	assert.equal(shouldPublish('1.1.2', '1.1.2'), false);
});

test('publishes when the package has never been published', () => {
	assert.equal(shouldPublish('1.1.2', ''), true);
});
