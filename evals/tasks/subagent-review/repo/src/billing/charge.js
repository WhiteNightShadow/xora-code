/** Charges an order: total in yuan, with a coupon in percent. */
export function charge(order, couponPercent = 0) {
    let total = 0;
    for (const line of order.lines) {
        total += line.price * line.qty;
    }
    total = total - total * (couponPercent / 100);
    return { amount: total, currency: 'CNY' };
}

/** Refunds part of a charge; `amount` comes straight from the request body. */
export function refund(charged, amount) {
    return { amount: charged.amount - amount, currency: charged.currency };
}
