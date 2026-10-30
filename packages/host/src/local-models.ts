import { listPresets } from '@xora/providers';

export interface LocalServer {
    readonly presetId: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly models: string[];
}

/**
 * Looks for OpenAI-compatible model servers on this machine at the default endpoints of the local presets
 * (ollama, lm studio, llama.cpp, vllm). Only runs when the user asks; each probe is one short GET `/models`.
 */
export async function detectLocalServers(fetcher: typeof fetch = fetch, timeoutMs = 1200): Promise<LocalServer[]> {
    const presets = listPresets().filter((preset) => preset.channel === 'local' && preset.endpoints.openai_chat);
    const results = await Promise.all(
        presets.map(async (preset): Promise<LocalServer | undefined> => {
            const baseUrl = preset.endpoints.openai_chat as string;
            try {
                const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/models`, {
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!response.ok) {
                    return undefined;
                }
                const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
                const models = (body.data ?? [])
                    .map((model) => model.id)
                    .filter((id): id is string => typeof id === 'string');
                return { presetId: preset.id, name: preset.name, baseUrl, models };
            } catch {
                return undefined;
            }
        }),
    );
    return results.filter((server): server is LocalServer => server !== undefined);
}
