import type { ConnectionConfig } from '@xora/engine';
import { type PriceTable, priceTableFor } from '@xora/metering';
import {
    bilingual,
    type Connection,
    type ModelOption,
    type ModelRef,
    type ModelSummary,
    type PresetSummary,
    RpcError,
    RpcErrorCode,
} from '@xora/protocol';
import {
    getPreset,
    listModels,
    listPresets,
    type ModelInfo,
    type ProviderConnection,
    type ProviderPreset,
    testConnection,
} from '@xora/providers';
import { fromJson, toJson, type XoraDatabase } from '@xora/storage';
import type { Bus } from './bus.ts';
import { newId } from './ids.ts';
import type { Logger } from './log.ts';
import type { ShellApi } from './shell.ts';
import { textOf } from './text.ts';

const TEXT = bilingual(
    {
        notAllowed: '该通道的条款不允许xora直连',
        disabled: (name: string) => `模型连接「${name}」已停用`,
        noKey: (name: string) => `模型连接「${name}」还没有填写key`,
        noModels: '这个连接还没有可用的模型，先刷新模型列表',
    },
    {
        notAllowed: 'The terms of this channel do not allow direct use by Xora',
        disabled: (name) => `The model connection "${name}" is disabled`,
        noKey: (name) => `The model connection "${name}" has no key yet`,
        noModels: 'This connection has no models yet; refresh the model list first',
    },
);

interface ConnectionRow {
    id: string;
    preset_id: string;
    name: string;
    base_url: string | null;
    has_key: number;
    enabled: number;
    models_json: string | null;
    status_json: string | null;
    created_at: number;
}

export function modelSummary(model: ModelInfo): ModelSummary {
    return {
        id: model.id,
        name: model.name,
        family: model.family,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        input: [...model.input],
        reasoning: {
            mode: model.reasoning.mode,
            efforts: [...model.reasoning.efforts],
            defaultEffort: model.reasoning.defaultEffort,
        },
        tools: model.tools,
        ...(model.pricing ? { pricing: model.pricing } : {}),
        ...(model.verified ? { verified: model.verified } : {}),
        ...(model.deprecated ? { deprecated: model.deprecated } : {}),
    };
}

export function presetSummary(preset: ProviderPreset): PresetSummary {
    const baseUrl = preset.endpoints[preset.defaultWire];
    return {
        id: preset.id,
        name: preset.name,
        vendor: preset.vendor,
        channel: preset.channel,
        ...(preset.region ? { region: preset.region } : {}),
        wire: preset.defaultWire,
        ...(baseUrl ? { baseUrl } : {}),
        needsKey: preset.auth !== 'none',
        models: preset.models.map(modelSummary),
        ...(preset.compliance ? { compliance: { ...preset.compliance } } : {}),
        ...(preset.links ? { links: { ...preset.links } } : {}),
        ...(preset.verified ? { verified: preset.verified } : {}),
    };
}

/** A model discovered through `/models` that the preset does not describe: conservative defaults. */
function discoveredModel(id: string, family: string, contextWindow?: number, maxOutput?: number): ModelInfo {
    return {
        id,
        name: id,
        family,
        contextWindow: contextWindow ?? 128_000,
        maxOutput: maxOutput ?? 8192,
        input: ['text'],
        reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
        tools: true,
    };
}

const secretName = (connectionId: string) => `connection.${connectionId.toLowerCase()}`;

/**
 * Model connections: a provider preset, the user's key (kept by the bootstrap in the OS keychain, never in
 * the database or logs) and models discovered through `/models`.
 */
export class ConnectionService {
    readonly #db: XoraDatabase;
    readonly #shell: ShellApi;
    readonly #bus: Bus;
    readonly #log: Logger;
    readonly #userAgent: string;
    readonly #keys = new Map<string, string | null>();

    constructor(db: XoraDatabase, shell: ShellApi, bus: Bus, log: Logger, userAgent: string) {
        this.#db = db;
        this.#shell = shell;
        this.#bus = bus;
        this.#log = log;
        this.#userAgent = userAgent;
    }

    presets(): PresetSummary[] {
        return listPresets().map(presetSummary);
    }

    #row(connectionId: string): ConnectionRow {
        const row = this.#db.get<ConnectionRow>('select * from connections where id = ?', [connectionId]);
        if (!row) {
            throw new RpcError(RpcErrorCode.NotFound, `connection not found: ${connectionId}`);
        }
        return row;
    }

    #preset(row: ConnectionRow): ProviderPreset {
        const preset = getPreset(row.preset_id);
        if (!preset) {
            throw new RpcError(RpcErrorCode.NotFound, `provider preset not found: ${row.preset_id}`);
        }
        return preset;
    }

    #extraModels(row: ConnectionRow): ModelInfo[] {
        return fromJson<ModelInfo[]>(row.models_json, []);
    }

    #toConnection(row: ConnectionRow): Connection {
        const preset = getPreset(row.preset_id);
        const models = [...(preset?.models ?? []), ...this.#extraModels(row)];
        const status = fromJson<Connection['status'] | null>(row.status_json, null);
        return {
            id: row.id,
            presetId: row.preset_id,
            name: row.name,
            ...(row.base_url ? { baseUrl: row.base_url } : {}),
            hasKey: row.has_key === 1,
            enabled: row.enabled === 1,
            models: models.map(modelSummary),
            createdAt: row.created_at,
            ...(status ? { status } : {}),
        };
    }

    list(): Connection[] {
        return this.#db
            .all<ConnectionRow>('select * from connections order by created_at')
            .map((row) => this.#toConnection(row));
    }

    get(connectionId: string): Connection {
        return this.#toConnection(this.#row(connectionId));
    }

    async save(input: {
        connectionId?: string;
        presetId: string;
        name?: string;
        apiKey?: string;
        baseUrl?: string;
        enabled?: boolean;
    }): Promise<Connection> {
        const preset = getPreset(input.presetId);
        if (!preset) {
            throw new RpcError(RpcErrorCode.Rejected, `unknown provider preset ${input.presetId}`);
        }
        if (preset.compliance?.allowed === false) {
            throw new RpcError(RpcErrorCode.Rejected, preset.compliance.note ?? textOf(TEXT).notAllowed);
        }
        const baseUrl = input.baseUrl?.trim() || undefined;
        if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
            throw new RpcError(RpcErrorCode.InvalidParams, 'base url must start with http:// or https://');
        }
        const now = Date.now();
        let id = input.connectionId;
        if (id) {
            const row = this.#row(id);
            this.#db.run('update connections set name = ?, base_url = ?, enabled = ?, updated_at = ? where id = ?', [
                input.name ?? row.name,
                baseUrl === undefined ? row.base_url : baseUrl,
                input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
                now,
                id,
            ]);
        } else {
            id = newId('c');
            this.#db.run(
                'insert into connections (id, preset_id, name, base_url, enabled, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
                [id, preset.id, input.name ?? preset.name, baseUrl ?? null, input.enabled === false ? 0 : 1, now, now],
            );
        }
        if (input.apiKey !== undefined) {
            const key = input.apiKey.trim();
            if (key.length > 0) {
                await this.#shell.setSecret(secretName(id), key);
                this.#keys.set(id, key);
            } else {
                await this.#shell.deleteSecret(secretName(id));
                this.#keys.set(id, null);
            }
            this.#db.run('update connections set has_key = ? where id = ?', [key.length > 0 ? 1 : 0, id]);
        }
        this.#bus.broadcast('connection.changed', {});
        return this.get(id);
    }

    async remove(connectionId: string): Promise<void> {
        this.#row(connectionId);
        await this.#shell.deleteSecret(secretName(connectionId));
        this.#keys.delete(connectionId);
        this.#db.run('delete from connections where id = ?', [connectionId]);
        this.#bus.broadcast('connection.changed', {});
    }

    async #key(connectionId: string): Promise<string | undefined> {
        if (!this.#keys.has(connectionId)) {
            this.#keys.set(connectionId, await this.#shell.getSecret(secretName(connectionId)));
        }
        return this.#keys.get(connectionId) ?? undefined;
    }

    /** Engine-facing configuration, including the key. Never log the result. */
    async engineConfig(connectionId: string): Promise<ConnectionConfig> {
        const row = this.#row(connectionId);
        if (row.enabled !== 1) {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).disabled(row.name));
        }
        const preset = this.#preset(row);
        const apiKey = await this.#key(connectionId);
        if (preset.auth !== 'none' && !apiKey) {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).noKey(row.name));
        }
        const extraModels = this.#extraModels(row);
        return {
            presetId: preset.id,
            ...(apiKey ? { apiKey } : {}),
            ...(row.base_url ? { baseUrl: row.base_url } : {}),
            ...(extraModels.length > 0
                ? { extraModels: extraModels as unknown as ConnectionConfig['extraModels'] }
                : {}),
        };
    }

    async providerConnection(connectionId: string): Promise<ProviderConnection> {
        const row = this.#row(connectionId);
        const preset = this.#preset(row);
        const apiKey = await this.#key(connectionId);
        const extraModels = this.#extraModels(row);
        return {
            preset,
            ...(apiKey ? { apiKey } : {}),
            ...(row.base_url ? { baseUrl: row.base_url } : {}),
            ...(extraModels.length > 0 ? { extraModels } : {}),
        };
    }

    model(ref: ModelRef): ModelSummary | undefined {
        return this.get(ref.connectionId).models.find((model) => model.id === ref.model);
    }

    /** The price table of a model's requests ({@link priceTableFor}); for a removed connection, by model id alone. */
    priceTable(ref: ModelRef): PriceTable | undefined {
        const connection = this.list().find((item) => item.id === ref.connectionId);
        return priceTableFor({
            id: ref.model,
            pricing: connection?.models.find((model) => model.id === ref.model)?.pricing,
            channel: connection ? getPreset(connection.presetId)?.channel : undefined,
        });
    }

    async test(
        connectionId: string,
        model?: string,
    ): Promise<{ ok: boolean; latencyMs?: number; ttftMs?: number; message?: string; errorClass?: string }> {
        const connection = await this.providerConnection(connectionId);
        const modelId = model ?? this.get(connectionId).models[0]?.id;
        if (!modelId) {
            return { ok: false, message: textOf(TEXT).noModels };
        }
        const result = await testConnection(connection, modelId, { userAgent: this.#userAgent });
        const status = {
            ok: result.ok,
            checkedAt: Date.now(),
            ...(result.error ? { message: result.error.message, errorClass: result.error.errorClass } : {}),
        };
        this.#db.run('update connections set status_json = ? where id = ?', [JSON.stringify(status), connectionId]);
        this.#bus.broadcast('connection.changed', {});
        this.#log.info(`connection ${connectionId} test ${result.ok ? 'ok' : `failed (${result.error?.errorClass})`}`);
        return {
            ok: result.ok,
            ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
            ...(result.ttftMs !== undefined ? { ttftMs: result.ttftMs } : {}),
            ...(result.error ? { message: result.error.message, errorClass: result.error.errorClass } : {}),
        };
    }

    /** Fetches `/models` and records models the preset does not already describe. */
    async refreshModels(connectionId: string): Promise<Connection> {
        const row = this.#row(connectionId);
        const preset = this.#preset(row);
        const remote = await listModels(await this.providerConnection(connectionId), { userAgent: this.#userAgent });
        const known = new Set(preset.models.map((model) => model.id));
        const extra = remote
            .filter((model) => !known.has(model.id))
            .map((model) => discoveredModel(model.id, preset.vendor, model.contextWindow, model.maxOutput));
        this.#db.run('update connections set models_json = ?, updated_at = ? where id = ?', [
            toJson(extra),
            Date.now(),
            connectionId,
        ]);
        this.#bus.broadcast('connection.changed', {});
        return this.get(connectionId);
    }

    options(): ModelOption[] {
        return this.list()
            .filter((connection) => connection.enabled)
            .flatMap((connection) =>
                connection.models.map((model) => ({
                    connectionId: connection.id,
                    connectionName: connection.name,
                    presetId: connection.presetId,
                    model,
                })),
            );
    }
}
