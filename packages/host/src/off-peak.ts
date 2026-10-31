import { offPeakStart, type PeriodRule, type PriceTable } from '@xora/metering';
import type { ModelRef } from '@xora/protocol';

/**
 * Off-peak waiting for workflow runs (06 §12, 11 §7): a run marked `offPeakOnly` starts once every model it may
 * use is in its vendor's cheap hours. A model's hours come from the price table usage accounting prices it with.
 */

/** Finds the price table of a model; {@link ConnectionService} fits. */
export interface ModelLookup {
    priceTable(ref: ModelRef): PriceTable | undefined;
}

/** Peak-hour rules of the models, once per price table; models without a table or without peak hours add none. */
export function peakRules(models: ModelLookup, refs: readonly ModelRef[]): PeriodRule[] {
    const rules = new Map<string, PeriodRule>();
    for (const ref of refs) {
        const table = models.priceTable(ref);
        if (table?.period && table.period.peak.length > 0) {
            rules.set(table.id, table.period);
        }
    }
    return [...rules.values()];
}

/**
 * When a run that waits for off-peak may start: `at` itself when all its models are off-peak (or have no peak
 * hours), else the moment they all are; undefined when that does not happen within eight days.
 */
export function offPeakStartFor(models: ModelLookup, refs: readonly ModelRef[], at = new Date()): Date | undefined {
    return offPeakStart(peakRules(models, refs), at);
}
