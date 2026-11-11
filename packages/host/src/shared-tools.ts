import type { HostToolProvider, SharedTools } from './turns.ts';

/**
 * Several sources of shared tools as one (subagents, memory): their tools and layers in order, their instructions
 * joined, and each call to the source that offers the tool.
 */
export function combineShared(sources: readonly SharedTools[]): SharedTools {
    return {
        names: sources.flatMap((source) => source.names ?? []),
        async tools(thread, extras) {
            const all = await Promise.all(sources.map((source) => source.tools(thread, extras)));
            return all.flat();
        },
        async instructions(thread, extras, text) {
            const parts = await Promise.all(sources.map((source) => source.instructions(thread, extras, text)));
            const given = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
            return given.length > 0 ? given.join('\n\n') : undefined;
        },
        async layers(thread, provider: HostToolProvider | undefined) {
            const all = await Promise.all(sources.map((source) => source.layers?.(thread, provider) ?? []));
            return all.flat();
        },
        handle(name, input, call) {
            const source = sources.find((item) => item.names?.includes(name)) ?? sources[0];
            if (!source) return Promise.resolve({ content: `Tool ${name} is not available here`, isError: true });
            return source.handle(name, input, call);
        },
    };
}
