import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const MarkSchema = z.object({ id: z.string(), reason: z.string(), at: z.string() });

/**
 * Persistent boot state, stored as `app/state.json`. Candidate ids are `slot:<version>` or `factory:<version>`;
 * `current`, `previous` and `pending` hold slot versions.
 */
export const BootStateSchema = z.object({
    schemaVersion: z.literal(1),
    current: z.string().optional(),
    previous: z.string().optional(),
    pending: z.string().optional(),
    lastGood: z.string().optional(),
    bad: z.array(MarkSchema).default([]),
    /** Launches started since the candidate last reached "good". */
    attempts: z.record(z.string(), z.number().int().nonnegative()).default({}),
    safeModeRequested: z.boolean().default(false),
    lastFailure: MarkSchema.optional(),
    lastSafeMode: z.object({ reason: z.string(), at: z.string() }).optional(),
    updatedAt: z.string().optional(),
});

export type BootState = z.infer<typeof BootStateSchema>;

export interface LoadedState {
    readonly state: BootState;
    /** Set when an unreadable state file was moved aside and replaced by an empty state. */
    readonly recoveredFrom?: string;
}

export function emptyState(): BootState {
    return { schemaVersion: 1, bad: [], attempts: {}, safeModeRequested: false };
}

export async function loadState(file: string): Promise<LoadedState> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { state: emptyState() };
        }
        throw error;
    }
    try {
        return { state: BootStateSchema.parse(JSON.parse(text)) };
    } catch {
        const aside = `${file}.corrupt-${Date.now()}`;
        await rename(file, aside);
        return { state: emptyState(), recoveredFrom: aside };
    }
}

/** Writes the state atomically: a temporary file in the same directory, then a rename over the old one. */
export async function saveState(file: string, state: BootState): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const next: BootState = { ...state, updatedAt: new Date().toISOString() };
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
}
