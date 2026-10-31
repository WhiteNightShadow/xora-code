const truthy = (value) => ['1', 'true', 'yes'].includes(String(value).toLowerCase());

export const flags = {
    beta: truthy(process.env.FEATURE_BETA ?? 'false'),
};
