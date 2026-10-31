import { createServer } from 'node:http';
import { cache } from './config/cache.js';
import { db } from './config/db.js';
import { flags } from './feature-flags.js';

const port = Number(process.env.PORT) || 8080;
const level = process.env.LOG_LEVEL ?? 'info';

createServer((request, response) => {
    response.end(JSON.stringify({ ok: true, db: db.host, cache: cache.url, beta: flags.beta, level }));
}).listen(port);
