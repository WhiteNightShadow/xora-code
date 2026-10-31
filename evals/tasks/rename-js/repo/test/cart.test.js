import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quote } from '../src/api/handlers.js';
import { calcTotal } from '../src/cart.js';
import { checkout } from '../src/checkout.js';
import { report } from '../src/report.js';

const lines = [
    { price: 2.5, qty: 2 },
    { price: 0.1, qty: 3, discount: 0.1 },
];

test('calcTotal adds lines and discounts', () => {
    assert.equal(calcTotal(lines), 5.2);
});

test('checkout, report and quote use the same total', () => {
    assert.deepEqual(checkout({ lines }, { amount: 10 }), { ok: true, change: 4.8 });
    assert.equal(report([{ id: 'a', lines }]), 'a: 5.20');
    assert.deepEqual(quote({ body: { lines } }).body, { total: 5.2 });
});
