/** Sum of price × quantity, minus each line's discount, rounded to cents. */
export function calcTotal(lines) {
    const cents = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.qty - (line.discount ?? 0) * 100, 0);
    return cents / 100;
}

export function addLine(cart, line) {
    return { ...cart, lines: [...cart.lines, line] };
}
