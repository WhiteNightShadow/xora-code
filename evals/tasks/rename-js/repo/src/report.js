import * as cart from './cart.js';

/** One line per cart: id and total (calcTotal of its lines). */
export function report(carts) {
    return carts.map((item) => `${item.id}: ${cart.calcTotal(item.lines).toFixed(2)}`).join('\n');
}
