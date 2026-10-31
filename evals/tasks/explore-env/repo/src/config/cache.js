export const cache = {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    ttlSeconds: parseInt(process.env.CACHE_TTL || '300', 10),
};
