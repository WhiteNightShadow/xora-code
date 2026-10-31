const env = process.env;

export const db = {
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5432),
    name: env.DB_NAME ?? 'orders',
};
