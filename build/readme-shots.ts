import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { type ElectronApplication, _electron as electron, type Page } from 'playwright-core';
import {
    startMockModelServer,
    openaiText as textTurn,
    openaiToolCalls as toolTurn,
} from '../packages/test-kit/src/index.ts';
import { forgetAppCopy, secretStoreSwitches } from './app-switches.ts';

/**
 * The README's screenshots (docs/images/), taken in the real app against a scripted model server and a demo
 * project, so they show the product without anyone's paths, accounts or keys: a fix in a conversation with its plan
 * and diff (light and dark), the organization tree, one member's panel, the talent market, the state of the work a
 * compaction left in that conversation, a team run and a conversation with the chief assistant.
 *
 *   node build/readme-shots.ts                 unpackaged shell with dist/app-bundle (run `pnpm build && pnpm bundle`)
 *   node build/readme-shots.ts --app <exe>     a packaged build
 *   node build/readme-shots.ts --out <dir>     where the PNGs go; docs/images by default
 *   node build/readme-shots.ts --show          with the window on screen
 */

const { values } = parseArgs({
    options: {
        app: { type: 'string' },
        out: { type: 'string' },
        show: { type: 'boolean', default: false },
        keep: { type: 'boolean', default: false },
    },
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const outDir = path.resolve(values.out ?? path.join(repoRoot, 'docs', 'images'));
const work = await mkdtemp(path.join(tmpdir(), 'xora-shots-'));
const WIDTH = 1280;
const HEIGHT = 800;

/** A packaged build runs from a copy with the inspector fuse on, as in ui-smoke.ts. */
/** The copy of the app a packaged build runs from, which LaunchServices must forget afterwards. */
let appCopy: string | undefined;

async function inspectable(executable: string): Promise<string> {
    const wire = await getCurrentFuseWire(executable);
    if (wire[FuseV1Options.EnableNodeCliInspectArguments] !== '0'.charCodeAt(0)) {
        return executable;
    }
    const appDir =
        process.platform === 'darwin'
            ? executable.slice(0, executable.lastIndexOf('.app') + '.app'.length)
            : path.dirname(executable);
    const copyDir = path.join(work, 'app', path.basename(appDir));
    appCopy = copyDir;
    await cp(appDir, copyDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const copy = path.join(copyDir, path.relative(appDir, executable));
    await flipFuses(copy, {
        version: FuseVersion.V1,
        [FuseV1Options.EnableNodeCliInspectArguments]: true,
        resetAdHocDarwinSignature: process.platform === 'darwin',
    });
    return copy;
}

const executablePath = values.app
    ? await inspectable(path.resolve(values.app))
    : (createRequire(path.join(desktopDir, 'package.json'))('electron') as string);

// The demo project ------------------------------------------------------------------------------------------

const repo = path.join(work, 'shop-api');
const ORDER = `/** The total of an order, in yuan. */
export function orderTotal(items) {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/** A coupon takes its amount off, never below zero. */
export function applyCoupon(total, coupon) {
    return Math.max(0, total - coupon.amount);
}
`;
const ORDER_FIXED_BODY = `/** The total of an order, in yuan: summed in fen, so 0.1 × 3 is 0.3. */
export function orderTotal(items) {
    const fen = items.reduce((sum, item) => sum + Math.round(item.price * 100) * item.quantity, 0);
    return fen / 100;
}`;
const TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoupon, orderTotal } from '../src/order.js';

test('sums the items of an order', () => {
    assert.equal(orderTotal([{ price: 12, quantity: 2 }]), 24);
});

test('a coupon never takes the total below zero', () => {
    assert.equal(applyCoupon(5, { amount: 8 }), 0);
});
`;
const TEST_ADDED = `

test('sums prices in fen, without floating point drift', () => {
    assert.equal(orderTotal([{ price: 0.1, quantity: 3 }]), 0.3);
    assert.equal(orderTotal([{ price: 19.9, quantity: 3 }, { price: 0.2, quantity: 1 }]), 59.9);
});
`;

/** The files once the thread has fixed the total (committed before the team run starts). */
const FIXED_ORDER = ORDER.replace(ORDER.split('\n\n')[0] ?? '', ORDER_FIXED_BODY);
const FIXED_TEST = `${TEST.trimEnd()}${TEST_ADDED}`;
const COUPON_OLD = `/** A coupon takes its amount off, never below zero. */
export function applyCoupon(total, coupon) {
    return Math.max(0, total - coupon.amount);
}`;
const COUPON_NEW = `/** A coupon takes its amount off, never below zero; in fen, like the total. */
export function applyCoupon(total, coupon) {
    const fen = Math.round(total * 100) - Math.round(coupon.amount * 100);
    return Math.max(0, fen) / 100;
}`;
const COUPON_TEST = `
test('takes coupons off in fen', () => {
    assert.equal(applyCoupon(0.3, { amount: 0.1 }), 0.2);
});
`;

/**
 * Every answer reports its usage as DeepSeek does, so tokens and costs read as they would: most of a prompt read
 * from the cache, a few hundred tokens out. Made up, but the same on every run.
 */
let served = 0;
function usage(): Record<string, number> {
    served++;
    const prompt = 6_000 + ((served * 2_741) % 9_000);
    const hit = Math.round(prompt * (0.72 + ((served * 37) % 20) / 100));
    return {
        prompt_tokens: prompt,
        completion_tokens: 180 + ((served * 113) % 700),
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: prompt - hit,
    };
}
const openaiText = (text: string, options: Parameters<typeof textTurn>[1] = {}) =>
    textTurn(text, { usage: usage(), ...options });
const openaiToolCalls = (items: Parameters<typeof toolTurn>[0], options: Parameters<typeof toolTurn>[1] = {}) =>
    toolTurn(items, { usage: usage(), ...options });

function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

await mkdir(path.join(repo, 'src'), { recursive: true });
await mkdir(path.join(repo, 'test'), { recursive: true });
await mkdir(path.join(repo, '.xora', 'workflows'), { recursive: true });
await writeFile(
    path.join(repo, 'package.json'),
    `${JSON.stringify({ name: 'shop-api', version: '0.4.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
);
await writeFile(path.join(repo, 'README.md'), '# shop-api\n\n商城的订单与支付接口。\n');
await writeFile(path.join(repo, 'src', 'order.js'), ORDER);
await writeFile(path.join(repo, 'test', 'order.test.js'), TEST);
await writeFile(
    path.join(repo, '.xora', 'workflows', 'release-check.yaml'),
    [
        'name: release-check',
        'title: 发布前检查',
        'description: 发版前看改动、跑测试、做一次审查',
        'steps:',
        '  - id: changes',
        '    agent: scout',
        '    task: 列出上次发布以来的改动和受影响的接口',
        '    outputs: [summary]',
        '  - id: tests',
        '    run: node --test',
        '  - id: review',
        '    agent: reviewer',
        '    needs: [changes, tests]',
        '    task: "审查这些改动有没有风险：{{steps.changes.outputs.summary}}"',
        '    outputs: [verdict]',
        '',
    ].join('\n'),
);
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'dev@example.com');
git('config', 'user.name', 'Dev');
git('add', '.');
git('commit', '-q', '-m', 'orders and coupons');

// The scripted model ----------------------------------------------------------------------------------------

interface Message {
    readonly role: string;
    readonly content?: unknown;
    readonly tool_calls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
}
interface Body {
    readonly model?: string;
    readonly messages?: readonly Message[];
    readonly tools?: ReadonlyArray<{ function?: { name?: string } }>;
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('\n');
    return '';
}
const has = (body: Body, tool: string) => body.tools?.some((item) => item.function?.name === tool) ?? false;
const systemOf = (body: Body) => textOf(body.messages?.find((message) => message.role === 'system')?.content);
const userText = (body: Body) =>
    (body.messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => textOf(message.content))
        .join('\n');
/** The agent of a team or workflow thread, from the title of its agent layer. */
const agentOf = (body: Body) => /<agent_instructions title="agent：([^"]+)"/.exec(systemOf(body))?.[1] ?? '';
/** How many times the model has called tools in this conversation. */
const rounds = (body: Body) => (body.messages ?? []).filter((message) => message.tool_calls?.length).length;
const lastTool = (body: Body) =>
    [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.tool_calls?.length)
        ?.tool_calls?.at(-1)?.function.name;
const calls = (...items: Array<{ name: string; arguments: unknown }>) =>
    openaiToolCalls(items.map((item) => ({ name: item.name, arguments: JSON.stringify(item.arguments) })));

const server = await startMockModelServer({
    models: [
        { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
        { id: 'deepseek-flash', displayName: 'DeepSeek Flash' },
        { id: 'kimi-k3', displayName: 'Kimi K3' },
        { id: 'kimi-k3.1-pro', displayName: 'Kimi K3.1 Pro' },
    ],
});

const CARDS = [
    {
        id: 'T1',
        title: '优惠券按分计算',
        goal: 'applyCoupon按分相减，0.3元减0.1元等于0.2元',
        category: 'coding',
        tier: 'economy',
        ownership: ['src/order.js'],
        acceptance: [{ type: 'command', run: 'node --test' }],
        deliverable: { kind: 'code-change' },
        budget: { cost: 2 },
        workspace: 'worktree',
    },
    {
        id: 'T2',
        title: '补优惠券的测试',
        goal: '测试覆盖小数金额的优惠券',
        category: 'testing',
        tier: 'economy',
        dependsOn: ['T1'],
        ownership: ['test/order.test.js'],
        acceptance: [{ type: 'command', run: 'node --test' }],
        deliverable: { kind: 'code-change' },
        budget: { cost: 2 },
        workspace: 'worktree',
    },
    {
        id: 'T3',
        title: '更新CHANGELOG',
        goal: 'CHANGELOG写明这次金额计算的修正',
        category: 'docs',
        tier: 'economy',
        dependsOn: ['T1'],
        ownership: ['CHANGELOG.md'],
        acceptance: [{ type: 'command', run: 'test -f CHANGELOG.md' }],
        deliverable: { kind: 'doc-change' },
        budget: { cost: 1 },
        workspace: 'worktree',
    },
];

function taskOf(body: Body): string {
    return /<task_card id="([^"]+)"/.exec(userText(body))?.[1] ?? '';
}

/** A member working a card writes its file, then hands it in. */
function member(body: Body) {
    const task = taskOf(body);
    if (lastTool(body) === 'deliver') return openaiText(`${task}交了。`);
    if (rounds(body) > 0) {
        const done: Record<string, { summary: string; file: string }> = {
            T1: { summary: 'applyCoupon改成按分相减，0.3元减0.1元得0.2元，node --test通过', file: 'src/order.js' },
            T2: { summary: '补了小数金额优惠券的用例，4条测试全过', file: 'test/order.test.js' },
            T3: { summary: 'CHANGELOG记下0.4.1修正了订单和优惠券金额的精度', file: 'CHANGELOG.md' },
        };
        const entry = done[task] ?? { summary: '完成', file: 'README.md' };
        return calls({
            name: 'deliver',
            arguments: {
                status: 'done',
                summary: entry.summary,
                changes: [{ file: entry.file, kind: task === 'T3' ? 'added' : 'modified' }],
                evidence: [{ type: 'command', run: 'node --test', exit: 0, output: '# pass 4\n# fail 0' }],
            },
        });
    }
    if (task === 'T1') {
        return calls({
            name: 'write',
            arguments: { path: 'src/order.js', content: FIXED_ORDER.replace(COUPON_OLD, COUPON_NEW) },
        });
    }
    if (task === 'T2') {
        return calls({
            name: 'write',
            arguments: { path: 'test/order.test.js', content: `${FIXED_TEST}${COUPON_TEST}` },
        });
    }
    return calls({
        name: 'write',
        arguments: {
            path: 'CHANGELOG.md',
            content:
                '# Changelog\n\n## 0.4.1\n\n- 订单总价和优惠券都改成按分计算，0.1元×3件不再算成0.30000000000000004。\n',
        },
    });
}

function supervisor(body: Body) {
    const last = body.messages?.at(-1);
    if (last?.role === 'tool') {
        return openaiText(
            lastTool(body) === 'task_create'
                ? '计划好了：先改applyCoupon，测试和CHANGELOG等它做完再并行。'
                : '收到，接着推进。',
        );
    }
    const input = textOf(last?.content);
    if (input.includes('<team_goal>')) {
        return calls(
            { name: 'task_create', arguments: { tasks: CARDS } },
            {
                name: 'ledger_update',
                arguments: {
                    reason: '第一版计划',
                    plan: '先把applyCoupon改成按分计算，再补测试、更新CHANGELOG',
                    facts: ['orderTotal已经按分计算，applyCoupon还按元相减', '测试用node --test'],
                    risks: ['叠加多张优惠券的规则这次不动'],
                },
            },
        );
    }
    if (input.includes('Plan review')) return openaiText('评审没有问题，按计划派工。');
    if (/T1[^\n]*(accepted|done|passed)/i.test(input)) return openaiText('T1验收通过，测试和CHANGELOG开始做。');
    if (/T2|T3/.test(input)) return openaiText('三张卡都过了验收，整理交付。');
    return openaiText('进展正常。');
}

server.respondWith((request) => {
    if (request.method !== 'POST') return undefined;
    const body = (request.body ?? {}) as Body;
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const user = userText(body);

    // 06 §28: the gist of a request as a conversation's title.
    if (systemOf(body).includes('给一段对话起标题')) {
        const titles: Array<[string, string]> = [
            ['精度', '修复订单金额的精度问题'],
            ['登录接口', '整理登录接口的请求链路'],
            ['优惠券', '优惠券改成按分计算'],
            ['做到哪', 'shop-api本周进展'],
        ];
        return openaiText(titles.find(([word]) => user.includes(word))?.[1] ?? 'shop-api的改动');
    }
    // The chief assistant (06 §23) answers from what the team did this week.
    if (systemOf(body).includes('You are the chief assistant of Xora Code')) {
        return openaiText(
            [
                '这周shop-api两件事都做完了：',
                '',
                '1. **订单金额按分计算**：修掉了0.1元买3件算成0.30000000000000004的问题，补了三条测试，发布前检查结论是可以发布。',
                '2. **优惠券也改成按分计算**：团队做完并验收，叠加优惠的测试已经补上，CHANGELOG写好了。',
                '',
                '需要你决定的只有一件：要不要现在打`v0.4.1`标签发布。说一声我就让成员去做。',
            ].join('\n'),
        );
    }
    // The supervisor scores each card once the report is written (19 §9): a small move on a base from the facts.
    if (systemOf(body).includes('scoring how your members did')) {
        return openaiText(
            JSON.stringify({
                scores: [
                    { task: 'T1', adjust: 4, reason: '按分相减改得干净，验收一次通过' },
                    { task: 'T2', adjust: 3, reason: '用例覆盖了小数金额和减到0' },
                    { task: 'T3', adjust: 0, reason: 'CHANGELOG写清了这次修正' },
                ],
            }),
        );
    }
    // The team run's report: what it set out to do and did.
    if (
        !body.tools?.length &&
        JSON.stringify(messages).includes('## 目标达成') &&
        user.includes('优惠券也改成按分计算')
    ) {
        return openaiText(
            [
                '## 目标达成',
                '优惠券也按分计算了：0.3元减0.1元得0.2元，不再有小数误差；`node --test`四条全过，CHANGELOG记好了。',
                '',
                '## 已完成',
                '- `applyCoupon`改成按分相减（`src/order.js`）',
                '- 补了小数金额优惠券的用例，4条测试全过（`test/order.test.js`）',
                '- CHANGELOG记下0.4.1修正了订单和优惠券金额的精度（`CHANGELOG.md`）',
                '',
                '## 下一步',
                '- 打`v0.4.1`标签并发布',
            ].join('\n'),
        );
    }
    // The brief of the finished workflow run.
    if (!body.tools?.length && JSON.stringify(messages).includes('## 目标达成')) {
        return openaiText(
            [
                '## 目标达成',
                '可以发布：上次发布以来只改了订单金额的计算，`node --test`三条全过，审查没有阻塞问题。',
                '',
                '## 已完成',
                '- 订单金额改成按分计算，修掉了小数精度问题（`src/order.js`）',
                '- 补了三条金额测试，全部通过（`test/order.test.js`）',
                '',
                '## 下一步',
                '- 打`v0.4.1`标签并发布',
                '- 下个版本把`applyCoupon`也改成按分计算，补一条叠加优惠的测试',
            ].join('\n'),
        );
    }
    // Workflow steps.
    if (has(body, 'step_result')) {
        if (last?.role === 'tool') return openaiText('交回了。');
        return agentOf(body) === 'Reviewer'
            ? calls({
                  name: 'step_result',
                  arguments: {
                      summary: '没有阻塞问题：金额按分计算，测试覆盖了小数单价；applyCoupon仍按元相减，建议下个版本改',
                      outputs: { verdict: '通过，有1条建议' },
                  },
              })
            : calls({
                  name: 'step_result',
                  arguments: {
                      summary: '上次发布以来改了订单金额的计算，补了2条测试',
                      outputs: {
                          summary: '- src/order.js：orderTotal按分累加\n- test/order.test.js：小数单价和多件混合的用例',
                      },
                  },
              });
    }
    // The team run.
    switch (agentOf(body)) {
        case 'Supervisor':
            return supervisor(body);
        case 'Plan reviewer':
            return openaiText(
                '计划和代码对得上。\n\n```json\n{"verdict": "pass", "summary": "顺序合理，验收命令能跑", "issues": []}\n```',
            );
        case 'Coder':
        case '编码':
        case 'Tester':
        case 'Writer':
            return member(body);
        default:
            break;
    }
    // A member's conversation.
    if (user.includes('整理一下登录接口的请求链路')) {
        return openaiText(
            [
                '登录链路一共三步：',
                '',
                '1. `GET /api/v2/captcha`：拿图形验证码，返回`captchaId`',
                '2. `POST /api/v2/session`：账号、密码和验证码，请求头带`x-sign`（时间戳加请求体的签名）',
                '3. `GET /api/v2/profile`：带上一步返回的`token`拿用户信息',
                '',
                '签名的算法和抓包代理的设置已经记进记忆，下次直接用。',
            ].join('\n'),
        );
    }
    // A compaction asks for what only the model can judge (20 §4.4): how the work went, and the ledger's entries. A
    // constraint quotes the user's words exactly.
    if (JSON.stringify(last ?? '').includes('The context is nearly full')) {
        return openaiText(
            [
                '<narrative>',
                '`orderTotal`改成先把每件的单价换成分（`Math.round(price × 100)`）再乘数量，加完再换回元，`0.1 × 3`不再算成`0.30000000000000004`；`test/order.test.js`补了小数单价和多件混合的用例，`node --test`三条都通过。下一步等用户决定`applyCoupon`要不要也按分算。',
                '</narrative>',
                '<ledger>',
                JSON.stringify({
                    add: [
                        { kind: 'constraint', text: '修好之后要补上测试', quote: '补上测试' },
                        {
                            kind: 'decision',
                            text: '金额一律先换成分（整数）再算，展示时再换回元',
                            why: '按元相加的浮点数有误差，整数运算没有',
                        },
                        { kind: 'fact', text: '测试用`node --test`跑，三条都通过' },
                        { kind: 'question', text: '`applyCoupon`也在按元相减，要不要一起改成按分算' },
                    ],
                    close: [],
                }),
                '</ledger>',
            ].join('\n'),
        );
    }
    // The fix in a thread: plan, read, change, test, report.
    if (user.includes('订单总价有精度问题')) {
        const todo = (statuses: string[]) => ({
            name: 'todo',
            arguments: {
                items: ['读orderTotal的实现', '改成按分计算', '补测试并跑通'].map((content, index) => ({
                    content,
                    status: statuses[index],
                })),
            },
        });
        switch (rounds(body)) {
            case 0:
                return calls(todo(['in_progress', 'pending', 'pending']), {
                    name: 'read',
                    arguments: { path: 'src/order.js' },
                });
            case 1:
                return calls({
                    name: 'edit',
                    arguments: {
                        path: 'src/order.js',
                        oldString: ORDER.split('\n\n')[0],
                        newString: ORDER_FIXED_BODY,
                    },
                });
            case 2:
                // The plan moves on as it goes (03 §4): a line where it changed, the latest above the composer.
                return calls(todo(['completed', 'completed', 'in_progress']), {
                    name: 'edit',
                    arguments: {
                        path: 'test/order.test.js',
                        oldString: '    assert.equal(applyCoupon(5, { amount: 8 }), 0);\n});\n',
                        newString: `    assert.equal(applyCoupon(5, { amount: 8 }), 0);\n});${TEST_ADDED}`,
                    },
                });
            case 3:
                return calls({ name: 'bash', arguments: { command: 'node --test', description: '跑测试' } });
            case 4:
                return calls(todo(['completed', 'completed', 'completed']));
            default:
                return openaiText(
                    [
                        '改好了，`node --test`三条都通过。',
                        '',
                        '- **原因**：`orderTotal`直接按元相加，`0.1 × 3`在浮点数里是`0.30000000000000004`。',
                        '- **改法**：每件商品先换成分（`Math.round(price × 100)`）再乘数量，加完再换回元。',
                        '- **测试**：补了`0.1 × 3 = 0.3`和多件混合的用例。',
                        '',
                        '优惠券的`applyCoupon`也在按元做减法，要不要一起改成按分算？',
                    ].join('\n'),
                );
        }
    }
    return openaiText('好的。');
});

// The app ---------------------------------------------------------------------------------------------------

function launch(data: string): Promise<ElectronApplication> {
    return electron.launch({
        executablePath,
        args: [...(values.app ? [] : [desktopDir]), ...secretStoreSwitches(), '--lang=zh-CN'],
        env: {
            ...process.env,
            XORA_DATA_DIR: data,
            XORA_TEST_PLAIN_SECRETS: '1',
            ...(values.show ? {} : { XORA_TEST_HIDE_WINDOWS: '1' }),
            ELECTRON_RUN_AS_NODE: '',
        } as Record<string, string>,
        timeout: 60_000,
    });
}

let calling: Promise<unknown> = Promise.resolve();

/**
 * Calls the host over a fresh port, as ui-smoke.ts does. One call at a time: the approval loop runs beside the
 * steps, and two calls waiting for a port at once could take the same one.
 */
function hostCall<T = unknown>(page: Page, method: string, params: unknown): Promise<T> {
    const call = calling.then(() => portCall<T>(page, method, params));
    calling = call.catch(() => undefined);
    return call;
}

async function portCall<T>(page: Page, method: string, params: unknown): Promise<T> {
    return page.evaluate(
        ([method, params]) =>
            new Promise<unknown>((resolve, reject) => {
                const onMessage = (event: MessageEvent) => {
                    const port = event.ports[0];
                    if ((event.data as { type?: string } | null)?.type !== 'xora:port' || !port) return;
                    window.removeEventListener('message', onMessage);
                    const id = `shots-${Math.random().toString(36).slice(2)}`;
                    // The port also carries the host's notifications: only the reply with this id answers the call.
                    port.onmessage = (reply) => {
                        const data = reply.data as { id?: string; result?: unknown; error?: { message: string } };
                        if (data.id !== id) return;
                        if (data.error) reject(new Error(data.error.message));
                        else resolve(data.result);
                        port.close();
                    };
                    port.postMessage({ jsonrpc: '2.0', id, method, params });
                };
                window.addEventListener('message', onMessage);
                (window as unknown as { xoraShell: { requestPort(): void } }).xoraShell.requestPort();
            }),
        [method, params] as const,
    ) as Promise<T>;
}

/** Answers every approval card, the way a user who agrees would. */
function approveAll(page: Page): () => void {
    let stopped = false;
    const loop = async () => {
        while (!stopped) {
            try {
                const pending = await hostCall<Array<{ id: string; toolName?: string }>>(page, 'approval.list', {});
                for (const approval of pending) {
                    await hostCall(page, 'approval.respond', {
                        approvalId: approval.id,
                        decision: approval.toolName === 'acceptance' ? 'allow_session' : 'allow_once',
                    }).catch(() => undefined);
                }
            } catch {
                // The window is busy or reloading.
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    };
    void loop();
    return () => {
        stopped = true;
    };
}

/** Waits until the host's answer to `method` satisfies `done`. */
async function until<T>(page: Page, method: string, params: unknown, done: (value: T) => boolean, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await hostCall<T>(page, method, params);
        if (done(value)) return value;
        if (Date.now() > deadline)
            throw new Error(
                `${method} did not get there in ${timeoutMs / 1000}s: ${JSON.stringify(value).slice(0, 400)}`,
            );
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

/** Waits until a thread is no longer running. */
async function settled(page: Page, threadId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await until(
        page,
        'thread.list',
        {},
        (threads: Array<{ id: string; status: string }>) =>
            threads.find((thread) => thread.id === threadId)?.status !== 'running',
    );
}

/** A promise that gives up after `ms`, so a stuck page or app turns into an error with a name. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000}s`)), ms),
        ),
    ]);
}

const started = Date.now();
function phase(name: string): void {
    console.log(`… ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
}

async function shot(page: Page, name: string): Promise<void> {
    await page.evaluate(() => {
        for (const element of document.querySelectorAll('.toast')) element.remove();
        (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.mouse.move(WIDTH - 2, HEIGHT - 2);
    await page.waitForTimeout(600);
    await within(page.screenshot({ path: path.join(outDir, `${name}.png`) }), 30_000, `screenshot ${name}`);
    console.log(`✓ ${name}.png`);
}

await mkdir(outDir, { recursive: true });
const app = await launch(path.join(work, 'data'));
let failed = false;
let stopApproving: () => void = () => undefined;
try {
    const page = await app.firstWindow({ timeout: 60_000 });
    page.setDefaultTimeout(60_000);
    await app.evaluate(
        ({ BrowserWindow }, size) => {
            const [window] = BrowserWindow.getAllWindows();
            window?.setContentSize(size.width, size.height);
        },
        { width: WIDTH, height: HEIGHT },
    );
    await page.locator('.welcome').waitFor();

    // The DeepSeek preset, pointed at the scripted server: its models come with their prices.
    const connection = await hostCall<{ id: string }>(page, 'provider.save', {
        presetId: 'deepseek',
        name: 'DeepSeek',
        apiKey: 'demo-key',
        baseUrl: server.url,
    });
    await hostCall(page, 'provider.refreshModels', { connectionId: connection.id });
    await hostCall(page, 'settings.update', {
        patch: {
            defaultModel: { connectionId: connection.id, model: 'deepseek-v4-pro' },
            defaultMode: 'auto_edit',
            theme: 'light',
        },
    });
    const project = await hostCall<{ id: string }>(page, 'project.add', { path: repo });
    await hostCall(page, 'project.trust', { projectId: project.id, trusted: true });
    await page.reload();
    await page.locator('.project__name', { hasText: 'shop-api' }).waitFor();
    stopApproving = approveAll(page);

    // Members with a memory and routines, and a conversation with one of them.
    const packet = await hostCall<{ id: string }>(page, 'member.save', {
        scope: 'user',
        member: {
            name: '抓包侦察',
            role: 'scout',
            tier: 'fast',
            mode: 'plan',
            description: '抓app的接口、整理请求链路和签名',
            prompt: '你负责抓包分析：先确认代理和证书正常，再抓目标接口，交回接口清单（方法、路径、关键参数）和签名方式，每条附上抓到的请求。',
        },
    });
    // Its notes in this project (06 §21: general notes, a project's and the team's are kept apart).
    await hostCall(page, 'member.setMemory', {
        memberId: packet.id,
        scope: 'project',
        projectId: project.id,
        text: [
            '- [shop-api 2026-10-30] 登录接口是POST /api/v2/session，签名在请求头x-sign',
            '- [shop-api 2026-10-31] 抓包走本机代理127.0.0.1:9090，模拟器里已经装了证书',
            '- [shop-api 2026-11-01] 用户希望结论先列接口清单，再写细节',
        ].join('\n'),
    });
    await hostCall(page, 'member.saveRoutine', {
        memberId: packet.id,
        routine: {
            title: '早上检查抓包链路',
            schedule: '0 9 * * 1-5',
            projectId: project.id,
            instruction: '检查代理和证书是否正常，抓一次登录接口，看x-sign的算法有没有变',
            enabled: true,
        },
    });
    const daily = await hostCall<{ id: string }>(page, 'member.save', {
        scope: 'user',
        member: {
            name: '日报员',
            role: 'executor',
            category: 'docs',
            tier: 'economy',
            mode: 'auto_edit',
            description: '汇总当天的提交和线程，写成日报',
            prompt: '你负责写日报：按项目汇总当天的提交、完成的线程和遗留问题，写进docs/daily/日期.md。',
        },
    });
    await hostCall(page, 'member.saveRoutine', {
        memberId: daily.id,
        routine: {
            title: '写今天的日报',
            schedule: '30 18 * * 1-5',
            projectId: project.id,
            instruction: '汇总今天的提交和线程，写进docs/daily/',
            enabled: true,
        },
    });
    // The coder with instructions in the user's words, as people write their own (its panel shows them).
    const roster = await hostCall<Array<{ id: string; tier: string; mode: string }>>(page, 'member.list', {});
    const coder = roster.find((member) => member.id === 'coder');
    await hostCall(page, 'member.save', {
        scope: 'user',
        member: {
            id: 'coder',
            name: '编码',
            role: 'executor',
            category: 'coding',
            tier: coder?.tier ?? 'economy',
            mode: coder?.mode ?? 'auto_edit',
            description: '按任务卡写代码，在自己的worktree里改',
            prompt: [
                '你负责按任务卡写代码：',
                '- 先读卡片的目标、文件归属和验收命令，只改归属里的文件；要动别的文件就停下来说明原因。',
                '- 金额一律按分计算，不用浮点数相加。',
                '- 改完自己跑一遍验收命令，交付时写清改了什么、怎么验证的、还有什么没做。',
            ].join('\n'),
        },
    });
    const memories: Record<string, string[]> = {
        coder: [
            '- [shop-api 2026-10-29] 测试用node --test，提交前要跑通',
            '- [shop-api 2026-11-01] 金额一律按分计算，不用浮点数',
        ],
        scout: ['- [shop-api 2026-10-28] 订单相关的代码都在src/order.js，接口定义在docs/api.md'],
        reviewer: ['- [shop-api 2026-10-30] 用户要求审查结论按严重程度排序，先列阻塞问题'],
    };
    for (const [memberId, notes] of Object.entries(memories)) {
        await hostCall(page, 'member.setMemory', { memberId, text: notes.join('\n') });
    }
    phase('member conversation');
    // Everything below runs one after another: two turns in the same folder at once would count each other's
    // changes as their own.
    const chat = await hostCall<{ id: string }>(page, 'member.chat', {
        projectId: project.id,
        memberId: packet.id,
        text: '整理一下登录接口的请求链路',
    });
    await settled(page, chat.id);

    phase('fix in a thread');
    // The fix in a thread, opened from the project's "+".
    await page.locator('.project__header').getByRole('button', { name: '新建', exact: true }).first().click();
    await page.getByRole('menuitemradio', { name: /新建对话/ }).click();
    await page
        .locator('.new-thread textarea')
        .fill('订单总价有精度问题：0.1元的商品买3件，算出来是0.30000000000000004。帮我修一下，补上测试');
    await page.locator('.new-thread').getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('要不要一起改成按分算').waitFor({ timeout: 90_000 });
    // The title a user would give it.
    const threads = await hostCall<
        Array<{
            id: string;
            createdAt: number;
            agentId?: string;
            teamRunId?: string;
            workflowRunId?: string;
            parent?: unknown;
        }>
    >(page, 'thread.list', {});
    const fix = threads
        .filter((thread) => !thread.agentId && !thread.teamRunId && !thread.workflowRunId && !thread.parent)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (fix) await hostCall(page, 'thread.update', { threadId: fix.id, title: '修复订单金额的精度问题' });
    await page.locator('.changes-card').first().click();
    await page.locator('.diff__row--add').first().waitFor();
    await shot(page, 'xora-workspace');
    await hostCall(page, 'settings.update', { patch: { theme: 'dark' } });
    await page.waitForTimeout(800);
    await shot(page, 'xora-workspace-dark');
    await hostCall(page, 'settings.update', { patch: { theme: 'light' } });
    await page.waitForTimeout(500);
    // What the thread fixed is committed, as a user would before the release check and the next change.
    git('commit', '-q', '-am', 'fix: sum order totals in fen');

    phase('compaction');
    // 20 §4.2: the fix thread's turns become the state of the work, as `/compact` makes them.
    if (!fix) throw new Error('no fix thread to compact');
    await hostCall(page, 'turn.compact', { threadId: fix.id });
    await settled(page, fix.id);

    phase('workflow run');
    // A workflow run, to its conclusion.
    const run = await hostCall<{ id: string }>(page, 'workflow.start', {
        projectId: project.id,
        key: 'project:release-check',
        mode: 'full',
    });
    await until(
        page,
        'workflow.get',
        { runId: run.id },
        (view: { brief?: { status: string } }) => view.brief?.status === 'ready' || view.brief?.status === 'failed',
    );

    phase('team run');
    // A team run takes the next change (the coupon the thread asked about), to its delivery.
    const team = await hostCall<{ id: string }>(page, 'team.start', {
        projectId: project.id,
        goal: '优惠券也改成按分计算，补测试，更新CHANGELOG',
        autonomy: 'L2',
        budget: 20,
    });
    await until(
        page,
        'team.get',
        { runId: team.id },
        (view: { status: string }) => ['done', 'failed', 'paused', 'stopped'].includes(view.status),
        240_000,
    );

    phase('members');
    // The organization tree (19 §11): the back end and the reverse engineering get organizations of their own under
    // the R&D team, each with a prompt its members carry. Made after the runs, which take the whole organization.
    const chart = await hostCall<{ groups: Array<{ id: string; name: string }> }>(page, 'org.get', {});
    const rd = chart.groups.find((group) => group.name === '研发团队') ?? chart.groups[0];
    await hostCall(page, 'org.saveGroup', {
        name: '后端组',
        parentId: rd?.id ?? null,
        memberIds: ['coder', 'tester', 'debugger'],
        prompt: '金额一律按分计算；改了接口先更新docs/api.md。',
    });
    await hostCall(page, 'org.saveGroup', {
        name: '逆向组',
        parentId: rd?.id ?? null,
        memberIds: [packet.id, 'scout'],
        prompt: '抓包结论写清请求链路和签名方式，每条附上抓到的请求。',
    });
    await page.locator('.sidebar__nav', { hasText: '团队' }).click();
    await page.locator('.onode', { hasText: '逆向组' }).locator('.omember', { hasText: '抓包侦察' }).waitFor();
    await shot(page, 'xora-members');
    // The panel of a member that worked on the team run: its project, the supervisor's score, its tokens.
    await page.locator('.omember', { hasText: '编码' }).click();
    await page.locator('.org-panel [data-block=tokens]').waitFor();
    await shot(page, 'xora-member');

    phase('talent market');
    // 19 §14: every built-in persona, to read and hire into an organization.
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: '人才市场' }).click();
    await page.locator('.talent').nth(8).waitFor();
    // The hands-on ones: in an organization already, or free to hire.
    await page.locator('.talent-page__roles .chip', { hasText: '执行' }).click();
    await page
        .locator('.talent', { hasText: '前端工程师' })
        .getByRole('button', { name: '聘用', exact: true })
        .waitFor();
    await shot(page, 'xora-talent');

    phase('state view');
    // The state that replaced the fix thread's turns: the user's words as they were, the plan, what was decided and
    // why, the files and commands, how it went. The environment above it names the demo's temporary folder.
    await page.locator('.thread-row', { hasText: '修复订单金额的精度问题' }).first().click();
    const sidePanel = page.locator('.right-panel');
    if (await sidePanel.isVisible()) await sidePanel.getByRole('button', { name: '关闭' }).first().click();
    await page.locator('.compaction').getByRole('button', { name: '查看任务状态' }).click();
    const messages = page.locator('.compaction__summary h2', { hasText: 'Messages to you' });
    await messages.waitFor();
    await messages.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(500);
    await shot(page, 'xora-state');

    phase('team view');
    // The team run, delivered: the team page opens on its organization; the runs are the other tab.
    await page.locator('.sidebar__nav', { hasText: '团队' }).click();
    await page.getByRole('tab', { name: '团队任务' }).click();
    // Listed by the gist of its goal (06 §28).
    await page.locator('.team-board__open', { hasText: '优惠券' }).first().click();
    await page.locator('.team__goal .badge', { hasText: /已交付|完成/ }).waitFor({ timeout: 30_000 });
    await shot(page, 'xora-team');

    phase('chief');
    // The chief assistant (06 §23), the one place to ask: it answers from what the team, the workflows and the
    // threads did, and hands work on.
    // It belongs to no project: nothing to pick, it works out which one is meant.
    const chief = await hostCall<{ id: string }>(page, 'chief.start', {
        text: '这周shop-api做到哪了？有什么要我决定的？',
    });
    await settled(page, chief.id);
    await page.locator('.sidebar__nav', { hasText: '总助手' }).click();
    await page.getByText('需要你决定的只有一件').waitFor({ timeout: 30_000 });
    // The changes panel the fix opened has nothing to show here.
    const panel = page.locator('.right-panel');
    if (await panel.isVisible()) await panel.getByRole('button', { name: '关闭' }).first().click();
    await shot(page, 'xora-chief');
} catch (error) {
    failed = true;
    console.error(`✗ ${error instanceof Error ? error.stack : String(error)}`);
    const page = app.windows()[0];
    if (page) {
        await within(page.screenshot({ path: path.join(work, 'failure.png') }), 15_000, 'failure screenshot').catch(
            () => undefined,
        );
    }
    console.error(`  失败截图：${path.join(work, 'failure.png')}`);
    console.error(
        `  模型服务收到：${server.requests.map((request) => `${request.method} ${request.path}`).length}个请求`,
    );
} finally {
    stopApproving();
    await within(
        app.evaluate(({ app }) => app.exit(0)),
        10_000,
        'quit',
    ).catch(() => app.process().kill('SIGKILL'));
    await server.close();
}
if (values.keep || failed) {
    console.log(`临时目录：${work}`);
} else {
    forgetAppCopy(appCopy);
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
}
process.exitCode = failed ? 1 : 0;
