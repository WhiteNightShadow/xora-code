import { fromAcpMcpServer, type McpServerConfig, McpManager, type McpTool, safeBaseEnv } from '@xora/mcp';
import { z } from 'zod';
import type { AnyTool, ToolResult } from './deps.ts';

/** Turns the ACP `mcpServers` of a session into configs; unreadable entries are skipped and reported. */
export function readMcpServers(servers: readonly unknown[] | undefined): { configs: McpServerConfig[]; problems: string[] } {
    const configs: McpServerConfig[] = [];
    const problems: string[] = [];
    for (const server of servers ?? []) {
        try {
            configs.push(fromAcpMcpServer(server));
        } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
        }
    }
    return { configs, problems };
}

export function createMcpManager(version: string): McpManager {
    return new McpManager({
        clientInfo: { name: 'xora-engine', version },
        baseEnv: safeBaseEnv(),
    });
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }>; truncated: boolean }): string {
    const parts = result.content.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type} content]`));
    return `${parts.join('\n')}${result.truncated ? '\n[output truncated]' : ''}`;
}

/**
 * MCP tools as engine tools. They are never treated as read-only here (server hints are not trusted for
 * permissions), so every call goes through the host's policy, which classifies them as network actions.
 */
export function mcpTools(manager: McpManager): AnyTool[] {
    return manager.tools().map(
        (tool: McpTool) =>
            ({
                name: tool.qualifiedName,
                description: `${tool.description || tool.title || tool.name} (MCP server ${tool.server})`,
                kind: 'fetch',
                schema: z.record(z.string(), z.unknown()),
                jsonSchema: tool.inputSchema,
                readOnly: false,
                targets: () => [],
                title: () => `${tool.server}: ${tool.title ?? tool.name}`,
                run: async (input: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<ToolResult> => {
                    try {
                        const result = await manager.callTool(tool.qualifiedName, input, { signal: ctx.signal });
                        return { content: textOf(result), ...(result.isError ? { isError: true } : {}) };
                    } catch (error) {
                        return { content: `MCP call failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
                    }
                },
            }) as unknown as AnyTool,
    );
}
