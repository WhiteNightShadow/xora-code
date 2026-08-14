import {
    AgentModelOption,
    PROVIDER_DEFAULT_MODEL_CHOICE_ID,
    ProviderProfile,
    RuntimeSnapshot,
    SessionRecord,
    XAI_MANAGED_MODEL_ID
} from '../common/agent-protocol';

export { XAI_MANAGED_MODEL_ID } from '../common/agent-protocol';
export { PROVIDER_DEFAULT_MODEL_CHOICE_ID } from '../common/agent-protocol';

export interface AgentModelChoice {
    providerId: string;
    modelId: string;
    label: string;
    value: string;
}

export interface AgentModelChoiceGroup {
    providerId: string;
    providerName: string;
    choices: AgentModelChoice[];
}

const MODEL_CHOICE_PREFIX = 'xora-model:';
const MODEL_CONFIGURATION_PREFIX = 'xora-model-configuration:';

/** Keep upstream model ids intact on the wire while presenting stable product copy. */
export function agentModelDisplayName(modelId: string, advertisedName?: string): string {
    if (advertisedName && advertisedName !== modelId) return advertisedName;
    return modelId === 'grok-build' ? 'Grok Build' : advertisedName ?? modelId;
}

/**
 * A model id is not globally unique: two relay profiles can both target
 * `grok-4.5`. Keep the Provider identity in the DOM value without exposing
 * endpoint or credential data.
 */
export function encodeAgentModelChoice(providerId: string, modelId: string): string {
    return `${MODEL_CHOICE_PREFIX}${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
}

export function decodeAgentModelChoice(value: string): { providerId: string; modelId: string } | undefined {
    if (!value.startsWith(MODEL_CHOICE_PREFIX)) return undefined;
    const separator = value.indexOf(':', MODEL_CHOICE_PREFIX.length);
    if (separator < 0) return undefined;
    try {
        const providerId = decodeURIComponent(value.slice(MODEL_CHOICE_PREFIX.length, separator));
        const modelId = decodeURIComponent(value.slice(separator + 1));
        return providerId && modelId ? { providerId, modelId } : undefined;
    } catch {
        return undefined;
    }
}

/** One native selector can present a model and, beneath it, the reasoning
 * levels advertised for that exact model. Keep the encoded value opaque so a
 * future server-defined reasoning token cannot collide with a model id. */
export function encodeAgentModelConfiguration(modelChoice: string, reasoningEffort?: string): string {
    return `${MODEL_CONFIGURATION_PREFIX}${encodeURIComponent(modelChoice)}:${encodeURIComponent(reasoningEffort ?? '')}`;
}

export function decodeAgentModelConfiguration(
    value: string
): { modelChoice: string; reasoningEffort?: string } | undefined {
    if (!value.startsWith(MODEL_CONFIGURATION_PREFIX)) return undefined;
    const separator = value.indexOf(':', MODEL_CONFIGURATION_PREFIX.length);
    if (separator < 0) return undefined;
    try {
        const modelChoice = decodeURIComponent(value.slice(MODEL_CONFIGURATION_PREFIX.length, separator));
        const reasoningEffort = decodeURIComponent(value.slice(separator + 1));
        return modelChoice ? { modelChoice, reasoningEffort: reasoningEffort || undefined } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * API profiles are represented in Grok's ACP model catalog by a safe local
 * alias. Their `profile.model` is the upstream relay model id and must never
 * be sent to ACP as though it were the catalog id.
 */
export function providerCatalogModelId(provider: ProviderProfile): string | undefined {
    if (!provider.model) return undefined;
    if (provider.kind === 'custom') return provider.id;
    if (provider.kind === 'xai-api-key') return XAI_MANAGED_MODEL_ID;
    return undefined;
}

export function agentModelChoiceGroups(
    providers: ProviderProfile[],
    snapshot: RuntimeSnapshot,
    active?: SessionRecord
): AgentModelChoiceGroup[] {
    // `xai-api-key` is retained only for backend upgrade compatibility. It is
    // never a current user-selectable service or model group.
    const providerById = new Map(providers
        .filter(provider => provider.kind !== 'xai-api-key')
        .map(provider => [provider.id, provider]));
    const catalogOwners = new Map<string, ProviderProfile>();
    for (const provider of providers) {
        const catalogId = providerCatalogModelId(provider);
        if (catalogId) catalogOwners.set(catalogId, provider);
    }

    const groups: AgentModelChoiceGroup[] = [];
    const provider = providerById.get(snapshot.providerId);
    if (provider) {
        const catalogId = providerCatalogModelId(provider);
        const choices: AgentModelChoice[] = [];

        if (catalogId) {
            const advertised = snapshot.models.find(model => model.id === catalogId);
            choices.push(choice(provider, catalogId, advertised, provider.model ?? provider.name));
        } else {
            // Subscription and legacy key-only profiles use the models
            // advertised by their current ACP runtime. Exclude aliases owned
            // by other credential profiles so selecting a model can never use
            // a key that was not injected into this sidecar process.
            for (const model of snapshot.models) {
                // The legacy managed xAI alias is deliberately absent from the
                // user-facing Provider list, so filter it explicitly as well.
                if (model.id === XAI_MANAGED_MODEL_ID || catalogOwners.has(model.id)) continue;
                choices.push(choice(provider, model.id, model));
            }
            // SessionRecord.model describes history; only the application-wide
            // runtime selection may drive the selector or seed a new session.
            const selected = snapshot.selectedModel;
            if (selected
                && selected !== XAI_MANAGED_MODEL_ID
                && !catalogOwners.has(selected)
                && !choices.some(candidate => candidate.modelId === selected)) {
                choices.unshift(choice(provider, selected, undefined, selected));
            }
        }

        if (choices.length > 0) {
            groups.push({ providerId: provider.id, providerName: provider.name, choices });
        }
    }

    // The first render can precede listProviders(). Do not infer credential
    // ownership from an ACP catalogue alone: it can contain aliases belonging
    // to retired or other custom Providers. The selector appears as soon as
    // Electron returns the current non-secret Provider metadata.
    return groups;
}

export function selectedAgentModelChoice(
    groups: AgentModelChoiceGroup[],
    snapshot: RuntimeSnapshot,
    active?: SessionRecord,
    pendingNewSessionModel?: string
): string {
    const current = groups.find(group => group.providerId === snapshot.providerId);
    if (!current?.choices.length) return '';
    const provider = current.choices[0];
    // Fixed API profiles have exactly one safe catalog alias.
    if (current.choices.length === 1) return provider.value;
    const selected = active
        ? snapshot.selectedModel
        : pendingNewSessionModel ?? snapshot.selectedModel;
    return current.choices.find(choice => choice.modelId === selected)?.value ?? provider.value;
}

function choice(
    provider: ProviderProfile,
    modelId: string,
    advertised?: AgentModelOption,
    fallbackLabel?: string
): AgentModelChoice {
    const candidateLabel = fallbackLabel ?? advertised?.name;
    return {
        providerId: provider.id,
        modelId,
        label: agentModelDisplayName(modelId, candidateLabel),
        value: encodeAgentModelChoice(provider.id, modelId)
    };
}
