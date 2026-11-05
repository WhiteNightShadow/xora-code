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

export const ORG_TEMPLATES: Readonly<Record<'dev-team', OrgTemplate>> = { 'dev-team': DEV_TEAM };
