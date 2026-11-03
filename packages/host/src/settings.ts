import { type Settings, SettingsSchema } from '@xora/protocol';
import { fromJson, type XoraDatabase } from '@xora/storage';

export const DEFAULT_FEED_URL =
    'https://github.com/WhiteNightShadow/xora-code/releases/latest/download/feed-{channel}.json';

export const DEFAULT_SETTINGS: Settings = {
    language: 'system',
    theme: 'system',
    density: 'comfortable',
    defaultModel: null,
    fastModel: null,
    fallbackModels: [],
    defaultMode: 'ask',
    defaultEffort: 'high',
    softContextWindow: 256_000,
    lspDiagnostics: true,
    notifications: { onComplete: true, onApproval: true, onFailure: true },
    preventSleep: true,
    currency: 'CNY',
    usdToCny: 7.1,
    update: { channel: 'stable', feedUrl: DEFAULT_FEED_URL, autoCheck: true },
    budgets: { dailyLimit: null, monthlyLimit: null, turnLimit: null },
    team: { maxParallel: 3 },
    // 06 §24: the user only hears about results, mass deletion and dropping a database.
    approvals: { reviewer: 'supervisor' },
    lastChoices: { teamAutonomy: 'L2', teamMode: 'standard', teamBudget: null, workflowMode: 'default' },
};

const KEY = 'settings';

/** User settings as one JSON row; unknown or invalid stored fields fall back to defaults field by field. */
export class SettingsService {
    readonly #db: XoraDatabase;
    #cache: Settings | undefined;

    constructor(db: XoraDatabase) {
        this.#db = db;
    }

    get(): Settings {
        if (this.#cache) {
            return this.#cache;
        }
        const row = this.#db.get<{ value_json: string }>('select value_json from settings where key = ?', [KEY]);
        const stored = fromJson<Record<string, unknown>>(row?.value_json, {});
        const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
        for (const [key, value] of Object.entries(stored)) {
            const field = SettingsSchema.shape[key as keyof Settings];
            if (field?.safeParse(value).success) {
                merged[key] = value;
            }
        }
        this.#cache = SettingsSchema.parse(merged);
        return this.#cache;
    }

    update(patch: Partial<Settings>): Settings {
        const next = SettingsSchema.parse({ ...this.get(), ...patch });
        this.#db.run(
            'insert into settings (key, value_json) values (?, ?) on conflict (key) do update set value_json = excluded.value_json',
            [KEY, JSON.stringify(next)],
        );
        this.#cache = next;
        return next;
    }
}
