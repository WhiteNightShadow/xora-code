import { z } from 'zod';
import { applyPatchTool } from './tools/apply-patch.ts';
import { bashKillTool, bashOutputTool, bashTool } from './tools/bash.ts';
import { editTool, multiEditTool } from './tools/edit.ts';
import { globTool } from './tools/glob.ts';
import { createGrepTool, type GrepToolOptions } from './tools/grep.ts';
import { listTool } from './tools/list.ts';
import { readTool } from './tools/read.ts';
import { todoTool } from './tools/todo.ts';
import { writeTool } from './tools/write.ts';
import type { AnyTool } from './types.ts';

export interface DefaultToolsOptions {
    /** Passed to `createGrepTool`. */
    readonly ripgrep?: GrepToolOptions['ripgrep'];
}

/** The engine's built-in tools, in the order they are offered to the model. */
export function createDefaultTools(options: DefaultToolsOptions = {}): AnyTool[] {
    return [
        readTool,
        listTool,
        globTool,
        createGrepTool(options.ripgrep === undefined ? {} : { ripgrep: options.ripgrep }),
        editTool,
        multiEditTool,
        writeTool,
        applyPatchTool,
        bashTool,
        bashOutputTool,
        bashKillTool,
        todoTool,
    ];
}

/** A tool as model APIs describe it: OpenAI `function` and Anthropic `tools` entries both take these three fields. */
export interface ToolSpec {
    readonly name: string;
    readonly description: string;
    /** JSON Schema (draft 2020-12) of the input, without the `$schema` key. */
    readonly parameters: Record<string, unknown>;
}

export function toolSpec(tool: AnyTool): ToolSpec {
    // The input side: what the model sends, before defaults or transforms apply.
    const schema = tidySchema(z.toJSONSchema(tool.schema, { io: 'input' })) as Record<string, unknown>;
    delete schema.$schema;
    return { name: tool.name, description: tool.description, parameters: schema };
}

/** Drops the safe-integer bounds zod puts on every integer, and closes objects to unknown keys. */
function tidySchema(node: unknown): unknown {
    if (Array.isArray(node)) {
        return node.map(tidySchema);
    }
    if (node === null || typeof node !== 'object') {
        return node;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        const safeBound =
            (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) ||
            (key === 'minimum' && value === Number.MIN_SAFE_INTEGER);
        if (!safeBound) {
            result[key] = tidySchema(value);
        }
    }
    if (
        result.type === 'object' &&
        typeof result.properties === 'object' &&
        result.additionalProperties === undefined
    ) {
        result.additionalProperties = false;
    }
    return result;
}
