import { ManagementResult } from '../common/agent-protocol';

type JsonObject = Record<string, unknown>;

export interface McpOverviewServer extends JsonObject {
    name: string;
    transport?: string;
    vendor?: string;
    source?: unknown;
    target?: string;
    scope?: string;
    compatibilityStatus?: string;
    enabled?: boolean;
    status?: 'healthy' | 'unhealthy' | 'enabled' | 'disabled' | 'unknown';
    native?: JsonObject;
    health?: JsonObject;
    discoveredBy: string[];
}

export interface McpManagementOverview extends JsonObject {
    schemaVersion: 1;
    mcpServers: McpOverviewServer[];
    sources: {
        inspect: 'ok' | 'error';
        nativeList: 'ok' | 'error';
        doctor: 'ok' | 'error' | 'not-run';
    };
    diagnostics: {
        ran: boolean;
        healthyCount?: number;
        failingCount?: number;
    };
    warnings: string[];
}

const SECRET_ARGUMENT = /((?:--?|\/)(?:api[-_]?key|access[-_]?key|authorization|cookie|credential|password|secret|token)(?:=|\s+))["']?[^\s"']+["']?/gi;
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH)[A-Z0-9_]*)=([^\s]+)/g;
const SENSITIVE_QUERY = /([?&](?:api[-_]?key|access[-_]?key|authorization|credential|password|secret|token)=)[^&#\s]+/gi;

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    return undefined;
}

/**
 * Management output crosses Electron's privileged boundary. Keep only useful
 * display text and defensively remove common argv/URL credential forms even
 * after the exact-secret redaction performed by the process transport.
 */
export function redactMcpDisplayText(value: string): string {
    return value
        .replace(/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
        .replace(SENSITIVE_QUERY, '$1[REDACTED]')
        .replace(SECRET_ARGUMENT, '$1[REDACTED]')
        .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
        .slice(0, 2_048);
}

function safeString(value: unknown): string | undefined {
    const text = scalarString(value);
    return text ? redactMcpDisplayText(text) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return undefined;
    switch (value.trim().toLowerCase()) {
        case 'true': case 'yes': case 'enabled': case 'healthy': case 'connected': case 'ready': return true;
        case 'false': case 'no': case 'disabled': case 'unhealthy': case 'disconnected': return false;
        default: return undefined;
    }
}

function property(record: JsonObject, aliases: readonly string[]): unknown {
    const normalized = new Set(aliases.map(alias => alias.replace(/[^a-z0-9]/gi, '').toLowerCase()));
    for (const [key, value] of Object.entries(record)) {
        if (normalized.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) return value;
    }
    return undefined;
}

function safeSource(value: unknown): unknown {
    if (typeof value === 'string') return safeString(value);
    if (!isJsonObject(value)) return undefined;
    const output: JsonObject = {};
    for (const key of ['type', 'path', 'scope', 'vendor', 'name']) {
        const field = property(value, [key]);
        const text = safeString(field);
        if (text) output[key] = text;
    }
    return Object.keys(output).length ? output : undefined;
}

function containerEntries(data: unknown, aliases: readonly string[], rootArray = true): unknown[] {
    if (rootArray && Array.isArray(data)) return data;
    if (!isJsonObject(data)) return [];
    const container = property(data, aliases);
    if (Array.isArray(container)) return container;
    if (!isJsonObject(container)) return [];
    return Object.entries(container).map(([name, value]) => isJsonObject(value) ? { name, ...value } : { name, target: value });
}

function serverName(value: unknown): string | undefined {
    return isJsonObject(value) ? safeString(property(value, ['name', 'serverName', 'id', 'label'])) : undefined;
}

function inspectServer(value: unknown): McpOverviewServer | undefined {
    if (!isJsonObject(value)) return undefined;
    const name = serverName(value);
    if (!name) return undefined;
    const compatibilityStatus = safeString(property(value, ['compatibilityStatus', 'status', 'state']));
    const explicitEnabled = booleanValue(property(value, ['enabled', 'active']));
    const enabled = explicitEnabled ?? booleanValue(compatibilityStatus);
    return compact({
        name,
        transport: safeString(property(value, ['transport', 'transportType', 'protocol', 'type'])),
        vendor: safeString(property(value, ['vendor', 'provider', 'originVendor'])),
        source: safeSource(property(value, ['source', 'configSource', 'origin'])),
        target: safeString(property(value, ['target', 'command', 'url', 'endpoint'])),
        scope: safeString(property(value, ['scope', 'level'])),
        compatibilityStatus,
        enabled,
        status: enabled === undefined ? 'unknown' : enabled ? 'enabled' : 'disabled',
        discoveredBy: ['inspect']
    }) as McpOverviewServer;
}

function nativeDetails(value: unknown): JsonObject | undefined {
    if (!isJsonObject(value)) return undefined;
    const details = compact({
        transport: safeString(property(value, ['transport', 'transportType', 'protocol', 'type'])),
        source: safeSource(property(value, ['source', 'configSource', 'origin'])),
        target: safeString(property(value, ['target', 'command', 'url', 'endpoint'])),
        scope: safeString(property(value, ['scope', 'level'])),
        enabled: booleanValue(property(value, ['enabled', 'active'])),
        status: safeString(property(value, ['status', 'state', 'connectionStatus']))
    });
    return Object.keys(details).length ? details : undefined;
}

function safeChecks(value: unknown): JsonObject[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const checks = value.slice(0, 64).flatMap(item => {
        if (!isJsonObject(item)) return [];
        const check = compact({
            label: safeString(property(item, ['label', 'name', 'check'])),
            passed: booleanValue(property(item, ['passed', 'ok', 'healthy', 'success'])),
            detail: safeString(property(item, ['detail', 'message', 'error'])),
            hint: safeString(property(item, ['hint', 'suggestion']))
        });
        return Object.keys(check).length ? [check] : [];
    });
    return checks.length ? checks : undefined;
}

function healthDetails(value: unknown): JsonObject | undefined {
    if (!isJsonObject(value)) return undefined;
    const details = compact({
        healthy: booleanValue(property(value, ['healthy', 'ok', 'success'])),
        status: safeString(property(value, ['status', 'state', 'connectionStatus'])),
        checks: safeChecks(property(value, ['checks', 'diagnostics', 'results']))
    });
    return Object.keys(details).length ? details : undefined;
}

function compact<T extends JsonObject>(value: T): JsonObject {
    return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function resultError(label: string, result: ManagementResult | undefined): string | undefined {
    if (!result || result.ok) return undefined;
    return `${label}：${safeString(result.error) ?? '命令执行失败'}`;
}

function count(data: unknown, aliases: readonly string[]): number | undefined {
    if (!isJsonObject(data)) return undefined;
    const value = property(data, aliases);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Merge final effective discovery with Grok-native configuration and health. */
export function mergeMcpManagementResults(
    inspected: ManagementResult,
    nativeList: ManagementResult,
    doctor?: ManagementResult
): ManagementResult {
    const warnings = [
        resultError('无法读取最终生效配置', inspected),
        resultError('无法读取 Grok 原生 MCP 配置', nativeList),
        resultError('MCP 连接诊断未完成', doctor)
    ].filter((warning): warning is string => Boolean(warning));

    if (!inspected.ok && !nativeList.ok && (!doctor || !doctor.ok)) {
        return { ok: false, error: warnings.join('；') || '无法读取 MCP 配置。' };
    }

    const ordered: McpOverviewServer[] = [];
    const byName = new Map<string, McpOverviewServer>();
    const add = (server: McpOverviewServer): McpOverviewServer => {
        const key = server.name.trim().toLocaleLowerCase();
        const current = byName.get(key);
        if (current) return current;
        ordered.push(server);
        byName.set(key, server);
        return server;
    };

    if (inspected.ok) {
        for (const value of containerEntries(inspected.data, ['mcpServers', 'mcp', 'servers', 'configuredServers'])) {
            const server = inspectServer(value);
            if (server) add(server);
        }
    }

    if (nativeList.ok) {
        for (const value of containerEntries(nativeList.data, ['servers', 'mcpServers', 'items', 'connections'])) {
            const name = serverName(value);
            if (!name) continue;
            const details = nativeDetails(value);
            const server = add({ name, discoveredBy: ['native-list'], status: 'unknown' });
            if (!server.discoveredBy.includes('native-list')) server.discoveredBy.push('native-list');
            if (details) {
                server.native = details;
                server.transport ??= safeString(details.transport);
                server.source ??= details.source;
                server.target ??= safeString(details.target);
                server.scope ??= safeString(details.scope);
                server.enabled ??= booleanValue(details.enabled);
                if (server.status === 'unknown') {
                    const nativeStatus = safeString(details.status);
                    const nativeEnabled = server.enabled ?? booleanValue(nativeStatus);
                    server.status = nativeEnabled === undefined ? 'unknown' : nativeEnabled ? 'enabled' : 'disabled';
                }
            }
        }
    }

    if (doctor?.ok) {
        for (const value of containerEntries(doctor.data, ['servers', 'mcpServers', 'items', 'results'])) {
            const name = serverName(value);
            if (!name) continue;
            const health = healthDetails(value);
            const server = add({ name, discoveredBy: ['doctor'], status: 'unknown' });
            if (!server.discoveredBy.includes('doctor')) server.discoveredBy.push('doctor');
            if (health) {
                server.health = health;
                const healthy = booleanValue(health.healthy);
                if (healthy !== undefined) server.status = healthy ? 'healthy' : 'unhealthy';
            }
        }
    }

    const overview: McpManagementOverview = {
        schemaVersion: 1,
        mcpServers: ordered,
        sources: {
            inspect: inspected.ok ? 'ok' : 'error',
            nativeList: nativeList.ok ? 'ok' : 'error',
            doctor: doctor ? doctor.ok ? 'ok' : 'error' : 'not-run'
        },
        diagnostics: {
            ran: Boolean(doctor),
            ...(doctor?.ok ? {
                healthyCount: count(doctor.data, ['healthy_count', 'healthyCount']),
                failingCount: count(doctor.data, ['failing_count', 'failingCount'])
            } : {})
        },
        warnings
    };
    return { ok: true, data: overview };
}
