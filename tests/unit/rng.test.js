import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../../src/core/rng.js';

test('rng is deterministic per seed and in range', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
  }
  const r = new Rng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r.int(3, 9);
    assert.ok(Number.isInteger(v) && v >= 3 && v <= 9);
  }
});

test('rng state round-trips', () => {
  const a = new Rng(99);
  a.next();
  const s = a.getState();
  const v1 = a.next();
  a.setState(s);
  assert.equal(a.next(), v1);
});
