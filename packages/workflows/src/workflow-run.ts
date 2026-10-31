import { bilingual, type UiLanguage } from '@xora/protocol/language';
import type { Tier } from './schemas.ts';
import {
    type Condition,
    type ConditionLiteral,
    parseCondition,
    parseRef,
    TEMPLATE,
    type TemplateRef,
    type WorkflowDefinition,
    type WorkflowInput,
    type WorkflowScalar,
    type WorkflowStep,
} from './workflow.ts';

/**
 * The pure part of a workflow run (06 §11): which steps can start, which are skipped, how templates and
 * conditions resolve, and when the run is over. The host owns threads, commands, approvals and persistence.
 */

export const STEP_STATUSES = ['pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

const FINISHED: ReadonlySet<StepStatus> = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);

export function isFinished(status: StepStatus): boolean {
    return FINISHED.has(status);
}

export interface StepState {
    status: StepStatus;
    /** Agent turns, team runs or command runs the step used, the first included. */
    attempts: number;
    outputs: Record<string, string>;
    summary?: string;
    /** Why the step failed or was skipped. */
    note?: string;
    /** Every thread the step used (agent steps; the supervisor thread of a team step). */
    threadIds: string[];
    /** Roster agent and tier of the latest attempt. */
    agent?: string;
    tier?: Tier;
    teamRunId?: string;
    childRunId?: string;
    startedAt?: number;
    endedAt?: number;
}

export function newStepState(): StepState {
    return { status: 'pending', attempts: 0, outputs: {}, threadIds: [] };
}

/** What a run was started by, and what the trigger saw. */
export interface RunTrigger {
    readonly reason: 'manual' | 'schedule' | 'files' | 'git' | 'webhook' | 'parent';
    readonly files?: readonly string[];
    readonly branch?: string;
    readonly commit?: string;
    readonly event?: string;
    readonly payload?: unknown;
}

export interface RunContext {
    readonly runId: string;
    readonly inputs: Readonly<Record<string, WorkflowScalar>>;
    readonly trigger: RunTrigger;
    readonly steps: Readonly<Record<string, StepState>>;
}

// Inputs ------------------------------------------------------------------------------------------------------

const TEXT = bilingual(
    {
        unknownInput: (name: string) => `没有名为${name}的输入`,
        missingInput: (name: string) => `缺少输入${name}`,
        wrongType: (name: string, type: WorkflowInput['type']) =>
            `输入${name}应为${type === 'number' ? '数字' : type === 'boolean' ? '布尔值' : '文本'}`,
        badCondition: (error: string) => `条件无法解析：${error}`,
        conditionFalse: (condition: string) => `条件不成立：${condition}`,
        blocked: (step: string) => `依赖的步骤${step}没有成功`,
    },
    {
        unknownInput: (name) => `There is no input named ${name}`,
        missingInput: (name) => `Input ${name} is missing`,
        wrongType: (name, type) =>
            `Input ${name} should be ${type === 'number' ? 'a number' : type === 'boolean' ? 'true or false' : 'text'}`,
        badCondition: (error) => `The condition cannot be parsed: ${error}`,
        conditionFalse: (condition) => `The condition does not hold: ${condition}`,
        blocked: (step) => `Step ${step}, which this step needs, did not succeed`,
    },
);

/**
 * The run's inputs: given values converted to the declared types, defaults for the rest. Every input without a
 * default must be given; unknown names are an error.
 */
export function resolveInputs(
    declared: Readonly<Record<string, WorkflowInput>>,
    given: Readonly<Record<string, unknown>>,
    language: UiLanguage,
): { readonly inputs: Record<string, WorkflowScalar> } | { readonly errors: string[] } {
    const text = TEXT[language];
    const errors: string[] = [];
    const inputs: Record<string, WorkflowScalar> = {};
    for (const name of Object.keys(given)) {
        if (!(name in declared)) {
            errors.push(text.unknownInput(name));
        }
    }
    for (const [name, spec] of Object.entries(declared)) {
        const raw = given[name] ?? spec.default;
        if (raw === undefined || raw === '') {
            if (spec.default === undefined) {
                errors.push(text.missingInput(name));
            }
            continue;
        }
        const value = coerce(raw, spec.type);
        if (value === undefined) {
            errors.push(text.wrongType(name, spec.type));
        } else {
            inputs[name] = value;
        }
    }
    return errors.length > 0 ? { errors } : { inputs };
}

function coerce(value: unknown, type: WorkflowInput['type']): WorkflowScalar | undefined {
    switch (type) {
        case 'string':
            return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                ? String(value)
                : undefined;
        case 'number': {
            const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
            return Number.isFinite(number) ? number : undefined;
        }
        case 'boolean':
            if (typeof value === 'boolean') return value;
            if (value === 'true') return true;
            if (value === 'false') return false;
            return undefined;
    }
}

// References, templates and conditions -----------------------------------------------------------------------

/** A reference's value: text, a list (changed files), or undefined when it has none yet. */
export function refValue(ref: TemplateRef, context: RunContext): string | readonly string[] | undefined {
    switch (ref.kind) {
        case 'input': {
            const value = context.inputs[ref.name];
            return value === undefined ? undefined : String(value);
        }
        case 'step': {
            const step = context.steps[ref.step];
            if (!step) return undefined;
            return ref.field === 'outcome' ? step.status : step.summary;
        }
        case 'output':
            return context.steps[ref.step]?.outputs[ref.name];
        case 'run':
            return ref.field === 'id' ? context.runId : context.trigger.reason;
        case 'trigger': {
            const { trigger } = context;
            switch (ref.field) {
                case 'files':
                    return trigger.files;
                case 'branch':
                    return trigger.branch;
                case 'commit':
                    return trigger.commit;
                case 'event':
                    return trigger.event;
                case 'payload':
                    return trigger.payload === undefined
                        ? undefined
                        : typeof trigger.payload === 'string'
                          ? trigger.payload
                          : JSON.stringify(trigger.payload);
            }
        }
    }
}

/** Quotes one value for the shell that runs verification and script commands (`runCheck`). */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Fills `{{…}}` references. For `command` text every value is quoted for the shell, so an input or an agent's
 * output can never add shell syntax; lists become separate quoted words. Elsewhere lists are one per line.
 * Unknown or empty references become empty text (the definition was checked when it was parsed).
 */
export function renderTemplate(
    text: string,
    context: RunContext,
    options: { readonly command?: boolean; readonly platform?: NodeJS.Platform } = {},
): string {
    return text.replace(TEMPLATE, (_match, path: string) => {
        const ref = parseRef(path);
        const value = ref ? refValue(ref, context) : undefined;
        if (!options.command) {
            return value === undefined ? '' : typeof value === 'string' ? value : value.join('\n');
        }
        const words = value === undefined ? [''] : typeof value === 'string' ? [value] : value;
        return words.map((word) => shellQuote(word, options.platform)).join(' ');
    });
}

function truthy(value: string | readonly string[] | undefined): boolean {
    if (value === undefined) return false;
    if (typeof value !== 'string') return value.length > 0;
    return value !== '' && value !== 'false' && value !== '0';
}

function equals(value: string | readonly string[] | undefined, literal: ConditionLiteral): boolean {
    if (value === undefined) return false;
    const text = typeof value === 'string' ? value : value.join('\n');
    if (typeof literal === 'number') return Number(text) === literal;
    if (typeof literal === 'boolean') return text === String(literal);
    return text === literal;
}

export function evaluateCondition(condition: Condition, context: RunContext): boolean {
    const value = refValue(condition.ref, context);
    if (condition.kind === 'truthy') {
        return truthy(value) !== condition.negate;
    }
    const same = equals(value, condition.value);
    return condition.op === '==' ? same : !same;
}

// Scheduling -------------------------------------------------------------------------------------------------

export type StepDecision =
    | { readonly step: WorkflowStep; readonly action: 'run' }
    | { readonly step: WorkflowStep; readonly action: 'skip'; readonly reason: string };

/**
 * Pending steps whose dependencies have all finished, in definition order, each with its fate: a step with an
 * `if` runs when the condition holds; one without runs only when every dependency succeeded.
 */
export function decideSteps(definition: WorkflowDefinition, context: RunContext, language: UiLanguage): StepDecision[] {
    const text = TEXT[language];
    const decisions: StepDecision[] = [];
    for (const step of definition.steps) {
        const state = context.steps[step.id];
        if (state?.status !== 'pending') continue;
        const needs = step.needs.map((id) => ({ id, status: context.steps[id]?.status ?? 'pending' }));
        if (needs.some((need) => !isFinished(need.status))) continue;
        if (step.if !== undefined) {
            const condition = parseCondition(step.if);
            if ('error' in condition) {
                decisions.push({ step, action: 'skip', reason: text.badCondition(condition.error) });
            } else if (evaluateCondition(condition, context)) {
                decisions.push({ step, action: 'run' });
            } else {
                decisions.push({ step, action: 'skip', reason: text.conditionFalse(step.if) });
            }
            continue;
        }
        const blocked = needs.find((need) => need.status !== 'succeeded');
        if (blocked) {
            decisions.push({ step, action: 'skip', reason: text.blocked(blocked.id) });
        } else {
            decisions.push({ step, action: 'run' });
        }
    }
    return decisions;
}

export type RunOutcome = 'running' | 'completed' | 'failed';

/** `completed` once every step finished without a failure, `failed` when any failed, `running` otherwise. */
export function runOutcome(definition: WorkflowDefinition, steps: Readonly<Record<string, StepState>>): RunOutcome {
    const states = definition.steps.map((step) => steps[step.id]?.status ?? 'pending');
    if (states.some((status) => !isFinished(status))) return 'running';
    return states.some((status) => status === 'failed' || status === 'cancelled') ? 'failed' : 'completed';
}

/** Steps a run needs a model for, by tier: what the unattended and off-peak checks look at. */
export function stepTiers(definition: WorkflowDefinition, defaultTier: (agent: string) => Tier | undefined): Tier[] {
    const tiers = new Set<Tier>();
    for (const step of definition.steps) {
        if (step.type === 'agent') {
            const tier = step.tier ?? defaultTier(step.agent);
            if (tier) tiers.add(tier);
        }
        if (step.type === 'supervise') {
            tiers.add('flagship');
        }
    }
    return [...tiers];
}
