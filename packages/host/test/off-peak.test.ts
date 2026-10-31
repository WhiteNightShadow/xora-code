import { priceTableFor } from '@xora/metering';
import type { ModelRef } from '@xora/protocol';
import { describe, expect, it } from 'vitest';
import type { ConnectionService } from '../src/connections.ts';
import { type ModelLookup, offPeakStartFor, peakRules } from '../src/off-peak.ts';

// The connection service is what the workflow service hands in.
const fromConnections: (connections: ConnectionService) => ModelLookup = (connections) => connections;

const PRICING: Record<string, string | undefined> = {
    'deepseek-flash': 'deepseek-flash@2026-10',
    'glm-5.3': 'glm-5.3@2026-10',
    'glm-5.3-flash': undefined,
};

/** Connection `c1` knows the presets' models, `local` is a local server; any other connection has been removed. */
const models: ModelLookup = {
    priceTable(ref: ModelRef) {
        return priceTableFor({
            id: ref.model,
            pricing: ref.connectionId === 'c1' ? PRICING[ref.model] : undefined,
            channel: ref.connectionId === 'local' ? 'local' : undefined,
        });
    },
};

const flash = { connectionId: 'c1', model: 'deepseek-flash' };
const glm = { connectionId: 'c1', model: 'glm-5.3' };

describe('off-peak waiting for workflow runs', () => {
    it('collects the peak rules of the models a run uses, once per price table', () => {
        expect(fromConnections).toBeTypeOf('function');
        const rules = peakRules(models, [flash, glm, flash]);
        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({ timezone: 'Asia/Shanghai', offPeakMultiplier: 0.5 });
        // glm has no peak hours; a model without a price table adds nothing.
        expect(peakRules(models, [glm, { connectionId: 'c1', model: 'glm-5.3-flash' }])).toEqual([]);
        expect(peakRules(models, [{ connectionId: 'c1', model: 'local-qwen' }])).toEqual([]);
        // A local server does not follow the vendor's hours, even when it serves the vendor's model.
        expect(peakRules(models, [{ connectionId: 'local', model: 'deepseek-flash' }])).toEqual([]);
    });

    it('falls back to the model id when the connection is gone', () => {
        expect(peakRules(models, [{ connectionId: 'gone', model: 'deepseek-flash' }])).toHaveLength(1);
    });

    it('starts a deepseek run when the peak window closes, others at once', () => {
        const mondayMorning = new Date('2026-10-26T10:00:00+08:00');
        expect(offPeakStartFor(models, [flash, glm], mondayMorning)?.toISOString()).toBe(
            new Date('2026-10-26T12:00:00+08:00').toISOString(),
        );
        expect(offPeakStartFor(models, [glm], mondayMorning)?.getTime()).toBe(mondayMorning.getTime());
        expect(offPeakStartFor(models, [], mondayMorning)?.getTime()).toBe(mondayMorning.getTime());
        const saturday = new Date('2026-10-31T10:00:00+08:00');
        expect(offPeakStartFor(models, [flash], saturday)?.getTime()).toBe(saturday.getTime());
    });
});
