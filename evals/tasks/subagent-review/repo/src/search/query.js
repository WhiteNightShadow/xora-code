/** Builds the SQL for a product search from the request's query string. */
export function searchSql(params) {
    const where = params.q ? `where name like '%${params.q}%'` : '';
    const limit = params.limit ? `limit ${params.limit}` : '';
    return `select * from products ${where} order by created_at desc ${limit}`;
}
