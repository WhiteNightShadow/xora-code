import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoiceTotal, lineTotal } from '../src/invoice.js';

test('lines without discount', () => {
    assert.equal(lineTotal({ price: 10, qty: 3 }), 33.9);
    assert.equal(invoiceTotal([{ price: 0.1, qty: 3 }, { price: 0.2, qty: 1 }]), 0.57);
});

test('finance example with a discount', () => {
    // (10 × 3 − 5) × 1.13 = 28.25
    assert.equal(invoiceTotal([{ price: 10, qty: 3, discount: 5 }]), 28.25);
});
