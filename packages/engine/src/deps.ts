import type { ToolSpec } from '@xora/providers';
import { type AnyTool, toolSpec } from '@xora/tools';

/** The engine's only import points into providers and tools, so their surface is visible in one place. */
export { completeModel, ProviderError, streamModel } from '@xora/providers';
export {
    type AnyTool,
    checkPathAccess,
    createDefaultTools,
    isReadOnlyCommand,
    isSensitivePath,
    LspManager,
    sanitizeEnv,
    type ToolContext,
    type ToolResult,
} from '@xora/tools';

/** Host tools carry their own JSON Schema (`jsonSchema`); built-in tools derive it from zod. */
export function toolSpecs(tools: readonly AnyTool[]): ToolSpec[] {
    return tools.map((tool) => {
        const jsonSchema = (tool as { jsonSchema?: Record<string, unknown> }).jsonSchema;
        return jsonSchema ? { name: tool.name, description: tool.description, parameters: jsonSchema } : toolSpec(tool);
    });
}
