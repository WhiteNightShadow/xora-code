import { bilingual, type Effort, type ModelRef, type Project, RpcError, RpcErrorCode } from '@xora/protocol';
import {
    type ConnectedModel,
    inferFamily,
    type ModelChainEntry,
    modelChain,
    type Organization,
    pickReviewerModel,
    type ResolvedModel,
    SUBSCRIPTION_CHANNEL,
    type Tier,
    type TierEffort,
    tierLabel,
} from '@xora/workflows';
import type { ConnectionService } from './connections.ts';
import type { SettingsService } from './settings.ts';
import { textOf } from './text.ts';

/**
 * Model choice for agents started by the host (team members, workflow steps, the chief, member conversations): the
 * agent's own model, else the user's default model (06 §25), the tier's model chain behind it for errors. With the
 * team setting `models: 'tiers'` a tier's chain over the connected models picks instead (06 §3), falling back to the
 * default model.
 */

const TEXT = bilingual(
    {
        noModel: '还没有可用的模型：先在设置里连接一个模型',
        defaultModel: (tier: Tier, model: string) =>
            `${tierLabel(tier, 'zh-CN')}档的模型链里没有已连接的模型，改用默认模型${model}`,
    },
    {
        noModel: 'No model is available yet: connect one in Settings',
        defaultModel: (tier, model) =>
            `The model chain of the ${tierLabel(tier, 'en')} tier has no connected model; using the default model ${model}`,
    },
);

export interface ModelPick {
    readonly ref: ModelRef;
    readonly family?: string;
    readonly effort: Effort;
    /** The rest of the tier's chain, for model errors. */
    readonly fallbacks: Array<{ ref: ModelRef; family?: string }>;
    /** For a reviewer pick: whether the model is of another family than `reviewerOf`. */
    readonly crossFamily?: boolean;
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

/** Whether agents run on the default model (06 §25) rather than their tier's chain. */
export function followsDefaultModel(sources: ModelSources): boolean {
    return sources.settings.get().team.models !== 'tiers';
}

/**
 * The default model, when agents follow it and it can run here: connected, and for unattended work not a
 * subscription key (06 §12).
 */
function usableDefault(
    sources: ModelSources,
    project: Project,
    available: readonly ConnectedModel[],
    unattended: boolean,
): ConnectedModel | undefined {
    if (!followsDefaultModel(sources)) return undefined;
    const chosen = defaultModel(sources, project);
    if (!chosen) return undefined;
    const connected = available.find(
        (model) => model.connectionId === chosen.connectionId && model.model === chosen.model,
    );
    if (!connected || (unattended && connected.channel === SUBSCRIPTION_CHANNEL)) return undefined;
    return connected;
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
        /** The agent's own models (06 §21), tried before the tier's chain. */
        readonly prefer?: readonly ModelChainEntry[];
    },
): ModelPick {
    const { org, project, tier, warnings } = input;
    const available = connectedModels(sources.connections);
    const own = input.prefer && input.prefer.length > 0;
    const chain = modelChain(tier, org, available, {
        unattended: input.unattended,
        ...(own ? { prefer: input.prefer } : {}),
    });
    // 06 §25: the user's default model for everyone without a model of their own; the tier's chain behind it.
    const usual = own ? undefined : usableDefault(sources, project, available, input.unattended);
    if (usual) {
        const family = usual.family ?? inferFamily(usual.model);
        const reviewerOf = input.reviewerOf?.toLowerCase();
        const fallbacks = [
            ...sources.settings
                .get()
                .fallbackModels.flatMap((ref) =>
                    available.filter(
                        (model) =>
                            model.connectionId === ref.connectionId &&
                            model.model === ref.model &&
                            !(input.unattended && model.channel === SUBSCRIPTION_CHANNEL),
                    ),
                ),
            ...chain,
        ]
            .filter(
                (model, index, list) =>
                    !(model.connectionId === usual.connectionId && model.model === usual.model) &&
                    list.findIndex(
                        (other) => other.connectionId === model.connectionId && other.model === model.model,
                    ) === index,
            )
            .map((model) => ({
                ref: { connectionId: model.connectionId, model: model.model },
                ...(model.family ? { family: model.family } : {}),
            }));
        return {
            ref: { connectionId: usual.connectionId, model: usual.model },
            ...(family ? { family } : {}),
            effort: effortOf(org.tiers[tier].effort),
            fallbacks,
            ...(reviewerOf !== undefined ? { crossFamily: family !== undefined && family !== reviewerOf } : {}),
        };
    }
    const reviewer = input.reviewerOf !== undefined ? pickReviewerModel(input.reviewerOf, chain) : undefined;
    const picked = input.reviewerOf !== undefined ? reviewer?.model : chain[0];
    const toRef = (model: ResolvedModel) => ({
        ref: { connectionId: model.connectionId, model: model.model },
        ...(model.family ? { family: model.family } : {}),
    });
    if (picked) {
        return {
            ...toRef(picked),
            effort: effortOf(picked.effort),
            fallbacks: chain.filter((model) => model !== picked).map(toRef),
            ...(reviewer ? { crossFamily: reviewer.crossFamily } : {}),
        };
    }
    const fallback = defaultModel(sources, project);
    if (!fallback) {
        throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).noModel);
    }
    // Once per run: a warning written before a language switch is in the other language.
    const written = Object.values(TEXT).some((text) => warnings.includes(text.defaultModel(tier, fallback.model)));
    if (!written) {
        warnings.push(textOf(TEXT).defaultModel(tier, fallback.model));
    }
    const family = inferFamily(fallback.model);
    const reviewerOf = input.reviewerOf?.toLowerCase();
    return {
        ref: fallback,
        ...(family ? { family } : {}),
        effort: effortOf(org.tiers[tier].effort),
        fallbacks: [],
        ...(reviewerOf !== undefined ? { crossFamily: family !== undefined && family !== reviewerOf } : {}),
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
    // 06 §25: agents run on the default model when it can run here.
    const usual = usableDefault(sources, project, available, unattended);
    if (usual) return [usual.channel ?? 'custom'];
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
