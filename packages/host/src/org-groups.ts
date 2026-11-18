import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OrgGroup, PermissionMode, UiLanguage } from '@xora/protocol';
import { CODER_PROMPT, type Role, type Tier } from '@xora/workflows';

/**
 * The organization tree (19 §4), the groups of 06 §24 with a parent each: `<data>/orgs/default/groups.json`. Until
 * the user changes them there is one group, the default team: the first supervisor leads it and every other member
 * of the user's works in it.
 */

const FILE = 'groups.json';
/** The file as 1.1.0 wrote it, kept when the tree format replaces it. */
const BACKUP = 'groups.v1.json';

/** Levels of the tree: more would pass work through too many hands, and not fit the window (19 §4). */
export const MAX_GROUP_DEPTH = 3;

interface StoredGroups {
    readonly version: 1 | 2;
    readonly groups: readonly OrgGroup[];
}

export function groupsFile(orgsDir: string): string {
    return path.join(orgsDir, 'default', FILE);
}

/** The stored groups, or undefined while the user has not changed the default team. */
export async function readGroups(orgsDir: string): Promise<OrgGroup[] | undefined> {
    const text = await readFile(groupsFile(orgsDir), 'utf8').catch(() => undefined);
    return text === undefined ? undefined : parseGroups(text);
}

/** The same, for the layers a thread gets as it starts. */
export function readGroupsSync(orgsDir: string): OrgGroup[] | undefined {
    try {
        return parseGroups(readFileSync(groupsFile(orgsDir), 'utf8'));
    } catch {
        return undefined;
    }
}

function parseGroups(text: string): OrgGroup[] | undefined {
    try {
        const parsed = JSON.parse(text) as Partial<StoredGroups>;
        if (!Array.isArray(parsed.groups)) return undefined;
        const groups = parsed.groups.flatMap((group): OrgGroup[] => {
            const entry = group as Partial<OrgGroup>;
            if (typeof entry.id !== 'string' || typeof entry.name !== 'string') {
                return [];
            }
            return [
                {
                    id: entry.id,
                    name: entry.name,
                    ...(typeof entry.description === 'string' && entry.description
                        ? { description: entry.description }
                        : {}),
                    ...(typeof entry.parentId === 'string' && entry.parentId ? { parentId: entry.parentId } : {}),
                    leaderId: typeof entry.leaderId === 'string' ? entry.leaderId : '',
                    memberIds: Array.isArray(entry.memberIds)
                        ? entry.memberIds.filter((id): id is string => typeof id === 'string')
                        : [],
                },
            ];
        });
        return wellFormed(groups);
    } catch {
        return undefined;
    }
}

/** A file edited by hand can point at a group that is gone, or in a circle: such a group moves to the first level. */
function wellFormed(groups: readonly OrgGroup[]): OrgGroup[] {
    const byId = new Map(groups.map((group) => [group.id, group]));
    return groups.map((group) => {
        const seen = new Set([group.id]);
        for (let parent = group.parentId; parent !== undefined; parent = byId.get(parent)?.parentId) {
            if (!byId.has(parent) || seen.has(parent)) {
                const { parentId: _gone, ...rest } = group;
                return rest;
            }
            seen.add(parent);
        }
        return group;
    });
}

export async function writeGroups(orgsDir: string, groups: readonly OrgGroup[]): Promise<void> {
    const file = groupsFile(orgsDir);
    await mkdir(path.dirname(file), { recursive: true });
    // Going back to 1.1.0 finds the groups it knew.
    const before = await readFile(file, 'utf8').catch(() => undefined);
    if (before !== undefined && !/"version":\s*2/.test(before)) {
        await writeFile(path.join(path.dirname(file), BACKUP), before, { flag: 'wx' }).catch(() => undefined);
    }
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 2, groups } satisfies StoredGroups, null, 2)}\n`, 'utf8');
    await rename(temp, file);
}

/** A group and the groups above it, the first level first. */
export function groupChain(groups: readonly OrgGroup[], groupId: string): OrgGroup[] {
    const byId = new Map(groups.map((group) => [group.id, group]));
    const chain: OrgGroup[] = [];
    const seen = new Set<string>();
    for (let current = byId.get(groupId); current && !seen.has(current.id); ) {
        seen.add(current.id);
        chain.unshift(current);
        current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    return chain;
}

/** A group and every group under it. */
export function groupSubtree(groups: readonly OrgGroup[], groupId: string): OrgGroup[] {
    const found = groups.filter((group) => group.id === groupId);
    for (let index = 0; index < found.length; index++) {
        const id = found[index]?.id;
        for (const group of groups) {
            if (group.parentId === id && !found.includes(group)) found.push(group);
        }
    }
    return found;
}

/** The levels a group's subtree takes, 1 when it has no groups under it. */
export function groupHeight(groups: readonly OrgGroup[], groupId: string): number {
    const below = groups.filter((group) => group.parentId === groupId);
    return 1 + Math.max(0, ...below.map((group) => groupHeight(groups, group.id)));
}

/** Who takes a group's work (19 §4): its lead, or the nearest one above it. */
export function leadOf(groups: readonly OrgGroup[], groupId: string): string | undefined {
    return groupChain(groups, groupId)
        .reverse()
        .find((group) => group.leaderId)?.leaderId;
}

/** The group a member is in: as its lead, or as a member. */
export function groupOfMember(groups: readonly OrgGroup[], memberId: string): OrgGroup | undefined {
    return groups.find((group) => group.leaderId === memberId || group.memberIds.includes(memberId));
}

/**
 * A member's supervisor (19 §4): the lead of its group; for a lead, the lead above its group. Undefined: the chief,
 * for those who report straight to it.
 */
export function supervisorOf(groups: readonly OrgGroup[], memberId: string): string | undefined {
    const led = groups.find((group) => group.leaderId === memberId);
    if (led) {
        // Someone may lead the organization above as well, and has no say over itself.
        return groupChain(groups, led.id)
            .slice(0, -1)
            .reverse()
            .map((group) => group.leaderId)
            .find((id) => id && id !== memberId);
    }
    const group = groups.find((item) => item.memberIds.includes(memberId));
    return group ? leadOf(groups, group.id) : undefined;
}

/** An id for a new group: its name as `[a-z0-9-]` when that has a letter, else `group-<6 hex>`. */
export function groupId(name: string, taken: ReadonlySet<string>): string {
    const slug = name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    if (/[a-z]/.test(slug) && !taken.has(slug)) return slug;
    for (;;) {
        const candidate = `group-${randomBytes(3).toString('hex')}`;
        if (!taken.has(candidate)) return candidate;
    }
}

type Words = Readonly<Record<UiLanguage, string>>;

/** A member of a template: a built-in member renamed for its job, or a new one. */
export interface TemplateMember {
    readonly id: string;
    readonly name: Words;
    readonly description: Words;
    readonly role: Role;
    readonly category?: string;
    /** Absent: the built-in member's, or the role's. */
    readonly tier?: Tier;
    readonly mode?: PermissionMode;
    /** Absent: the built-in member's own instructions. */
    readonly prompt?: string;
}

export interface OrgTemplate {
    readonly group: { readonly id: string; readonly name: Words; readonly description: Words };
    /** The first member leads the group. */
    readonly members: readonly TemplateMember[];
}

const executor = (job: string) => `${CODER_PROMPT}\n\n${job}`;

/** A regular software team (06 §24): the jobs people know from companies, on the roles team runs need. */
export const DEV_TEAM: OrgTemplate = {
    group: {
        id: 'dev',
        name: { 'zh-CN': '开发组', en: 'Development' },
        description: {
            'zh-CN': '需求、设计、开发、测试、部署和审查，交付可用的软件',
            en: 'Requirements, design, development, testing, deployment and review: working software',
        },
    },
    members: [
        {
            id: 'supervisor',
            name: { 'zh-CN': '技术负责人', en: 'Tech lead' },
            description: {
                'zh-CN': '拆解目标、分派任务、验收把关，向你汇报结果',
                en: 'Breaks the goal down, hands out the work, accepts it and reports the results to you',
            },
            role: 'supervisor',
        },
        {
            id: 'planner',
            name: { 'zh-CN': '产品经理', en: 'Product manager' },
            description: {
                'zh-CN': '把目标写成需求、验收标准和任务计划',
                en: 'Turns goals into requirements, acceptance criteria and a task plan',
            },
            role: 'planner',
        },
        {
            id: 'plan-reviewer',
            name: { 'zh-CN': '架构师', en: 'Architect' },
            description: {
                'zh-CN': '评审方案：技术选型、接口与数据结构、风险',
                en: 'Reviews the plan: technology, interfaces, data structures and risks',
            },
            role: 'plan_reviewer',
        },
        {
            id: 'frontend',
            name: { 'zh-CN': '前端工程师', en: 'Frontend engineer' },
            description: { 'zh-CN': '页面、交互和前端工程', en: 'Pages, interaction and the frontend build' },
            role: 'executor',
            category: 'frontend',
            tier: 'economy',
            mode: 'auto_edit',
            prompt: executor(
                "You are the team's frontend engineer: pages, components, styles, client state and the frontend build. Follow the design system and the components the project has; check what you build in the preview or with the project's UI tests when it has them.",
            ),
        },
        {
            id: 'coder',
            name: { 'zh-CN': '后端工程师', en: 'Backend engineer' },
            description: {
                'zh-CN': '服务端、接口、数据库和脚本',
                en: 'Services, APIs, databases and scripts',
            },
            role: 'executor',
            category: 'backend',
            prompt: executor(
                "You are the team's backend engineer: services, APIs, data models, migrations and scripts. Keep interfaces compatible unless the card changes them, write migrations that can be rolled back, and never run destructive commands against a database the card does not name.",
            ),
        },
        {
            id: 'tester',
            name: { 'zh-CN': '测试工程师', en: 'QA engineer' },
            description: {
                'zh-CN': '写测试、复现问题、把关质量',
                en: 'Writes tests, reproduces problems, guards quality',
            },
            role: 'executor',
            category: 'testing',
        },
        {
            id: 'devops',
            name: { 'zh-CN': '运维工程师', en: 'DevOps engineer' },
            description: {
                'zh-CN': '构建、部署、CI和运行环境',
                en: 'Builds, deployment, CI and environments',
            },
            role: 'executor',
            category: 'devops',
            tier: 'standard',
            mode: 'auto_edit',
            prompt: executor(
                "You are the team's DevOps engineer: builds, CI, deployment scripts, containers and environments. Change configuration in small steps that can be undone; touch production or shared infrastructure only when the card asks for it, and say how to roll back.",
            ),
        },
        {
            id: 'reviewer',
            name: { 'zh-CN': '代码审查', en: 'Code reviewer' },
            description: {
                'zh-CN': '对照证据逐条审查交付的代码',
                en: 'Reviews delivered code against its evidence, point by point',
            },
            role: 'reviewer',
        },
        {
            id: 'scout',
            name: { 'zh-CN': '技术调研', en: 'Researcher' },
            description: {
                'zh-CN': '查代码、文档和网上资料，交回有出处的事实',
                en: 'Reads code, docs and the web; returns facts with sources',
            },
            role: 'scout',
        },
        {
            id: 'specialist',
            name: { 'zh-CN': '资深专家', en: 'Principal engineer' },
            description: {
                'zh-CN': '疑难问题和升级上来的任务',
                en: 'Hard problems and tasks escalated from the others',
            },
            role: 'specialist',
        },
    ],
};

export const ORG_TEMPLATE_IDS = ['opc-studio', 'opc-indie', 'opc-content', 'dev-team'] as const;
export type OrgTemplateId = (typeof ORG_TEMPLATE_IDS)[number];

/**
 * OPC (One-Person Company / 一人公司) full-stack studio: covers product validation, MVP engineering, UI/UX & landing
 * pages, growth/content marketing, competitor research, automation scripts and launch QA.
 */
export const OPC_STUDIO: OrgTemplate = {
    group: {
        id: 'opc-studio',
        name: { 'zh-CN': 'OPC 一人公司班底', en: 'OPC Studio' },
        description: {
            'zh-CN': '覆盖独立产品、全栈开发、UI落地页、增长运营、市场调研与自动化脚本的一人公司全能团队',
            en: 'Product, full-stack MVP, UI/UX, growth content, market research and automation for solo founders',
        },
    },
    members: [
        {
            id: 'opc-lead',
            name: { 'zh-CN': '业务统筹合伙人', en: 'Venture Lead' },
            description: {
                'zh-CN': '站在一人公司商业闭环视角拆解目标，统筹产品、研发与增长并行交付并验收',
                en: 'Breaks business and product goals into actionable cards across product, code and growth',
            },
            role: 'supervisor',
        },
        {
            id: 'opc-pm',
            name: { 'zh-CN': '独立产品经理', en: 'Indie Product Manager' },
            description: {
                'zh-CN': '需求验证、MVP最小可行范围裁剪、用户流程、PRD文档与定价变现设计',
                en: 'Demand validation, lean MVP scoping, user flows, PRDs and monetization design',
            },
            role: 'planner',
            tier: 'flagship',
            mode: 'plan',
            prompt: [
                '你是面向 OPC（一人公司 / 独立开发者）的资深产品合伙人。',
                '核心原则：',
                '1. 极度克制功能蔓延：永远优先切出 1～3 天能上线验证的最小闭环 MVP，砍掉一切非核心伪需求。',
                '2. 商业与用户价值先行：明确目标用户是谁、核心痛点场景、Aha Moment、转化漏斗与收费锚点。',
                '3. 输出结构清晰、可直接交给开发或直接落地的 PRD：背景目标、核心用户路径、页面/接口要素、边界异常与验收标准。',
            ].join('\n'),
        },
        {
            id: 'opc-fullstack',
            name: { 'zh-CN': '全栈独立开发', en: 'Full-Stack Builder' },
            description: {
                'zh-CN': '前后端、接口、数据库与部署一肩挑，拒绝过度设计，极速交付可运行产品',
                en: 'Ships frontend, backend, database and deployment end-to-end with lean, pragmatic architecture',
            },
            role: 'executor',
            category: 'fullstack',
            tier: 'standard',
            mode: 'auto_edit',
            prompt: executor(
                [
                    '你是 OPC 全栈独立开发工程师，独立负责前后端、API、数据模型与脚本落地。',
                    '做事准则：',
                    '- 架构简洁实用：复用项目现有技术栈，不引入笨重且非必要的中间层，代码清晰易维护。',
                    '- 端到端闭环：改动后主动跑类型检查、构建与关键路径测试，确保交付即可运行。',
                    '- 安全稳健：妥善处理鉴权、配置与异常兜底，绝不硬编码密钥或执行未授权的破坏性命令。',
                ].join('\n'),
            ),
        },
        {
            id: 'opc-designer',
            name: { 'zh-CN': 'UI/UX 与落地页设计师', en: 'UI/UX & Landing Designer' },
            description: {
                'zh-CN': '高转化 Landing Page、现代极简界面重构、交互细节打磨与设计系统对齐',
                en: 'High-converting landing pages, clean modern UI/UX, interaction polish and visual hierarchy',
            },
            role: 'executor',
            category: 'design',
            tier: 'standard',
            mode: 'auto_edit',
            prompt: executor(
                [
                    '你是兼具审美与商业转化意识的 UI/UX 设计师兼前端样式工程师。',
                    '做事准则：',
                    '- 信息层级清晰、留白克制、视觉现代干净，杜绝杂乱堆砌与廉价模板感。',
                    '- 做落地页与营销页时突出核心价值主张（Hero）、痛点对比、功能亮点与清晰 CTA。',
                    '- 做应用界面时注重操作直觉、零学习成本、响应式排版、深浅色模式一致性与无障碍可访问性。',
                ].join('\n'),
            ),
        },
        {
            id: 'opc-growth',
            name: { 'zh-CN': '增长与内容运营', en: 'Growth & Content Operator' },
            description: {
                'zh-CN': '冷启动获客策略、小红书/X/公众号种草与发售文案、SEO内容矩阵与更新日志',
                en: 'Go-to-market strategy, launch copy, social posts (X/RedNote/blog), SEO and release notes',
            },
            role: 'executor',
            category: 'growth',
            tier: 'standard',
            mode: 'auto_edit',
            prompt: [
                '你是服务于一人公司的增长黑客与内容运营专家。',
                '核心能力与准则：',
                '1. 用户视角说人话：用具体痛点场景、前后对比与真实收益打动读者，拒绝空洞自嗨的正确的废话与AI腔。',
                '2. 多渠道适配：能针对小红书（痛点钩子+干货清单）、X/Twitter（Build in Public 短帖/Thread）、公众号深度文、Product Hunt 发售页输出贴合平台调性的内容。',
                '3. 增长可执行：给出的获客、SEO 关键词布局、冷启动引流与留存方案必须具体到一人每天可执行的动作。',
            ].join('\n'),
        },
        {
            id: 'opc-researcher',
            name: { 'zh-CN': '市场与竞品分析师', en: 'Market & Competitor Analyst' },
            description: {
                'zh-CN': '赛道机会评估、竞品功能与定价拆解、用户差评痛点挖掘，输出有据可查的报告',
                en: 'Evaluates markets, dissects competitor pricing & features, mines user pain points with citations',
            },
            role: 'scout',
            tier: 'standard',
            mode: 'plan',
            prompt: [
                '你是严谨的商业调研与竞品分析师。',
                '做事准则：',
                '1. 事实与出处优先：所有竞品功能、定价区间、流量来源、技术栈与用户评价都要基于实际检索或代码/文档证据，绝不臆造数据。',
                '2. 直击商业本质：重点拆解竞品「靠什么获客、怎么收费、用户骂什么、一人公司切入的差异化缝隙在哪里」。',
                '3. 先给核心结论与对比表，再附证据链与参考链接。',
            ].join('\n'),
        },
        {
            id: 'opc-automation',
            name: { 'zh-CN': '自动化与数据专家', en: 'Automation & Data Engineer' },
            description: {
                'zh-CN': '编写数据采集清洗脚本、API对接、批量处理工具与定时工作流，把重复劳动自动化',
                en: 'Builds scrapers, data pipelines, API integrations and batch scripts to automate repetitive work',
            },
            role: 'executor',
            category: 'automation',
            tier: 'economy',
            mode: 'auto_edit',
            prompt: executor(
                [
                    '你是自动化与数据处理专家，帮一人公司把一切重复手工劳动变成可靠脚本与流水线。',
                    '做事准则：',
                    '- 脚本必须幂等、带断点续跑/重试/清晰日志与输入参数校验，失败时给出明确原因。',
                    '- 数据清洗与导出保持结构规整（JSON / CSV / SQLite / Markdown），方便后续直接消费。',
                ].join('\n'),
            ),
        },
        {
            id: 'opc-qa',
            name: { 'zh-CN': '体验与质量验收官', en: 'QA & Launch Auditor' },
            description: {
                'zh-CN': '以挑剔用户+工程师双视角走查交互、补齐关键测试、排查上线前安全与边界隐患',
                en: 'Audits UX flows, edge cases, tests and security risks before shipping',
            },
            role: 'reviewer',
            tier: 'standard',
            mode: 'plan',
        },
    ],
};

/** Lean 3-agent setup for solo builders who want minimal overhead. */
export const OPC_INDIE: OrgTemplate = {
    group: {
        id: 'opc-indie',
        name: { 'zh-CN': 'OPC 极简独立开发组', en: 'OPC Lean Indie Trio' },
        description: {
            'zh-CN': '三人精锐搭子：合伙人统筹 + 全栈实现 + 调研测试，轻量省Token、极速出活',
            en: 'Lean 3-agent setup: product-tech lead, full-stack builder and researcher/tester',
        },
    },
    members: [
        OPC_STUDIO.members[0] as TemplateMember,
        OPC_STUDIO.members[2] as TemplateMember,
        {
            id: 'opc-scout-qa',
            name: { 'zh-CN': '调研与测试搭子', en: 'Research & QA Partner' },
            description: {
                'zh-CN': '查资料、探代码、跑测试、写文档，辅助快速决策与验收',
                en: 'Researches docs/competitors, runs tests and writes concise guides',
            },
            role: 'executor',
            category: 'testing',
            tier: 'economy',
            mode: 'auto_edit',
            prompt: executor(
                '你是一人开发者的全能辅助搭子：既能快速检索资料与代码事实，也能补齐自动化测试、验证边界异常并整理简明清晰的说明文档。',
            ),
        },
    ],
};

/** Content, research & growth studio for solo creators, consultants and marketers. */
export const OPC_CONTENT: OrgTemplate = {
    group: {
        id: 'opc-content',
        name: { 'zh-CN': 'OPC 内容与增长工作室', en: 'OPC Content & Growth Studio' },
        description: {
            'zh-CN': '面向自媒体、独立咨询、知识产品与出海营销：选题调研、深度撰稿、多平台转化文案与数据脚本',
            en: 'Topic research, deep writing, high-converting copy and data scripts for solo creators & marketers',
        },
    },
    members: [
        {
            id: 'content-lead',
            name: { 'zh-CN': '内容与增长主编', en: 'Editorial & Growth Lead' },
            description: {
                'zh-CN': '把控选题方向、内容结构、受众定位与多平台分发节奏，审校成稿质量',
                en: 'Plans topics, audience angles and distribution; reviews final drafts for clarity and impact',
            },
            role: 'supervisor',
        },
        OPC_STUDIO.members[5] as TemplateMember,
        {
            id: 'content-writer',
            name: { 'zh-CN': '深度主笔撰稿人', en: 'Lead Writer' },
            description: {
                'zh-CN': '撰写深度长文、行业报告、教程指南、白皮书与视频长脚本，逻辑严密去AI味',
                en: 'Writes deep articles, industry reports, guides and video scripts with clear logic and natural voice',
            },
            role: 'executor',
            category: 'docs',
            tier: 'flagship',
            mode: 'auto_edit',
            prompt: [
                '你是深度主笔撰稿人，擅长把复杂技术或商业洞察写成逻辑严密、信息密度高、自然流畅的好文章。',
                '写作铁律：开门见山给核心观点；多用具体案例、数据与对比支撑；杜绝空洞排比、套话连篇与生硬翻译腔。',
            ].join('\n'),
        },
        OPC_STUDIO.members[4] as TemplateMember,
        OPC_STUDIO.members[6] as TemplateMember,
    ],
};

export const ORG_TEMPLATES: Readonly<Record<OrgTemplateId, OrgTemplate>> = {
    'opc-studio': OPC_STUDIO,
    'opc-indie': OPC_INDIE,
    'opc-content': OPC_CONTENT,
    'dev-team': DEV_TEAM,
};
