import type { UsageRow, UsageTotals } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { Badge, Empty, formatMoney, formatTokens, Modal, Spinner } from '../components/primitives.tsx';
import { host } from '../host.ts';
import { attempt, useApp, useStrings } from '../store.ts';

type Range = 'today' | 'week' | 'month' | 'all';
type GroupBy = 'model' | 'provider' | 'project' | 'thread' | 'day';

export function UsageModal() {
    const s = useStrings();
    const version = useApp((state) => state.usageVersion);
    const [range, setRange] = useState<Range>('today');
    const [groupBy, setGroupBy] = useState<GroupBy>('model');
    const [data, setData] = useState<{ totals: UsageTotals; rows: UsageRow[] } | undefined>();
    // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when usage changes
    useEffect(() => {
        void attempt(() => host.call('usage.summary', { range, groupBy })).then((result) => result && setData(result));
    }, [range, groupBy, version]);
    const ranges: Array<[Range, string]> = [
        ['today', s.usage.today],
        ['week', s.usage.week],
        ['month', s.usage.month],
        ['all', s.usage.all],
    ];
    const groups: Array<[GroupBy, string]> = [
        ['model', s.usage.byModel],
        ['provider', s.usage.byProvider],
        ['project', s.usage.byProject],
        ['thread', s.usage.byThread],
        ['day', s.usage.byDay],
    ];
    return (
        <Modal title={s.usage.title} wide onClose={() => useApp.setState({ usageOpen: false })}>
            <div className="usage">
                <div className="segmented">
                    {ranges.map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            className={range === value ? 'is-active' : ''}
                            onClick={() => setRange(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <div className="segmented">
                    {groups.map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            className={groupBy === value ? 'is-active' : ''}
                            onClick={() => setGroupBy(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                {!data ? (
                    <Spinner />
                ) : (
                    <>
                        <div className="usage__totals">
                            <div>
                                <span className="usage__label">{s.usage.total}</span>
                                <strong className="usage__amount">{formatMoney(data.totals.cost)}</strong>
                            </div>
                            <div>
                                <span className="usage__label">{s.usage.requests}</span>
                                <strong>{data.totals.requests}</strong>
                            </div>
                            <div>
                                <span className="usage__label">{s.usage.input}</span>
                                <strong>{formatTokens(data.totals.inputTokens)}</strong>
                            </div>
                            <div>
                                <span className="usage__label">{s.usage.output}</span>
                                <strong>{formatTokens(data.totals.outputTokens)}</strong>
                            </div>
                            <div>
                                <span className="usage__label">{s.usage.cacheHit}</span>
                                <strong>
                                    {data.totals.inputTokens > 0
                                        ? `${Math.round((data.totals.cachedTokens / data.totals.inputTokens) * 100)}%`
                                        : '—'}
                                </strong>
                            </div>
                        </div>
                        {!data.totals.complete && <Badge tone="warn">{s.usage.incomplete}</Badge>}
                        {data.rows.length === 0 ? (
                            <Empty>{s.usage.empty}</Empty>
                        ) : (
                            <table className="table usage__table">
                                <thead>
                                    <tr>
                                        <th />
                                        <th>{s.usage.requests}</th>
                                        <th>{s.usage.input}</th>
                                        <th>{s.usage.output}</th>
                                        <th>{s.usage.cacheHit}</th>
                                        <th>{s.usage.total}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.rows.map((row) => (
                                        <tr key={row.key}>
                                            <td>{row.label}</td>
                                            <td>{row.totals.requests}</td>
                                            <td>{formatTokens(row.totals.inputTokens)}</td>
                                            <td>{formatTokens(row.totals.outputTokens)}</td>
                                            <td>{Math.round(row.cacheHitRate * 100)}%</td>
                                            <td>
                                                {formatMoney(row.totals.cost)}
                                                {!row.totals.complete && ' *'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}
