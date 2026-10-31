import { type Effort, type ModelRef, type Project, RpcError, RpcErrorCode } from '@xora/protocol';
import {
    type ConnectedModel,
    inferFamily,
    modelChain,
    type Organization,
    pickReviewerModel,
    type ResolvedModel,
    TIER_LABELS,
    type Tier,
    type TierEffort,
} from '@xora/workflows';
import type { ConnectionService } from './connections.ts';
import type { SettingsService } from './settings.ts';

/**
 * Model choice for agents started by the host (team members, workflow steps): a tier's model chain over the
 * connected models (06 §3), falling back to the default model.
 */

export interface ModelPick {
    readonly ref: ModelRef;
    readonly family?: string;
    readonly effort: Effort;
    /** The rest of the tier's chain, for model errors. */
    readonly fallbacks: Array<{ ref: ModelRef; family?: string }>;
}

export interface ModelSources {
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
}

export function effortOf(effort: TierEffort | undefined): Effort {
    return effort === undefined || effort === 'auto' ? 'medium' : effort;
}

/** Every model of an enabled connection that has its key (or needs none). */
export function connectedModels(connections: ConnectionService): ConnectedModel[] {
    const presets = new Map(connections.presets().map((preset) => [preset.id, preset]));
    return connections.list().flatMap((connection) => {
        const preset = presets.get(connection.presetId);
        if (!connection.enabled || (preset?.needsKey !== false && !connection.hasKey)) {
            return [];
        }
        // Custom and local endpoints report their vendor as the family; the model id says more.
        const generic = preset?.channel === 'custom' || preset?.channel === 'local';
        return connection.models.map((model) => ({
            connectionId: connection.id,
            model: model.id,
            presetId: connection.presetId,
            family: (generic ? inferFamily(model.id) : undefined) ?? model.family,
            ...(preset ? { channel: preset.channel } : {}),
        }));
    });
}

export function defaultModel(sources: ModelSources, project: Project): ModelRef | undefined {
    return project.defaults?.model ?? sources.settings.get().defaultModel ?? undefined;
}

/**
 * The tier's first connected model, or for a reviewer the first of another family; the default model with a
 * warning when the chain has nothing connected. `unattended` keeps the chain to API channels (06 §12).
 */
export function pickTierModel(
    sources: ModelSources,
    input: {
        readonly org: Organization;
        readonly project: Project;
        readonly tier: Tier;
        readonly unattended: boolean;
        readonly warnings: string[];
        readonly reviewerOf?: string;
    },
): ModelPick {
    const { org, project, tier, warnings } = input;
    const chain = modelChain(tier, org, connectedModels(sources.connections), { unattended: input.unattended });
    const picked = input.reviewerOf !== undefined ? pickReviewerModel(input.reviewerOf, chain)?.model : chain[0];
    const toRef = (model: ResolvedModel) => ({
        ref: { connectionId: model.connectionId, model: model.model },
        ...(model.family ? { family: model.family } : {}),
    });
    if (picked) {
        return {
            ...toRef(picked),
            effort: effortOf(picked.effort),
            fallbacks: chain.filter((model) => model !== picked).map(toRef),
        };
    }
    const fallback = defaultModel(sources, project);
    if (!fallback) {
        throw new RpcError(RpcErrorCode.Rejected, '还没有可用的模型：先在设置里连接一个模型');
    }
    const warning = `${TIER_LABELS[tier]}档的模型链里没有已连接的模型，改用默认模型${fallback.model}`;
    if (!warnings.includes(warning)) {
        warnings.push(warning);
    }
    const family = inferFamily(fallback.model);
    return {
        ref: fallback,
        ...(family ? { family } : {}),
        effort: effortOf(org.tiers[tier].effort),
        fallbacks: [],
    };
}

/** Channels a run would use, for the L3 and unattended checks: the head of every tier's chain, or the default model's. */
export function runChannels(
    sources: ModelSources,
    org: Organization,
    project: Project,
    unattended: boolean,
    tiers: readonly Tier[] = Object.keys(org.tiers) as Tier[],
): string[] {
    const available = connectedModels(sources.connections);
    const channels = new Set<string>();
    for (const tier of tiers) {
        const head = modelChain(tier, org, available, { unattended })[0];
        if (head) {
            channels.add(head.channel ?? 'custom');
            continue;
        }
        const fallback = defaultModel(sources, project);
        const connection = fallback
            ? available.find((model) => model.connectionId === fallback.connectionId)
            : undefined;
        channels.add(connection?.channel ?? 'custom');
    }
    return [...channels];
}
