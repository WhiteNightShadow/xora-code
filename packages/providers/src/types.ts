/**
 * Contract between the xora engine and model vendors. Vendor differences live in data (presets and quirks),
 * not in engine code: the engine only ever builds a {@link ModelRequest} and consumes {@link ModelEvent}s.
 */

/** Wire protocol spoken by an endpoint. */
export type Wire = 'openai_chat' | 'anthropic_messages';

/** How the user pays for a connection. Official-agent subscriptions are engines, not providers. */
export type Channel = 'api' | 'subscription_key' | 'local' | 'custom';

export type Region = 'cn' | 'global';

/** Effort levels used across xora. Each preset maps them onto the vendor's own values. */
export type Effort = 'off' | 'low' | 'medium' | 'high' | 'max';
export type ReasoningEffort = Exclude<Effort, 'off'>;

export type InputModality = 'text' | 'image';

export interface ReasoningSpec {
    /** `none`: the model never reasons; `always`: reasoning cannot be turned off; `toggle`: it can. */
    readonly mode: 'none' | 'always' | 'toggle';
    /** xora effort levels the model accepts, weakest first. Empty when the vendor has no effort knob. */
    readonly efforts: readonly ReasoningEffort[];
    readonly defaultEffort: Effort;
}

export interface ModelInfo {
    /** Model id sent to the vendor. The same model can have different ids on different channels. */
    readonly id: string;
    readonly name: string;
    /** Model family, used for cross-family review and for deciding when history must be summarised first. */
    readonly family: string;
    readonly contextWindow: number;
    readonly maxOutput: number;
    readonly input: readonly InputModality[];
    readonly reasoning: ReasoningSpec;
    readonly tools: boolean;
    /** Price table id in `@xora/metering`. */
    readonly pricing?: string;
    /** Overrides applied on top of the preset's quirks. */
    readonly quirks?: Quirks;
    /** Date the facts were checked against official documentation, e.g. `2026-10-29`. Absent: unverified. */
    readonly verified?: string;
    /** Set when the vendor has announced retirement. */
    readonly deprecated?: string;
}

/** How thinking and effort are expressed in a request body. */
export type ThinkingStyle =
    /** No thinking parameters are ever sent. */
    | { readonly kind: 'none' }
    /** deepseek: `thinking: {type: 'enabled' | 'disabled'}` plus `reasoning_effort`. */
    | { readonly kind: 'deepseek' }
    /** kimi k3: no `thinking` parameter; only `reasoning_effort`. */
    | { readonly kind: 'kimi' }
    /** glm: `thinking: {type, clear_thinking}` plus `reasoning_effort`; `preserve` keeps earlier reasoning. */
    | { readonly kind: 'glm'; readonly preserve: boolean }
    /** openai-style: `reasoning_effort` only. */
    | { readonly kind: 'openai' }
    /**
     * anthropic current models: `thinking: {type: 'adaptive', display: 'summarized'}` plus
     * `output_config: {effort}`. `offMode` says how "off" is expressed: `between_tools` (sonnet 5.5),
     * `disabled`, or `unsupported` (opus 5.5: lowest effort instead).
     */
    | { readonly kind: 'anthropic_adaptive'; readonly offMode: 'between_tools' | 'disabled' | 'unsupported' }
    /** anthropic legacy models: `thinking: {type: 'enabled', budget_tokens}`. */
    | { readonly kind: 'anthropic_budget' };

export type ToolChoiceKind = 'auto' | 'none' | 'required' | 'function';

export interface Quirks {
    /** Field carrying streamed reasoning in openai_chat deltas and assistant messages. */
    readonly reasoningField?: 'reasoning_content' | 'reasoning' | 'none';
    /**
     * Whether earlier assistant reasoning is sent back:
     * - `never`: stripped
     * - `with_tools`: on every assistant message once the conversation has used tools (deepseek)
     * - `always`: always (kimi echoes the whole message; glm preserved thinking)
     */
    readonly reasoningEcho?: 'never' | 'with_tools' | 'always';
    readonly thinking?: ThinkingStyle;
    /** Vendor value for each xora effort level. Levels missing here fall back to the nearest supported one. */
    readonly effortMap?: Readonly<Partial<Record<ReasoningEffort, string>>>;
    /** `tool_choice` values the endpoint accepts. Anything else is downgraded to `auto`. */
    readonly toolChoice?: readonly ToolChoiceKind[];
    /** `tool_choice` values accepted while thinking is on (deepseek: auto and none). */
    readonly toolChoiceWhenThinking?: readonly ToolChoiceKind[];
    /** Body fields that must never be sent (kimi k3 rejects any temperature or top_p). */
    readonly omitParams?: readonly string[];
    /** Body fields that are ignored while thinking is on and therefore not sent. */
    readonly omitParamsWhenThinking?: readonly string[];
    readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
    /** How the usage object is laid out. */
    readonly usage?: 'openai' | 'deepseek' | 'kimi' | 'glm' | 'anthropic';
    /** Whether `stream_options: {include_usage: true}` is accepted. */
    readonly streamUsage?: boolean;
    /** Anthropic wire only: `auto` puts cache breakpoints after the system prefix and on the last message. */
    readonly cacheControl?: 'none' | 'auto';
    /**
     * Vendor business error codes mapped to error classes (glm 1261, 1302, …). Keys are matched against the code and
     * the type of the error body (kimi `engine_overloaded_error`); a key `http:<status>` reclassifies a bare HTTP
     * status for a vendor that, for example, reports an exhausted plan as 403.
     */
    readonly errorCodes?: Readonly<Record<string, ErrorClass>>;
    /** Static fields merged into every request body (for example kimi `prompt_cache_options`). */
    readonly extraBody?: Readonly<Record<string, unknown>>;
    readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface Compliance {
    /** Subscription keys that may only back interactive use, never unattended runs. */
    readonly interactiveOnly?: boolean;
    /** False when the vendor's terms do not allow xora to use this channel directly (glm coding plan). */
    readonly allowed?: boolean;
    readonly note?: string;
}

export interface ProviderPreset {
    /** Stable id, e.g. `deepseek`, `kimi-cn`, `kimi-code-cn`, `glm-cn`. */
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly channel: Channel;
    readonly region?: Region;
    /** Base URL per wire, without the trailing operation path (`/chat/completions`, `/v1/messages`). */
    readonly endpoints: Readonly<Partial<Record<Wire, string>>>;
    readonly defaultWire: Wire;
    readonly auth: 'bearer' | 'x-api-key' | 'none';
    readonly models: readonly ModelInfo[];
    readonly quirks: Quirks;
    readonly compliance?: Compliance;
    readonly links?: { readonly docs?: string; readonly keys?: string; readonly pricing?: string };
    readonly verified?: string;
}

/** A configured connection: a preset plus the user's key and overrides. */
export interface ProviderConnection {
    readonly preset: ProviderPreset;
    readonly apiKey?: string;
    /** Overrides the preset endpoint for the chosen wire. */
    readonly baseUrl?: string;
    readonly wire?: Wire;
    readonly headers?: Readonly<Record<string, string>>;
    /** Models the user added or discovered through `/models`. */
    readonly extraModels?: readonly ModelInfo[];
}

export type UserPart =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly mimeType: string; readonly data: string };

export type AssistantPart =
    | { readonly type: 'text'; readonly text: string }
    /**
     * Reasoning exactly as the vendor produced it. `signature` and `redacted` are opaque anthropic fields that
     * must be sent back unchanged; reasoning is only ever replayed to the provider and model that produced it.
     */
    | { readonly type: 'reasoning'; readonly text: string; readonly signature?: string; readonly redacted?: string }
    /** `arguments` is the raw JSON text the model produced. */
    | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: string };

export interface UserMessage {
    readonly role: 'user';
    readonly content: readonly UserPart[];
}

export interface AssistantMessage {
    readonly role: 'assistant';
    readonly content: readonly AssistantPart[];
    /** Preset id and model id that produced the message; reasoning is only echoed back to the same pair. */
    readonly provider: string;
    readonly model: string;
}

export interface ToolResultMessage {
    readonly role: 'tool';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: readonly UserPart[];
    readonly isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSpec {
    readonly name: string;
    readonly description: string;
    /** JSON Schema of the arguments object. */
    readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
    readonly model: string;
    /** System prompt segments, most stable first. Joined for openai_chat, separate blocks for anthropic. */
    readonly system: readonly string[];
    readonly messages: readonly Message[];
    readonly tools?: readonly ToolSpec[];
    readonly toolChoice?: 'auto' | 'none' | 'required' | { readonly name: string };
    readonly effort?: Effort;
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly topP?: number;
}

export interface Usage {
    /** All prompt tokens, cached ones included. */
    readonly inputTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    /** All completion tokens, reasoning included. */
    readonly outputTokens: number;
    readonly reasoningTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'content_filter' | 'pause' | 'other';

export type ModelEvent =
    | { readonly type: 'start'; readonly model: string; readonly requestId?: string }
    | { readonly type: 'text_delta'; readonly text: string }
    | { readonly type: 'reasoning_delta'; readonly text: string }
    | { readonly type: 'tool_call_start'; readonly index: number; readonly id: string; readonly name: string }
    | { readonly type: 'tool_call_delta'; readonly index: number; readonly delta: string }
    | {
          readonly type: 'done';
          readonly stopReason: StopReason;
          /** Vendor stop reason before normalisation. */
          readonly rawStopReason?: string;
          readonly message: AssistantMessage;
          /** Undefined when the vendor sent no usage; callers then estimate. */
          readonly usage?: Usage;
          readonly requestId?: string;
          readonly ttftMs?: number;
          readonly latencyMs: number;
      };

export type ErrorClass =
    | 'auth'
    | 'quota'
    | 'rate_limit'
    | 'overloaded'
    | 'context_length'
    | 'invalid_request'
    | 'permission'
    | 'not_found'
    | 'network'
    | 'timeout'
    | 'server'
    | 'content_filter'
    | 'cancelled'
    | 'unknown';

export interface StreamOptions {
    readonly signal?: AbortSignal;
    /** Injected for tests; defaults to the global fetch. */
    readonly fetch?: typeof fetch;
    /** Truthful client identifier, e.g. `XoraCode/1.0.0`. Never impersonates another client. */
    readonly userAgent?: string;
    /** Abort when no byte arrives for this long. */
    readonly idleTimeoutMs?: number;
}
