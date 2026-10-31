import { calcTotal as total } from '../cart.js';

export function quote(request) {
    return { status: 200, body: { total: total(request.body.lines) } };
}
