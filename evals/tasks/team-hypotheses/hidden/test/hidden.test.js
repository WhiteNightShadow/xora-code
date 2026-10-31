import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoiceTotal, lineTotal } from '../src/invoice.js';

test('hidden: discounts before tax', () => {
    assert.equal(lineTotal({ price: 19.99, qty: 2, discount: 3 }), 41.79);
    assert.equal(invoiceTotal([{ price: 10, qty: 3, discount: 5 }, { price: 1.5, qty: 4 }]), 35.03);
});
