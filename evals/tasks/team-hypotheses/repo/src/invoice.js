/**
 * Invoice totals. Finance's rule: a line's discount comes off before tax, so a line costs
 * (price × qty − discount) × (1 + TAX_RATE), rounded to cents; the invoice is the sum of its lines.
 * Prices are in yuan with at most two decimals.
 */
export const TAX_RATE = 0.13;

function cents(value) {
    return Math.round(value * 100) / 100;
}

export function lineTotal(line) {
    const net = line.price * line.qty;
    const taxed = cents(net * (1 + TAX_RATE));
    return cents(taxed - (line.discount ?? 0));
}

export function invoiceTotal(lines) {
    return cents(lines.reduce((sum, line) => sum + lineTotal(line), 0));
}
