import { CORE_SCHEMA, load, YAMLException } from 'js-yaml';
import { z } from 'zod';
import { AUTONOMY_LEVELS } from './autonomy.ts';
import { CurrencySchema, TierSchema } from './schemas.ts';

/**
 * Workflow definitions (06 §11): fixed steps in `.xora/workflows/<name>.yaml` (project) or
 * `<data>/workflows/<name>.yaml` (user), with inputs, outputs, verification, failure policies, human gates,
 * supervisor steps and triggers (06 §12). Parsing checks the structure, the dependency graph and every template
 * reference, so a run never meets an unknown name halfway.
 */

const text = () => z.string().trim().min(1);

export const WorkflowNameSchema = z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'workflow names are 1-64 lower-case letters, digits or "-"');
export const StepIdSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'step ids start with a letter: letters, digits, "_" or "-"');
const NameSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'names start with a letter: letters, digits or "_"');

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export type WorkflowScalar = z.output<typeof ScalarSchema>;

/**
 * When a workflow starts by itself. Triggers only act for project workflows the user switched on; the host keeps
 * the hash of the file it was switched on for and stops them when the file changes (10).
 */
export const TriggerSpecSchema = z
    .object({
        /** Can be started by hand from the workflow list. */
        manual: z.boolean().default(true),
        /** Cron expressions with five fields: minute, hour, day of month, month, day of week. */
        schedule: z.union([text(), z.array(text()).min(1)]).optional(),
        /** IANA time zone of `schedule`; the system's when absent. */
        timezone: text().optional(),
        /** Schedule times missed while the app was not running: drop them, or run once when it starts. */
        missed: z.enum(['skip', 'once']).default('skip'),
        /** Changes under these globs (relative to the project) start a run once they settle. */
        files: z
            .object({
                paths: z.array(text()).min(1),
                ignore: z.array(text()).default([]),
                debounceSeconds: z.number().int().min(1).max(3600).default(10),
            })
            .strict()
            .optional(),
        /** New commits on the branches (any branch when empty), or new branches. */
        git: z
            .object({
                on: z.array(z.enum(['commit', 'branch'])).min(1),
                branches: z.array(text()).default([]),
            })
            .strict()
            .optional(),
        /** A POST to the local webhook (127.0.0.1, with the workflow's token). */
        webhook: z.boolean().default(false),
        /** Wait for the off-peak window of the models the run uses (06 §12, 11 §7). */
        offPeakOnly: z.boolean().default(false),
    })
    .strict();
export type TriggerSpec = z.output<typeof TriggerSpecSchema>;

export const WorkflowInputSchema = z
    .object({
        type: z.enum(['string', 'number', 'boolean']).default('string'),
        description: z.string().optional(),
        default: ScalarSchema.optional(),
    })
    .strict();
export type WorkflowInput = z.output<typeof WorkflowInputSchema>;

export const StepVerifySchema = z
    .object({
        command: text(),
        /** `fail` for a step that has to produce a failing test. */
        expect: z.enum(['pass', 'fail']).default('pass'),
        timeoutMinutes: z.number().positive().max(120).default(10),
    })
    .strict();
export type StepVerify = z.output<typeof StepVerifySchema>;

/** Applied in order until one succeeds: retry with feedback, one tier up, another agent, then `finally`. */
export const FailurePolicySchema = z
    .object({
        retries: z.number().int().min(0).max(5).default(1),
        escalate: z.boolean().default(true),
        agent: text().optional(),
        finally: z.enum(['abort', 'skip', 'ask']).default('abort'),
    })
    .strict();
export type FailurePolicy = z.output<typeof FailurePolicySchema>;

export const DEFAULT_FAILURE_POLICY: FailurePolicy = Object.freeze({ retries: 1, escalate: true, finally: 'abort' });

const common = {
    id: StepIdSchema,
    title: z.string().trim().optional(),
    needs: z.array(StepIdSchema).default([]),
    /** Runs only when this holds, e.g. `steps.check.outcome == 'failed'`; skipped otherwise. */
    if: text().optional(),
};

export const AgentStepSchema = z
    .object({
        ...common,
        type: z.literal('agent'),
        /** Roster agent id or name (06 §14). */
        agent: text(),
        tier: TierSchema.optional(),
        task: text(),
        /** Values the agent hands back, for later steps: `{{steps.<id>.outputs.<name>}}`. */
        outputs: z.array(NameSchema).default([]),
        verify: StepVerifySchema.optional(),
        onFailure: FailurePolicySchema.optional(),
    })
    .strict();

export const SuperviseStepSchema = z
    .object({
        ...common,
        type: z.literal('supervise'),
        /** Handed to a supervisor as a team goal (06 §5). */
        goal: text(),
        autonomy: z.enum(AUTONOMY_LEVELS).optional(),
        budget: z.number().positive().optional(),
        verify: StepVerifySchema.optional(),
        onFailure: FailurePolicySchema.pick({ retries: true, finally: true }).strict().optional(),
    })
    .strict();

export const GateStepSchema = z
    .object({
        ...common,
        type: z.literal('gate'),
        gate: z.literal('human').default('human'),
        /** Shown on the approval card. */
        message: z.string().trim().optional(),
    })
    .strict();

export const ScriptStepSchema = z
    .object({
        ...common,
        type: z.literal('script'),
        /** A shell command in the project directory, through the permission policy like the agent's commands. */
        run: text(),
        expect: z.enum(['pass', 'fail']).default('pass'),
        timeoutMinutes: z.number().positive().max(120).default(10),
        onFailure: FailurePolicySchema.pick({ retries: true, finally: true }).strict().optional(),
    })
    .strict();

export const SubWorkflowStepSchema = z
    .object({
        ...common,
        type: z.literal('workflow'),
        workflow: WorkflowNameSchema,
        inputs: z.record(z.string(), ScalarSchema).default({}),
    })
    .strict();

/** The step type when `type` is left out: `gate:` makes a gate, `run:` a script, `goal:` a supervisor step… */
function inferStepType(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || 'type' in value) {
        return value;
    }
    const keys = new Set(Object.keys(value));
    const type = keys.has('gate')
        ? 'gate'
        : keys.has('run')
          ? 'script'
          : keys.has('workflow')
            ? 'workflow'
            : keys.has('goal')
              ? 'supervise'
              : 'agent';
    return { ...value, type };
}

export const WorkflowStepSchema = z.preprocess(
    inferStepType,
    z.discriminatedUnion('type', [
        AgentStepSchema,
        SuperviseStepSchema,
        GateStepSchema,
        ScriptStepSchema,
        SubWorkflowStepSchema,
    ]),
);
export type WorkflowStep = z.output<typeof WorkflowStepSchema>;
export type AgentStep = z.output<typeof AgentStepSchema>;
export type SuperviseStep = z.output<typeof SuperviseStepSchema>;
export type GateStep = z.output<typeof GateStepSchema>;
export type ScriptStep = z.output<typeof ScriptStepSchema>;
export type SubWorkflowStep = z.output<typeof SubWorkflowStepSchema>;
export type StepType = WorkflowStep['type'];

const WorkflowObjectSchema = z
    .object({
        name: WorkflowNameSchema,
        title: z.string().trim().optional(),
        description: z.string().trim().optional(),
        /** Organization whose roster and tiers the agent steps use. */
        org: text().optional(),
        autonomy: z.enum(AUTONOMY_LEVELS).optional(),
        trigger: TriggerSpecSchema.prefault({}),
        inputs: z.record(NameSchema, WorkflowInputSchema).default({}),
        budget: z.object({ perRun: z.number().positive(), currency: CurrencySchema.optional() }).strict().optional(),
        /** Steps running at the same time. */
        concurrency: z.number().int().min(1).max(8).default(3),
        steps: z.array(WorkflowStepSchema).min(1).max(100),
    })
    .strict();

export const WorkflowDefinitionSchema = WorkflowObjectSchema.superRefine((definition, ctx) => {
    for (const issue of checkGraph(definition)) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
});
export type WorkflowDefinition = z.output<typeof WorkflowDefinitionSchema>;

// Templates and conditions -----------------------------------------------------------------------------------

/** `{{ inputs.issue }}`, `{{ steps.fix.outputs.patch }}`, `{{ steps.fix.summary }}`, `{{ trigger.files }}`… */
export const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export type TemplateRef =
    | { readonly kind: 'input'; readonly name: string }
    | { readonly kind: 'step'; readonly step: string; readonly field: 'summary' | 'outcome' }
    | { readonly kind: 'output'; readonly step: string; readonly name: string }
    | { readonly kind: 'run'; readonly field: 'id' | 'reason' }
    | { readonly kind: 'trigger'; readonly field: 'files' | 'branch' | 'commit' | 'event' | 'payload' };

export function parseRef(path: string): TemplateRef | undefined {
    const parts = path.split('.');
    const [root, a, b, c] = parts;
    if (root === 'inputs' && parts.length === 2 && a) {
        return { kind: 'input', name: a };
    }
    if (root === 'steps' && a) {
        if (parts.length === 3 && (b === 'summary' || b === 'outcome')) {
            return { kind: 'step', step: a, field: b };
        }
        if (parts.length === 4 && b === 'outputs' && c) {
            return { kind: 'output', step: a, name: c };
        }
    }
    if (root === 'run' && parts.length === 2 && (a === 'id' || a === 'reason')) {
        return { kind: 'run', field: a };
    }
    if (
        root === 'trigger' &&
        parts.length === 2 &&
        (a === 'files' || a === 'branch' || a === 'commit' || a === 'event' || a === 'payload')
    ) {
        return { kind: 'trigger', field: a };
    }
    return undefined;
}

export function templateRefs(template: string): Array<{ readonly path: string; readonly ref?: TemplateRef }> {
    return [...template.matchAll(TEMPLATE)].map((match) => {
        const path = match[1] ?? '';
        const ref = parseRef(path);
        return ref ? { path, ref } : { path };
    });
}

export type ConditionLiteral = string | number | boolean;

/** `if:` — a reference, optionally negated, or a reference compared with a literal. */
export type Condition =
    | { readonly kind: 'truthy'; readonly ref: TemplateRef; readonly negate: boolean }
    | {
          readonly kind: 'compare';
          readonly ref: TemplateRef;
          readonly op: '==' | '!=';
          readonly value: ConditionLiteral;
      };

const COMPARE = /^([A-Za-z0-9_.-]+)\s*(==|!=)\s*(.+)$/;

function literal(raw: string): ConditionLiteral | undefined {
    const value = raw.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) return quoted[2] ?? '';
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return undefined;
}

export function parseCondition(source: string): Condition | { readonly error: string } {
    const value = source.trim().replace(TEMPLATE, (_match, path: string) => path);
    const compare = COMPARE.exec(value);
    if (compare) {
        const ref = parseRef(compare[1] ?? '');
        const right = literal(compare[3] ?? '');
        if (!ref) return { error: `unknown reference ${compare[1]}` };
        if (right === undefined) return { error: `${compare[3]} is not a quoted string, number, true or false` };
        return { kind: 'compare', ref, op: compare[2] as '==' | '!=', value: right };
    }
    const negate = value.startsWith('!');
    const path = negate ? value.slice(1).trim() : value;
    const ref = parseRef(path);
    return ref ? { kind: 'truthy', ref, negate } : { error: `unknown reference ${path}` };
}

// Structural checks ------------------------------------------------------------------------------------------

export interface WorkflowIssue {
    readonly path: Array<string | number>;
    readonly message: string;
    readonly line?: number;
}

/** Template fields of a step, with their path for error messages. */
export function stepTemplates(step: WorkflowStep): Array<{ readonly field: string; readonly text: string }> {
    const fields: Array<{ field: string; text: string }> = [];
    switch (step.type) {
        case 'agent':
            fields.push({ field: 'task', text: step.task });
            if (step.verify) fields.push({ field: 'verify.command', text: step.verify.command });
            break;
        case 'supervise':
            fields.push({ field: 'goal', text: step.goal });
            if (step.verify) fields.push({ field: 'verify.command', text: step.verify.command });
            break;
        case 'gate':
            if (step.message) fields.push({ field: 'message', text: step.message });
            break;
        case 'script':
            fields.push({ field: 'run', text: step.run });
            break;
        case 'workflow':
            for (const [name, value] of Object.entries(step.inputs)) {
                if (typeof value === 'string') fields.push({ field: `inputs.${name}`, text: value });
            }
            break;
    }
    return fields;
}

/** Every step the given one waits for, directly or not. */
export function ancestors(definition: Pick<WorkflowDefinition, 'steps'>, stepId: string): Set<string> {
    const byId = new Map(definition.steps.map((step) => [step.id, step]));
    const seen = new Set<string>();
    const stack = [...(byId.get(stepId)?.needs ?? [])];
    while (stack.length > 0) {
        const next = stack.pop() as string;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(...(byId.get(next)?.needs ?? []));
    }
    return seen;
}

function checkGraph(definition: z.output<typeof WorkflowObjectSchema>): WorkflowIssue[] {
    const issues: WorkflowIssue[] = [];
    const index = new Map<string, number>();
    definition.steps.forEach((step, position) => {
        if (index.has(step.id)) {
            issues.push({ path: ['steps', position, 'id'], message: `duplicate step id ${step.id}` });
        } else {
            index.set(step.id, position);
        }
    });
    definition.steps.forEach((step, position) => {
        step.needs.forEach((need, at) => {
            if (need === step.id) {
                issues.push({ path: ['steps', position, 'needs', at], message: `${step.id} cannot need itself` });
            } else if (!index.has(need)) {
                issues.push({ path: ['steps', position, 'needs', at], message: `unknown step ${need}` });
            }
        });
    });
    if (issues.length > 0) {
        return issues;
    }
    const cycle = findCycle(definition.steps);
    if (cycle) {
        return [{ path: ['steps'], message: `the steps wait for each other in a cycle: ${cycle.join(' → ')}` }];
    }
    definition.steps.forEach((step, position) => {
        const before = ancestors(definition, step.id);
        const check = (ref: TemplateRef | undefined, raw: string, field: string) => {
            const path = ['steps', position, ...field.split('.')];
            if (!ref) {
                issues.push({ path, message: `unknown reference {{${raw}}}` });
                return;
            }
            if (ref.kind === 'input' && !(ref.name in definition.inputs)) {
                issues.push({ path, message: `unknown input ${ref.name}` });
            }
            if (ref.kind === 'step' || ref.kind === 'output') {
                // A step's verification runs after its agent finished, so it may use the step's own outputs.
                const own = ref.step === step.id && field === 'verify.command' && ref.kind === 'output';
                if (!index.has(ref.step)) {
                    issues.push({ path, message: `unknown step ${ref.step}` });
                } else if (!before.has(ref.step) && !own) {
                    issues.push({
                        path,
                        message: `${step.id} uses ${ref.step} without waiting for it (add it to needs)`,
                    });
                }
            }
            if (ref.kind === 'output' && index.has(ref.step)) {
                const source = definition.steps[index.get(ref.step) as number];
                if (source?.type !== 'agent' || !source.outputs.includes(ref.name)) {
                    issues.push({ path, message: `${ref.step} does not declare the output ${ref.name}` });
                }
            }
        };
        for (const { field, text } of stepTemplates(step)) {
            for (const { path, ref } of templateRefs(text)) {
                check(ref, path, field);
            }
        }
        if (step.if !== undefined) {
            const condition = parseCondition(step.if);
            if ('error' in condition) {
                issues.push({ path: ['steps', position, 'if'], message: condition.error });
            } else {
                check(condition.ref, step.if, 'if');
            }
        }
        if (step.type === 'workflow' && step.workflow === definition.name) {
            issues.push({ path: ['steps', position, 'workflow'], message: 'a workflow cannot run itself' });
        }
    });
    return issues;
}

function findCycle(steps: readonly WorkflowStep[]): string[] | undefined {
    const needs = new Map(steps.map((step) => [step.id, step.needs]));
    const state = new Map<string, 'open' | 'done'>();
    const trail: string[] = [];
    const visit = (id: string): string[] | undefined => {
        if (state.get(id) === 'done') return undefined;
        if (state.get(id) === 'open') return [...trail.slice(trail.indexOf(id)), id];
        state.set(id, 'open');
        trail.push(id);
        for (const next of needs.get(id) ?? []) {
            const cycle = visit(next);
            if (cycle) return cycle;
        }
        trail.pop();
        state.set(id, 'done');
        return undefined;
    };
    for (const step of steps) {
        const cycle = visit(step.id);
        if (cycle) return cycle;
    }
    return undefined;
}

// Parsing -----------------------------------------------------------------------------------------------------

export type WorkflowParse =
    | { readonly ok: true; readonly definition: WorkflowDefinition }
    | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

/** Parses and checks a workflow file. YAML errors carry their line; schema errors their path. */
export function parseWorkflow(source: string): WorkflowParse {
    let data: unknown;
    try {
        data = load(source, { schema: CORE_SCHEMA });
    } catch (error) {
        if (error instanceof YAMLException) {
            return {
                ok: false,
                issues: [{ path: [], message: error.reason || error.message, line: error.mark.line + 1 }],
            };
        }
        throw error;
    }
    const parsed = WorkflowDefinitionSchema.safeParse(data);
    if (!parsed.success) {
        return {
            ok: false,
            issues: parsed.error.issues.map((issue) => ({
                path: issue.path.filter((part): part is string | number => typeof part !== 'symbol'),
                message: issue.message,
            })),
        };
    }
    return { ok: true, definition: parsed.data };
}

/** `steps[2].verify.command` */
export function issuePath(path: readonly (string | number)[]): string {
    return path.reduce<string>(
        (out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : part),
        '',
    );
}
