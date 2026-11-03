import type { ErrorClass, ModelInfo, ProviderPreset, Quirks, Region } from './types.ts';

/**
 * Built-in vendor presets. Data only: every vendor difference the wire adapters honour is expressed here.
 * Entries with `verified` were checked against official documentation on that date; the rest are endpoint-only
 * starting points whose models are discovered through `/models`.
 */

const DOCS_CHECKED = '2026-10-29';
const CHECKED_TODAY = '2026-10-30';

/**
 * GLM business codes, identical on bigmodel.cn and z.ai (docs.bigmodel.cn/cn/api/api-code,
 * docs.z.ai/api-reference/api-code, checked 2026-10-30). Mid-stream failures are reported through
 * `finish_reason` instead.
 */
export const GLM_ERROR_CODES: Readonly<Record<string, ErrorClass>> = {
    '1000': 'auth', // authentication failed
    '1001': 'auth', // no Authentication header
    '1003': 'auth', // token expired
    '1005': 'auth', // two-factor authentication required
    '1113': 'quota', // account in arrears
    '1200': 'server', // API call failed
    '1210': 'invalid_request', // invalid parameters
    '1211': 'not_found', // unknown model
    '1212': 'invalid_request', // call method not supported by the model
    '1213': 'invalid_request', // parameter missing
    '1214': 'invalid_request', // parameter invalid
    '1215': 'invalid_request', // mutually exclusive parameters
    '1220': 'permission', // no access to the API
    '1221': 'not_found', // API taken offline
    '1222': 'not_found', // API does not exist
    '1230': 'server', // API call process error
    '1234': 'server', // network error on the vendor side
    '1261': 'context_length', // prompt too long
    '1301': 'content_filter', // unsafe or sensitive content
    '1302': 'rate_limit', // account rate limit
    '1305': 'overloaded', // model temporarily overloaded
    '1308': 'quota', // usage limit for a window, resets later
    '1309': 'quota', // GLM Coding Plan expired
    '1310': 'quota', // weekly or monthly limit exhausted
    '1311': 'permission', // plan does not include the model
    '1313': 'rate_limit', // fair-use policy: request frequency restricted
    '1314': 'quota', // enterprise plan expired
    '1315': 'permission', // key only valid for the enterprise coding plan
    '1316': 'quota', // 5-hour limit, no balance for extra usage
    '1317': 'quota', // 7-day limit, no balance for extra usage
    '1318': 'quota', // 5-hour limit, sub-account spend cap
    '1319': 'quota', // 7-day limit, sub-account spend cap
    '1320': 'quota', // 5-hour limit, organisation spend cap
    '1321': 'quota', // 7-day limit, organisation spend cap
};

/** Kimi open platform error types (kimi.ai help centre, "API error codes", checked 2026-10-30). */
export const KIMI_ERROR_CODES: Readonly<Record<string, ErrorClass>> = {
    content_filter: 'content_filter',
    invalid_authentication_error: 'auth',
    incorrect_api_key_error: 'auth',
    permission_denied_error: 'permission',
    resource_not_found_error: 'not_found',
    engine_overloaded_error: 'overloaded',
    exceeded_current_quota_error: 'quota',
    rate_limit_reached_error: 'rate_limit',
    server_error: 'server',
    unexpected_output: 'server',
    server_unavailable: 'overloaded',
};

// ---------------------------------------------------------------------------------------------------------------
// deepseek

const DEEPSEEK_REASONING = { mode: 'toggle', efforts: ['low', 'high', 'max'], defaultEffort: 'high' } as const;

const deepseek: ProviderPreset = {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'deepseek',
    channel: 'api',
    // One domain serves China and the rest of the world.
    endpoints: { openai_chat: 'https://api.deepseek.com', anthropic_messages: 'https://api.deepseek.com/anthropic' },
    defaultWire: 'openai_chat',
    auth: 'bearer',
    models: [
        {
            id: 'deepseek-flash',
            name: 'DeepSeek V4.1 Flash',
            family: 'deepseek',
            contextWindow: 1_048_576,
            maxOutput: 393_216,
            input: ['text', 'image'],
            reasoning: DEEPSEEK_REASONING,
            tools: true,
            pricing: 'deepseek-flash@2026-10',
            verified: DOCS_CHECKED,
        },
        {
            // The pricing page shows 1M context and 384K output in rows shared with deepseek-flash; not confirmed.
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            family: 'deepseek',
            contextWindow: 1_048_576,
            maxOutput: 393_216,
            input: ['text'],
            reasoning: DEEPSEEK_REASONING,
            tools: true,
            pricing: 'deepseek-v4-pro@2026-10',
        },
    ],
    quirks: {
        reasoningField: 'reasoning_content',
        // With tools, every later request must carry all earlier reasoning or the API answers 400.
        reasoningEcho: 'with_tools',
        thinking: { kind: 'deepseek' },
        // `required` or a named function while thinking is a 400.
        toolChoiceWhenThinking: ['auto', 'none'],
        // Accepted but ignored while thinking.
        omitParamsWhenThinking: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'],
        usage: 'deepseek',
    },
    links: {
        docs: 'https://api-docs.deepseek.com',
        keys: 'https://platform.deepseek.com/api_keys',
        pricing: 'https://api-docs.deepseek.com/quick_start/pricing',
    },
    verified: DOCS_CHECKED,
};

// ---------------------------------------------------------------------------------------------------------------
// kimi

const KIMI_QUIRKS: Quirks = {
    reasoningField: 'reasoning_content',
    // K3 always reasons with preserved thinking: the whole assistant message goes back unchanged.
    reasoningEcho: 'always',
    // K3 has no `thinking` parameter; `reasoning_effort` only.
    thinking: { kind: 'kimi' },
    // K3 rejects sampling overrides.
    omitParams: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'],
    // `max_tokens` is deprecated in favour of `max_completion_tokens` (default 131072).
    maxTokensField: 'max_completion_tokens',
    usage: 'kimi',
    errorCodes: KIMI_ERROR_CODES,
};

function kimiModels(defaultEffort: 'high' | 'max', ids: { readonly pro: string; readonly k3: string }): ModelInfo[] {
    const reasoning = { mode: 'always', efforts: ['low', 'high', 'max'], defaultEffort } as const;
    return [
        {
            id: ids.pro,
            name: 'Kimi K3.1 Pro',
            family: 'kimi',
            contextWindow: 1_048_576,
            maxOutput: 131_072,
            input: ['text', 'image'],
            reasoning,
            tools: true,
            verified: DOCS_CHECKED,
        },
        {
            // Context from the Kimi Code model table; image input is not documented for K3.
            id: ids.k3,
            name: 'Kimi K3',
            family: 'kimi',
            contextWindow: 1_048_576,
            maxOutput: 131_072,
            input: ['text'],
            reasoning,
            tools: true,
            pricing: 'kimi-k3@2026-10',
        },
    ];
}

function kimi(region: Region): ProviderPreset {
    const host = region === 'cn' ? 'https://api.moonshot.cn' : 'https://api.moonshot.ai';
    return {
        id: `kimi-${region}`,
        name: region === 'cn' ? 'Kimi (Moonshot)' : 'Kimi (Moonshot, global)',
        vendor: 'kimi',
        channel: 'api',
        region,
        // Keys are bound to the site that issued them; the other site answers 401.
        endpoints: { openai_chat: `${host}/v1`, anthropic_messages: `${host}/anthropic` },
        defaultWire: 'openai_chat',
        auth: 'bearer',
        models: kimiModels('max', { pro: 'kimi-k3.1-pro', k3: 'kimi-k3' }),
        quirks: KIMI_QUIRKS,
        links: { docs: region === 'cn' ? 'https://platform.kimi.com/docs' : 'https://platform.kimi.ai/docs' },
        verified: DOCS_CHECKED,
    };
}

function kimiCode(region: Region): ProviderPreset {
    const host = region === 'cn' ? 'https://api.kimi.com' : 'https://api.kimi.ai';
    return {
        id: `kimi-code-${region}`,
        name: region === 'cn' ? 'Kimi Code' : 'Kimi Code (global)',
        vendor: 'kimi',
        channel: 'subscription_key',
        region,
        endpoints: { openai_chat: `${host}/coding/v1`, anthropic_messages: `${host}/coding` },
        defaultWire: 'openai_chat',
        auth: 'bearer',
        // Same models as the open platform under shorter ids; without an effort the plan defaults to `high`.
        // Subscription usage has no per-token price.
        models: kimiModels('high', { pro: 'k3.1-pro', k3: 'k3' }).map(({ pricing: _pricing, ...model }) => ({
            ...model,
            verified: CHECKED_TODAY,
        })),
        // Usage windows come back as 429 with only a message (no business code); 403 means the plan lacks the
        // model or the context size.
        quirks: KIMI_QUIRKS,
        compliance: {
            interactiveOnly: true,
            note:
                'Kimi Code keys may back interactive use only. Xora sends its own truthful client identity, never ' +
                'impersonates Kimi CLI and never reuses the official OAuth login. A mistyped model id silently falls ' +
                'back to a non-thinking model, so model ids are checked against /models.',
        },
        links: { docs: 'https://www.kimi.com/code/docs/en/kimi-code/models.html' },
        verified: CHECKED_TODAY,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// glm

const GLM_REASONING = { mode: 'always', efforts: ['low', 'high', 'max'], defaultEffort: 'max' } as const;

const GLM_MODELS: readonly ModelInfo[] = [
    {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        family: 'glm',
        contextWindow: 1_000_000,
        maxOutput: 131_072,
        input: ['text'],
        reasoning: GLM_REASONING,
        tools: true,
        pricing: 'glm-5.3@2026-10',
        verified: DOCS_CHECKED,
    },
    {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        family: 'glm',
        contextWindow: 1_000_000,
        maxOutput: 131_072,
        input: ['text', 'image'],
        reasoning: GLM_REASONING,
        tools: true,
        verified: CHECKED_TODAY,
    },
];

const GLM_QUIRKS: Quirks = {
    reasoningField: 'reasoning_content',
    // Preserved thinking needs all earlier reasoning, complete and in its original order.
    reasoningEcho: 'always',
    thinking: { kind: 'glm', preserve: true },
    toolChoice: ['auto'],
    // Usage arrives in the final chunk without `stream_options`, which glm does not document.
    streamUsage: false,
    usage: 'glm',
    // Streams tool-call arguments instead of delivering them in one piece at the end.
    extraBody: { tool_stream: true },
    errorCodes: GLM_ERROR_CODES,
};

function glm(region: Region): ProviderPreset {
    const host = region === 'cn' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
    return {
        id: `glm-${region}`,
        name: region === 'cn' ? 'GLM (BigModel)' : 'GLM (Z.ai)',
        vendor: 'glm',
        channel: 'api',
        region,
        endpoints: { openai_chat: `${host}/api/paas/v4`, anthropic_messages: `${host}/api/anthropic` },
        defaultWire: 'openai_chat',
        auth: 'bearer',
        models: GLM_MODELS,
        quirks: GLM_QUIRKS,
        links: { docs: region === 'cn' ? 'https://docs.bigmodel.cn' : 'https://docs.z.ai' },
        verified: DOCS_CHECKED,
    };
}

function glmCoding(region: Region): ProviderPreset {
    const host = region === 'cn' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
    return {
        id: `glm-coding-${region}`,
        name: region === 'cn' ? 'GLM Coding Plan' : 'GLM Coding Plan (Z.ai)',
        vendor: 'glm',
        channel: 'subscription_key',
        region,
        // A standard key on this endpoint, or this key elsewhere, is billed against the wrong account.
        endpoints: { openai_chat: `${host}/api/coding/paas/v4` },
        defaultWire: 'openai_chat',
        auth: 'bearer',
        models: GLM_MODELS,
        quirks: GLM_QUIRKS,
        compliance: {
            allowed: false,
            note:
                'The GLM Coding Plan may only be used in the tools its terms list. Xora Code is not on that list and ' +
                'there is no public application process, so use the standard GLM API or a listed tool instead.',
        },
        links: { docs: 'https://docs.bigmodel.cn/cn/coding-plan/overview' },
        verified: DOCS_CHECKED,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// anthropic (facts from Anthropic's documentation as cached on 2026-10-06)

const ANTHROPIC_DOCS = '2026-10-06';
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

function claude(id: string, name: string, model: Pick<ModelInfo, 'reasoning'> & Partial<ModelInfo>): ModelInfo {
    return {
        id,
        name,
        family: 'claude',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        input: ['text', 'image'],
        tools: true,
        pricing: `${id}@2026-10`,
        verified: ANTHROPIC_DOCS,
        ...model,
    };
}

const anthropic: ProviderPreset = {
    id: 'anthropic',
    name: 'Anthropic',
    vendor: 'anthropic',
    channel: 'api',
    endpoints: { anthropic_messages: 'https://api.anthropic.com' },
    defaultWire: 'anthropic_messages',
    auth: 'x-api-key',
    models: [
        claude('claude-opus-5-5', 'Claude Opus 5.5', {
            // Thinking cannot be disabled: `off` becomes the lowest effort. The API default effort is `medium`.
            reasoning: { mode: 'always', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
            quirks: { thinking: { kind: 'anthropic_adaptive', offMode: 'unsupported' } },
        }),
        claude('claude-sonnet-5-5', 'Claude Sonnet 5.5', {
            // `between_tools` is the off switch; it takes no other thinking field and effort at most `high`.
            reasoning: { mode: 'toggle', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
            quirks: { thinking: { kind: 'anthropic_adaptive', offMode: 'between_tools' } },
        }),
        claude('claude-haiku-5-5', 'Claude Haiku 5.5', {
            // `disabled` is accepted at effort `high` or below; forced tool use is accepted (it skips thinking).
            reasoning: { mode: 'toggle', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
            quirks: {
                thinking: { kind: 'anthropic_adaptive', offMode: 'disabled' },
                toolChoice: ['auto', 'none', 'required', 'function'],
            },
        }),
        claude('claude-fable-5-1', 'Claude Fable 5.1', {
            // Thinking is always on; an explicit `disabled` is a 400.
            reasoning: { mode: 'always', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
            quirks: { thinking: { kind: 'anthropic_adaptive', offMode: 'unsupported' } },
        }),
    ],
    quirks: {
        thinking: { kind: 'anthropic_adaptive', offMode: 'unsupported' },
        reasoningEcho: 'always',
        // Forced `tool_choice` (`any`, `tool`) is a 400 on current models.
        toolChoice: ['auto', 'none'],
        // Sampling parameters are rejected on current models.
        omitParams: ['temperature', 'top_p', 'top_k'],
        usage: 'anthropic',
        cacheControl: 'auto',
    },
    links: { docs: 'https://platform.claude.com/docs' },
    verified: ANTHROPIC_DOCS,
};

// ---------------------------------------------------------------------------------------------------------------
// Unverified endpoint-only presets. Models come from `/models`; quirks are conservative guesses.

interface EndpointOnly {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly url: string;
    readonly region?: Region;
    readonly channel?: ProviderPreset['channel'];
    readonly auth?: ProviderPreset['auth'];
    readonly quirks?: Quirks;
    readonly docs?: string;
}

function openAiCompatible(entry: EndpointOnly): ProviderPreset {
    return {
        id: entry.id,
        name: entry.name,
        vendor: entry.vendor,
        channel: entry.channel ?? 'api',
        ...(entry.region ? { region: entry.region } : {}),
        endpoints: { openai_chat: entry.url },
        defaultWire: 'openai_chat',
        auth: entry.auth ?? 'bearer',
        models: [],
        quirks: entry.quirks ?? {},
        ...(entry.docs ? { links: { docs: entry.docs } } : {}),
    };
}

const UNVERIFIED: readonly ProviderPreset[] = [
    openAiCompatible({
        id: 'openai',
        name: 'OpenAI',
        vendor: 'openai',
        url: 'https://api.openai.com/v1',
        quirks: { thinking: { kind: 'openai' }, maxTokensField: 'max_completion_tokens', usage: 'openai' },
    }),
    openAiCompatible({
        id: 'gemini',
        name: 'Google Gemini (OpenAI compatible)',
        vendor: 'google',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        quirks: { thinking: { kind: 'openai' }, usage: 'openai' },
    }),
    openAiCompatible({ id: 'xai', name: 'xAI', vendor: 'xai', url: 'https://api.x.ai/v1' }),
    openAiCompatible({
        id: 'openrouter',
        name: 'OpenRouter',
        vendor: 'openrouter',
        url: 'https://openrouter.ai/api/v1',
        quirks: { reasoningField: 'reasoning', thinking: { kind: 'openai' } },
    }),
    openAiCompatible({ id: 'mistral', name: 'Mistral', vendor: 'mistral', url: 'https://api.mistral.ai/v1' }),
    openAiCompatible({
        id: 'qwen-cn',
        name: 'Qwen (DashScope)',
        vendor: 'qwen',
        region: 'cn',
        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        quirks: { reasoningField: 'reasoning_content' },
    }),
    openAiCompatible({
        id: 'qwen-global',
        name: 'Qwen (DashScope, international)',
        vendor: 'qwen',
        region: 'global',
        url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        quirks: { reasoningField: 'reasoning_content' },
    }),
    openAiCompatible({
        id: 'doubao',
        name: 'Doubao (Volcengine Ark)',
        vendor: 'doubao',
        region: 'cn',
        url: 'https://ark.cn-beijing.volces.com/api/v3',
        quirks: { reasoningField: 'reasoning_content' },
    }),
    openAiCompatible({
        id: 'siliconflow',
        name: 'SiliconFlow',
        vendor: 'siliconflow',
        region: 'cn',
        url: 'https://api.siliconflow.cn/v1',
        quirks: { reasoningField: 'reasoning_content' },
    }),
    // Local servers. 127.0.0.1 rather than localhost, which may resolve to ::1 while the server listens on IPv4.
    openAiCompatible({
        id: 'ollama',
        name: 'Ollama',
        vendor: 'ollama',
        channel: 'local',
        auth: 'none',
        url: 'http://127.0.0.1:11434/v1',
    }),
    openAiCompatible({
        id: 'lmstudio',
        name: 'LM Studio',
        vendor: 'lmstudio',
        channel: 'local',
        auth: 'none',
        url: 'http://127.0.0.1:1234/v1',
    }),
    openAiCompatible({
        id: 'llamacpp',
        name: 'llama.cpp server',
        vendor: 'llamacpp',
        channel: 'local',
        url: 'http://127.0.0.1:8080/v1',
    }),
    openAiCompatible({ id: 'vllm', name: 'vLLM', vendor: 'vllm', channel: 'local', url: 'http://127.0.0.1:8000/v1' }),
    {
        id: 'custom-openai',
        name: 'Custom (OpenAI compatible)',
        vendor: 'custom',
        channel: 'custom',
        endpoints: {},
        defaultWire: 'openai_chat',
        auth: 'bearer',
        models: [],
        quirks: {},
    },
    {
        id: 'custom-anthropic',
        name: 'Custom (Anthropic compatible)',
        vendor: 'custom',
        channel: 'custom',
        endpoints: {},
        defaultWire: 'anthropic_messages',
        auth: 'x-api-key',
        models: [],
        quirks: { cacheControl: 'auto' },
    },
];

// ---------------------------------------------------------------------------------------------------------------
// minimax

/** Checked against the API and its documentation (platform.minimax.io, "Compatible OpenAI API"). */
const MINIMAX_CHECKED = '2026-11-03';

/** Models without `reasoning_effort`: their one level stands for "thinking on". */
const MINIMAX_NO_KNOB: Quirks = { thinking: { kind: 'minimax', effort: false } };

/** M2.x: thinking cannot be turned off and has no effort knob; `max_tokens` up to 196,608. */
function minimaxM2(id: string, name: string): ModelInfo {
    return {
        id,
        name,
        family: 'minimax',
        contextWindow: 204_800,
        maxOutput: 196_608,
        input: ['text'],
        reasoning: { mode: 'always', efforts: ['high'], defaultEffort: 'high' },
        tools: true,
        quirks: MINIMAX_NO_KNOB,
        verified: MINIMAX_CHECKED,
    };
}

const MINIMAX_MODELS: readonly ModelInfo[] = [
    {
        // Always thinks (adaptive): `thinking: disabled` and `reasoning_effort: none` are a 400. Its effort goes
        // low, medium, high, xhigh, max; the default is max.
        id: 'MiniMax-M3.1-Flash',
        name: 'MiniMax M3.1 Flash',
        family: 'minimax',
        contextWindow: 1_000_000,
        maxOutput: 524_288,
        input: ['text'],
        reasoning: { mode: 'always', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'max' },
        tools: true,
        verified: MINIMAX_CHECKED,
    },
    {
        // Thinks adaptively, or not at all with `thinking: disabled`; it has no effort knob, so on is one level.
        id: 'MiniMax-M3',
        name: 'MiniMax M3',
        family: 'minimax',
        contextWindow: 1_000_000,
        maxOutput: 524_288,
        input: ['text'],
        reasoning: { mode: 'toggle', efforts: ['high'], defaultEffort: 'high' },
        tools: true,
        quirks: MINIMAX_NO_KNOB,
        verified: MINIMAX_CHECKED,
    },
    minimaxM2('MiniMax-M2.7', 'MiniMax M2.7'),
    minimaxM2('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed'),
    minimaxM2('MiniMax-M2.5', 'MiniMax M2.5'),
    minimaxM2('MiniMax-M2.5-highspeed', 'MiniMax M2.5 Highspeed'),
    minimaxM2('MiniMax-M2.1', 'MiniMax M2.1'),
    minimaxM2('MiniMax-M2.1-highspeed', 'MiniMax M2.1 Highspeed'),
];

const MINIMAX_QUIRKS: Quirks = {
    reasoningField: 'reasoning_content',
    // The thinking in `reasoning_content` instead of `<think>` tags in the answer (M3, M2.x; M3.1-Flash always).
    extraBody: { reasoning_split: true },
    // Interleaved thinking: across tool calls the whole assistant message goes back, its thinking included.
    reasoningEcho: 'with_tools',
    thinking: { kind: 'minimax', effort: true },
    omitParams: ['temperature', 'top_p'],
};

function minimax(region: Region): ProviderPreset {
    const host = region === 'cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io';
    return {
        id: `minimax-${region}`,
        name: region === 'cn' ? 'MiniMax' : 'MiniMax (global)',
        vendor: 'minimax',
        channel: 'api',
        region,
        endpoints: { openai_chat: `${host}/v1` },
        defaultWire: 'openai_chat',
        auth: 'bearer',
        models: MINIMAX_MODELS,
        quirks: MINIMAX_QUIRKS,
        links: { docs: region === 'cn' ? 'https://platform.minimaxi.com/docs' : 'https://platform.minimax.io/docs' },
        verified: MINIMAX_CHECKED,
    };
}

/** All built-in presets, verified ones first. */
export const PRESETS: readonly ProviderPreset[] = [
    deepseek,
    kimi('cn'),
    kimi('global'),
    kimiCode('cn'),
    kimiCode('global'),
    glm('cn'),
    glm('global'),
    glmCoding('cn'),
    glmCoding('global'),
    minimax('cn'),
    minimax('global'),
    anthropic,
    ...UNVERIFIED,
];
