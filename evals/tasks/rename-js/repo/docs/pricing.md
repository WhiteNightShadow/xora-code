# Pricing

`calcTotal(lines)` returns the cart total in yuan: price × quantity for each line, minus the line's discount.
Checkout, the daily report and the quote API all call calcTotal, so they always agree.
