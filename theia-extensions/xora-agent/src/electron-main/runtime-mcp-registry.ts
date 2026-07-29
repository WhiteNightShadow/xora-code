import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { sharedGrokHome } from './shared-grok-home';

type JsonObject = Record<string, unknown>;
type McpConfigurationScope = 'user' | 'project';

const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const ENVIRONMENT_TEMPLATE = /\$\{([A-Z][A-Z0-9_]{0,127})(?::-([^{}]*?))?\}/g;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_URL_BYTES = 16 * 1024;
const MAX_REDACTION_VALUES = 2_048;
const MAX_REDACTION_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_QUERY_NAMES = new Set([
    'apikey', 'accesskey', 'accesstoken', 'authtoken', 'authorization', 'auth',
    'bearertoken', 'clientsecret', 'cookie', 'credential', 'credentials', 'jwt',
    'password', 'passwd', 'secret', 'session', 'sessionid', 'signature', 'sig', 'token'
]);
const CREDENTIAL_OPTION_NAME = /^(?:--?|\/)(?:api[-_]?key|access[-_]?key|access[-_]?token|authorization|auth|bearer[-_]?token|client[-_]?secret|cookie|credential|password|passwd|secret|session[-_]?id|signature|token)$/i;
const CREDENTIAL_OPTION_ASSIGNMENT = /(?:^|\s)(?:--?|\/)(?:api[-_]?key|access[-_]?key|access[-_]?token|authorization|auth|bearer[-_]?token|client[-_]?secret|cookie|credential|password|passwd|secret|session[-_]?id|signature|token)(?:=|:)([^\s]+)/i;
const CREDENTIAL_OPTION_PAIR = /(?:^|\s)(?:--?|\/)(?:api[-_]?key|access[-_]?key|access[-_]?token|authorization|auth|bearer[-_]?token|client[-_]?secret|cookie|credential|password|passwd|secret|session[-_]?id|signature|token)\s+([^\s]+)/i;
const CREDENTIAL_ENV_ASSIGNMENT = /(?:^|\s)[A-Z0-9_]*(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH|COOKIE|CREDENTIAL|PASSWORD|SECRET|SESSION|SIGNATURE|TOKEN)[A-Z0-9_]*=([^\s]+)/i;
const CREDENTIAL_TOKEN_LITERAL = /(?:\bbearer\s+[^\s]+|\b(?:sk|xai)-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/i;

export interface AcpV1EnvironmentVariable {
    name: string;
    value: string;
}

export interface AcpV1HttpHeader {
    name: string;
    value: string;
}

/** ACP v1 represents stdio by omitting the transport discriminator. */
export interface AcpV1StdioMcpServer {
    name: string;
    command: string;
    args: string[];
    env: AcpV1EnvironmentVariable[];
}

export interface AcpV1HttpMcpServer {
    name: string;
    type: 'http';
    url: string;
    headers: AcpV1HttpHeader[];
}

export interface AcpV1SseMcpServer {
    name: string;
    type: 'sse';
    url: string;
    headers: AcpV1HttpHeader[];
}

export type AcpV1McpServer = AcpV1StdioMcpServer | AcpV1HttpMcpServer | AcpV1SseMcpServer;

/** Renderer-safe explanation for one canonical MCP entry that was degraded. */
export interface RuntimeMcpIssue {
    name: string;
    scope: McpConfigurationScope;
    severity: 'warning' | 'error';
    code: 'literal-credential' | 'missing-environment' | 'invalid-configuration';
    /** This text never contains the configured argument or resolved secret. */
    message: string;
}

/** Electron-main-only credential material. It must never cross renderer IPC. */
export interface RuntimeMcpCredentialBinding {
    /** realpath-normalized workspace root captured when the credential was saved */
    workspaceRoot: string;
    server: string;
    environmentName: string;
    /** SHA-256 of the exact effective canonical server table and its scope. */
    configIdentity: string;
    value: string;
}

/**
 * Privileged Electron-main result. `mcpServers` can contain expanded secrets
 * and must only be sent directly to ACP session/new or session/load. It is not
 * a renderer DTO and must never cross the AgentHost RPC boundary.
 */
export interface RuntimeMcpSnapshot {
    mcpServers: AcpV1McpServer[];
    /** SHA-256 of the canonical, fully resolved runtime configuration. */
    fingerprint: string;
    /** Renderer-safe names after user/project merge, including disabled entries. */
    configuredNames: string[];
    /**
     * Renderer-safe user intent, kept separate from runtime resolution.
     * A configured server can remain enabled here while a missing environment
     * variable prevents it from contributing an ACP descriptor.
     */
    configuredServers: Array<{
        name: string;
        scope: McpConfigurationScope;
        enabled: boolean;
    }>;
    /** Renderer-safe names that contributed an ACP runtime descriptor. */
    enabledNames: string[];
    /** Per-server failures never abort Agent startup or another healthy MCP. */
    issues: RuntimeMcpIssue[];
    /**
     * Privileged exact values that must be registered with every Electron-main
     * log/event redactor before `mcpServers` are sent to ACP. This includes
     * resolved environment templates, explicitly configured literal
     * credentials, and all stdio env/header/bearer values.
     * It must never cross the AgentHost RPC boundary.
     */
    redactionValues: string[];
}

export interface RuntimeMcpRegistryOptions {
    /** Authoritative user Grok home. Defaults to the shared ~/.grok home. */
    grokHome?: string;
    /** Defensive bound for each TOML source. */
    maxConfigBytes?: number;
}

interface RawMcpServer {
    name: string;
    scope: McpConfigurationScope;
    value: JsonObject;
}

interface ParsedMcpConfiguration {
    servers: RawMcpServer[];
    disabledNames: string[];
}

/**
 * Resolves only Xora-owned Grok TOML sources into ACP v1 MCP descriptors.
 *
 * Compatibility files such as ~/.claude.json and .cursor/mcp.json are
 * intentionally excluded. Secret templates are expanded only in this
 * Electron-main object; neither the source TOML nor a renderer-visible model
 * is mutated.
 */
export class RuntimeMcpRegistry {
    protected readonly grokHome: string;
    protected readonly maxConfigBytes: number;

    constructor(options: RuntimeMcpRegistryOptions = {}) {
        const grokHome = options.grokHome ?? sharedGrokHome();
        if (!path.isAbsolute(grokHome) || /[\0\r\n]/.test(grokHome)) {
            throw new Error('The shared Grok home must be an absolute path.');
        }
        const maxConfigBytes = options.maxConfigBytes ?? MAX_CONFIG_BYTES;
        if (!Number.isSafeInteger(maxConfigBytes) || maxConfigBytes < 1 || maxConfigBytes > 16 * 1024 * 1024) {
            throw new Error('The MCP configuration size limit is invalid.');
        }
        this.grokHome = path.normalize(grokHome);
        this.maxConfigBytes = maxConfigBytes;
    }

    resolve(
        workspaceRoot: string,
        environment: NodeJS.ProcessEnv = process.env,
        credentials: readonly RuntimeMcpCredentialBinding[] = []
    ): RuntimeMcpSnapshot {
        const root = this.workspaceRoot(workspaceRoot);
        const { configured, disabledNames } = this.effectiveConfiguration(root);
        const configuredNames = configured.map(server => server.name);
        const configuredServers = configured.map(server => ({
            name: server.name,
            scope: server.scope,
            enabled: !disabledNames.has(server.name) && configuredServerEnabled(server)
        }));
        const selectedNames = new Set(configuredServers.filter(server => server.enabled).map(server => server.name));
        const redactions = new RedactionValueCollector();
        const issues: RuntimeMcpIssue[] = [];
        const mcpServers = configured
            .filter(server => selectedNames.has(server.name))
            .flatMap(server => {
                try {
                    return this.resolveServer(
                        server,
                        this.serverEnvironment(root, server, environment, credentials),
                        redactions,
                        issues
                    );
                } catch (error) {
                    issues.push(runtimeMcpIssue(server, error));
                    return [];
                }
            });
        const enabledNames = mcpServers.map(server => server.name);
        const fingerprint = crypto.createHash('sha256')
            .update(JSON.stringify({ mcpServers, issues }))
            .digest('hex');
        return {
            mcpServers,
            fingerprint,
            configuredNames,
            configuredServers,
            enabledNames,
            issues,
            redactionValues: redactions.values()
        };
    }

    /** Safe hashes used to bind encrypted credentials to the current effective server table. */
    configurationIdentities(workspaceRoot: string): ReadonlyMap<string, string> {
        const root = this.workspaceRoot(workspaceRoot);
        const { configured } = this.effectiveConfiguration(root);
        return new Map(configured.map(server => [server.name, configurationIdentity(server)]));
    }

    credentialConfigurationIdentity(
        workspaceRoot: string,
        serverName: string,
        environmentName: string
    ): string | undefined {
        if (!MCP_SERVER_NAME.test(serverName) || !ENVIRONMENT_NAME.test(environmentName)) return undefined;
        const root = this.workspaceRoot(workspaceRoot);
        const server = this.effectiveConfiguration(root).configured.find(candidate => candidate.name === serverName);
        return server && serverReferencesCredential(server, environmentName)
            ? configurationIdentity(server)
            : undefined;
    }

    /**
     * Returns only currently valid credential variables for Grok management
     * commands. ACP runtime resolution uses `serverEnvironment` instead so one
     * server can never observe another server's app-managed credential.
     */
    credentialEnvironment(
        workspaceRoot: string,
        credentials: readonly RuntimeMcpCredentialBinding[]
    ): NodeJS.ProcessEnv {
        const root = this.workspaceRoot(workspaceRoot);
        const { configured } = this.effectiveConfiguration(root);
        const output: NodeJS.ProcessEnv = {};
        const conflicted = new Set<string>();
        for (const server of configured) {
            const binding = this.matchingCredential(root, server, credentials);
            if (!binding || conflicted.has(binding.environmentName)) continue;
            const previous = output[binding.environmentName];
            if (previous !== undefined && previous !== binding.value) {
                delete output[binding.environmentName];
                conflicted.add(binding.environmentName);
            } else {
                output[binding.environmentName] = binding.value;
            }
        }
        return output;
    }

    protected workspaceRoot(value: string): string {
        if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)
            || Buffer.byteLength(value, 'utf8') > MAX_URL_BYTES) {
            throw new Error('The MCP workspace root must be an absolute path.');
        }
        try {
            const resolved = fs.realpathSync.native(value);
            if (!fs.statSync(resolved).isDirectory()) {
                throw new Error('not a directory');
            }
            return path.normalize(resolved);
        } catch {
            throw new Error('The MCP workspace root must be an existing directory.');
        }
    }

    protected effectiveConfiguration(root: string): {
        configured: RawMcpServer[];
        disabledNames: Set<string>;
    } {
        const user = this.readConfiguration(path.join(this.grokHome, 'config.toml'), 'user');
        const project = this.readProjectConfiguration(root);
        const merged = new Map<string, RawMcpServer>();
        for (const server of user.servers) merged.set(server.name, server);
        // A project entry replaces the complete user entry, including a
        // disabled-only entry that deliberately suppresses a user server.
        for (const server of project.servers) merged.set(server.name, server);
        // A project override must not accidentally re-enable a globally
        // disabled executable integration.
        const disabledNames = new Set([...user.disabledNames, ...project.disabledNames]);
        return {
            configured: [...merged.values()].sort((left, right) => compareText(left.name, right.name)),
            disabledNames
        };
    }

    protected serverEnvironment(
        root: string,
        server: RawMcpServer,
        environment: NodeJS.ProcessEnv,
        credentials: readonly RuntimeMcpCredentialBinding[]
    ): NodeJS.ProcessEnv {
        const binding = this.matchingCredential(root, server, credentials);
        return binding ? { ...environment, [binding.environmentName]: binding.value } : environment;
    }

    protected matchingCredential(
        root: string,
        server: RawMcpServer,
        credentials: readonly RuntimeMcpCredentialBinding[]
    ): RuntimeMcpCredentialBinding | undefined {
        const identity = configurationIdentity(server);
        const matches = credentials.filter(binding =>
            pathEquals(root, binding.workspaceRoot)
            && binding.server === server.name
            && MCP_SERVER_NAME.test(binding.server)
            && ENVIRONMENT_NAME.test(binding.environmentName)
            && /^[0-9a-f]{64}$/i.test(binding.configIdentity)
            && binding.configIdentity === identity
            && typeof binding.value === 'string'
            && binding.value.length > 0
            && Buffer.byteLength(binding.value, 'utf8') <= MAX_VALUE_BYTES
            && serverReferencesCredential(server, binding.environmentName)
        );
        // Duplicate metadata is ambiguous even when both records happen to use
        // the same value. Fail closed instead of choosing by file order.
        return matches.length === 1 ? matches[0] : undefined;
    }

    protected readProjectConfiguration(root: string): ParsedMcpConfiguration {
        const grokDirectory = path.join(root, '.grok');
        let directoryInfo: fs.Stats;
        try {
            directoryInfo = fs.lstatSync(grokDirectory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], disabledNames: [] };
            throw new Error('Unable to inspect project MCP configuration.');
        }
        if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
            throw new Error('The project .grok path must be a regular directory, not a symbolic link.');
        }
        let realDirectory: string;
        try {
            realDirectory = fs.realpathSync.native(grokDirectory);
        } catch {
            throw new Error('Unable to resolve project MCP configuration.');
        }
        if (!pathIsInside(root, realDirectory)) {
            throw new Error('The project MCP configuration escapes the workspace root.');
        }
        return this.readConfiguration(path.join(realDirectory, 'config.toml'), 'project', root);
    }

    protected readConfiguration(
        configPath: string,
        scope: McpConfigurationScope,
        containingRoot?: string
    ): ParsedMcpConfiguration {
        let info: fs.Stats;
        try {
            info = fs.lstatSync(configPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], disabledNames: [] };
            throw new Error(`Unable to inspect ${scope} MCP configuration.`);
        }
        if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error(`The ${scope} MCP configuration must be a regular file, not a symbolic link.`);
        }
        if (info.size > this.maxConfigBytes) {
            throw new Error(`The ${scope} MCP configuration is too large.`);
        }
        if (containingRoot) {
            let resolved: string;
            try {
                resolved = fs.realpathSync.native(configPath);
            } catch {
                throw new Error(`Unable to resolve ${scope} MCP configuration.`);
            }
            if (!pathIsInside(containingRoot, resolved)) {
                throw new Error(`The ${scope} MCP configuration escapes its allowed root.`);
            }
        }
        const source = readBoundedRegularFile(configPath, this.maxConfigBytes, scope);
        let parsed: unknown;
        try {
            parsed = parseToml(source);
        } catch {
            // Parser diagnostics can echo a source line containing a secret.
            throw new Error(`Unable to parse ${scope} MCP configuration.`);
        }
        if (!isObject(parsed)) {
            throw new Error(`The ${scope} MCP configuration root is invalid.`);
        }
        const disabledNames = topLevelServerNames(parsed, 'disabled_mcp_servers', scope);
        const table = parsed.mcp_servers;
        if (table === undefined) return { servers: [], disabledNames };
        if (!isObject(table)) {
            throw new Error(`The ${scope} mcp_servers table is invalid.`);
        }
        const servers = Object.entries(table).map(([name, value]) => {
            if (!MCP_SERVER_NAME.test(name)) {
                throw new Error(`The ${scope} MCP configuration contains an unsafe server name.`);
            }
            if (!isObject(value)) {
                throw serverError(scope, name, 'must be a TOML table');
            }
            return { name, scope, value };
        });
        return { servers, disabledNames };
    }

    protected resolveServer(
        server: RawMcpServer,
        environment: NodeJS.ProcessEnv,
        redactions: RedactionValueCollector,
        issues: RuntimeMcpIssue[]
    ): AcpV1McpServer[] {
        const enabled = optionalBoolean(server, 'enabled');
        const disabled = optionalBoolean(server, 'disabled');
        if (enabled === false || disabled === true) return [];

        const command = optionalString(server, 'command');
        const url = optionalString(server, 'url');
        if (Boolean(command) === Boolean(url)) {
            throw serverError(server.scope, server.name, 'must define exactly one of command or url');
        }
        const transport = this.transport(server, command !== undefined, url !== undefined);
        if (transport === 'stdio') {
            return [this.resolveStdio(server, command!, environment, redactions, issues)];
        }
        return [this.resolveRemote(server, transport, url!, environment, redactions)];
    }

    protected transport(
        server: RawMcpServer,
        hasCommand: boolean,
        hasUrl: boolean
    ): 'stdio' | 'http' | 'sse' {
        const declared = [
            optionalString(server, 'type'),
            optionalString(server, 'transport'),
            optionalString(server, 'transport_type')
        ].filter((value): value is string => value !== undefined);
        if (new Set(declared).size > 1) {
            throw serverError(server.scope, server.name, 'has conflicting transport fields');
        }
        const selected = declared[0] ?? (hasCommand ? 'stdio' : 'http');
        if (selected !== 'stdio' && selected !== 'http' && selected !== 'sse') {
            throw serverError(server.scope, server.name, 'uses an unsupported transport');
        }
        if ((selected === 'stdio') !== hasCommand || (selected !== 'stdio') !== hasUrl) {
            throw serverError(server.scope, server.name, 'transport does not match its endpoint');
        }
        return selected;
    }

    protected resolveStdio(
        server: RawMcpServer,
        rawCommand: string,
        environment: NodeJS.ProcessEnv,
        redactions: RedactionValueCollector,
        issues: RuntimeMcpIssue[]
    ): AcpV1StdioMcpServer {
        let containsLiteralCredential = collectLiteralCredentials(rawCommand, undefined, redactions);
        const command = expandTemplate(rawCommand, environment, server, 'command', redactions);
        validateRuntimeString(command, MAX_COMMAND_BYTES, server, 'command', false, true);
        const rawArgs = optionalStringArray(server, 'args');
        const args = rawArgs.map((value, index) => {
            containsLiteralCredential = collectLiteralCredentials(value, rawArgs[index + 1], redactions)
                || containsLiteralCredential;
            const expanded = expandTemplate(value, environment, server, 'argument', redactions);
            validateRuntimeString(expanded, MAX_VALUE_BYTES, server, 'argument', true);
            return expanded;
        });
        const env = stringMap(server, 'env').map(([name, value]) => {
            if (!ENVIRONMENT_NAME.test(name)) {
                throw serverError(server.scope, server.name, 'contains an unsafe environment variable name');
            }
            const expanded = expandTemplate(value, environment, server, 'environment value', redactions);
            validateRuntimeString(expanded, MAX_VALUE_BYTES, server, 'environment value', true);
            redactions.add(expanded);
            return { name, value: expanded };
        });
        if (server.value.bearer_token_env_var !== undefined) {
            throw serverError(server.scope, server.name, 'cannot use bearer_token_env_var with stdio');
        }
        if (containsLiteralCredential) {
            issues.push({
                name: server.name,
                scope: server.scope,
                severity: 'warning',
                code: 'literal-credential',
                message: '参数中包含用户明确配置的明文凭据；已按配置加载并启用日志脱敏，建议改用环境变量或凭据保管库。'
            });
        }
        return { name: server.name, command, args, env };
    }

    protected resolveRemote(
        server: RawMcpServer,
        type: 'http' | 'sse',
        rawUrl: string,
        environment: NodeJS.ProcessEnv,
        redactions: RedactionValueCollector
    ): AcpV1HttpMcpServer | AcpV1SseMcpServer {
        const expandedUrl = expandTemplate(rawUrl, environment, server, 'URL', redactions);
        validateRuntimeString(expandedUrl, MAX_URL_BYTES, server, 'URL', false);
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(expandedUrl);
        } catch {
            throw serverError(server.scope, server.name, 'has an invalid URL');
        }
        if ((parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
            || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
            throw serverError(server.scope, server.name, 'has an unsafe URL');
        }
        if (parsedUrl.protocol === 'http:' && !isStrictLoopback(parsedUrl.hostname)) {
            throw serverError(server.scope, server.name, 'must use HTTPS unless its endpoint is strict loopback');
        }
        for (const name of parsedUrl.searchParams.keys()) {
            if (isCredentialName(name)) {
                throw serverError(server.scope, server.name, 'must not place credentials in URL query parameters');
            }
        }

        const headers = stringMap(server, 'headers').map(([name, value]) => {
            if (!HEADER_NAME.test(name)) {
                throw serverError(server.scope, server.name, 'contains an unsafe HTTP header name');
            }
            const expanded = expandTemplate(value, environment, server, 'HTTP header', redactions);
            validateRuntimeString(expanded, MAX_VALUE_BYTES, server, 'HTTP header', true, true);
            redactions.add(expanded);
            return { name, value: expanded };
        });
        const normalizedHeaderNames = new Set<string>();
        for (const header of headers) {
            const normalized = header.name.toLowerCase();
            if (normalizedHeaderNames.has(normalized)) {
                throw serverError(server.scope, server.name, 'contains duplicate HTTP header names');
            }
            normalizedHeaderNames.add(normalized);
        }

        const bearerVariable = optionalString(server, 'bearer_token_env_var');
        if (bearerVariable !== undefined) {
            if (!ENVIRONMENT_NAME.test(bearerVariable)) {
                throw serverError(server.scope, server.name, 'has an unsafe bearer token environment name');
            }
            if (normalizedHeaderNames.has('authorization')) {
                throw serverError(server.scope, server.name, 'defines Authorization twice');
            }
            if (parsedUrl.protocol !== 'https:') {
                throw serverError(server.scope, server.name, 'cannot send a bearer token over plaintext HTTP');
            }
            const token = environment[bearerVariable];
            if (typeof token !== 'string' || token.length === 0) {
                throw serverError(server.scope, server.name, `requires environment variable ${bearerVariable}`);
            }
            validateRuntimeString(token, MAX_VALUE_BYTES, server, 'bearer token', false, true);
            const authorization = `Bearer ${token}`;
            redactions.add(token);
            redactions.add(authorization);
            headers.push({ name: 'Authorization', value: authorization });
        }
        if (parsedUrl.protocol !== 'https:' && headers.some(header => isCredentialName(header.name))) {
            throw serverError(server.scope, server.name, 'cannot send a sensitive HTTP header over plaintext HTTP');
        }
        headers.sort((left, right) => compareText(left.name.toLowerCase(), right.name.toLowerCase())
            || compareText(left.name, right.name));
        return { name: server.name, type, url: parsedUrl.toString(), headers };
    }
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalBoolean(server: RawMcpServer, key: string): boolean | undefined {
    const value = server.value[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw serverError(server.scope, server.name, `${key} must be a boolean`);
    }
    return value;
}

function configuredServerEnabled(server: RawMcpServer): boolean {
    try {
        return optionalBoolean(server, 'enabled') !== false
            && optionalBoolean(server, 'disabled') !== true;
    } catch {
        // Invalid values are still user-enabled configuration. Resolution will
        // isolate the server and expose its remediation issue without making
        // the settings switch incorrectly look disabled.
        return true;
    }
}

function optionalString(server: RawMcpServer, key: string): string | undefined {
    const value = server.value[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES
        || value.includes('\0')) {
        throw serverError(server.scope, server.name, `${key} must be a safe non-empty string`);
    }
    return value;
}

function optionalStringArray(server: RawMcpServer, key: string): string[] {
    const value = server.value[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1024 || value.some(item => typeof item !== 'string')) {
        throw serverError(server.scope, server.name, `${key} must be a string array`);
    }
    return [...value] as string[];
}

function topLevelServerNames(root: JsonObject, key: string, scope: McpConfigurationScope): string[] {
    const value = root[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1024 || value.some(item => typeof item !== 'string')) {
        throw new Error(`The ${scope} ${key} value must be a string array.`);
    }
    const names = value as string[];
    if (names.some(name => !MCP_SERVER_NAME.test(name))) {
        throw new Error(`The ${scope} ${key} value contains an unsafe server name.`);
    }
    return [...new Set(names)];
}

function stringMap(server: RawMcpServer, key: string): Array<[string, string]> {
    const value = server.value[key];
    if (value === undefined) return [];
    if (!isObject(value) || Object.keys(value).length > 1024) {
        throw serverError(server.scope, server.name, `${key} must be a string table`);
    }
    return Object.entries(value)
        .map(([name, entry]) => {
            if (typeof entry !== 'string') {
                throw serverError(server.scope, server.name, `${key} must contain only string values`);
            }
            return [name, entry] as [string, string];
        })
        .sort(([left], [right]) => compareText(left, right));
}

function expandTemplate(
    value: string,
    environment: NodeJS.ProcessEnv,
    server: RawMcpServer,
    field: string,
    redactions: RedactionValueCollector
): string {
    ENVIRONMENT_TEMPLATE.lastIndex = 0;
    const expanded = value.replace(ENVIRONMENT_TEMPLATE, (_match, name: string, fallback: string | undefined) => {
        const current = environment[name];
        if (typeof current === 'string' && current.length > 0) {
            redactions.add(current);
            return current;
        }
        if (fallback !== undefined) return fallback;
        throw serverError(server.scope, server.name, `${field} requires environment variable ${name}`);
    });
    // Fail closed on malformed or unsupported shell-style expressions rather
    // than forwarding a credential placeholder verbatim to another process.
    if (expanded.includes('${')) {
        throw serverError(server.scope, server.name, `${field} contains an invalid environment template`);
    }
    return expanded;
}

function collectLiteralCredentials(
    value: string,
    nextValue: string | undefined,
    redactions: RedactionValueCollector
): boolean {
    ENVIRONMENT_TEMPLATE.lastIndex = 0;
    const literal = value.replace(ENVIRONMENT_TEMPLATE, '');
    ENVIRONMENT_TEMPLATE.lastIndex = 0;
    const assignment = CREDENTIAL_OPTION_ASSIGNMENT.exec(literal)?.[1]
        ?? CREDENTIAL_OPTION_PAIR.exec(literal)?.[1]
        ?? CREDENTIAL_ENV_ASSIGNMENT.exec(literal)?.[1];
    let found = false;
    if (assignment) {
        redactions.add(assignment);
        found = true;
    }
    const tokenMatch = CREDENTIAL_TOKEN_LITERAL.exec(literal);
    if (tokenMatch) {
        const token = /^bearer\s+/i.test(tokenMatch[0]) ? tokenMatch[0].replace(/^bearer\s+/i, '') : tokenMatch[0];
        redactions.add(token);
        redactions.add(tokenMatch[0]);
        found = true;
    }
    for (const secret of credentialQueryValues(literal)) {
        redactions.add(secret);
        found = true;
    }
    if (CREDENTIAL_OPTION_NAME.test(value.trim()) && nextValue !== undefined) {
        ENVIRONMENT_TEMPLATE.lastIndex = 0;
        const nextContainsTemplate = ENVIRONMENT_TEMPLATE.test(nextValue);
        ENVIRONMENT_TEMPLATE.lastIndex = 0;
        if (!nextContainsTemplate) {
            redactions.add(nextValue);
            found = true;
        }
    }
    return found;
}

function credentialQueryValues(value: string): string[] {
    const queryStart = value.indexOf('?');
    if (queryStart < 0) return [];
    try {
        const parsed = new URL(value);
        return [...parsed.searchParams.entries()]
            .filter(([name]) => isCredentialName(name))
            .map(([, secret]) => secret)
            .filter(Boolean);
    } catch {
        return value.slice(queryStart + 1).split('&').flatMap(part => {
            const separator = part.indexOf('=');
            if (separator < 0) return [];
            try {
                const name = decodeURIComponent(part.slice(0, separator).replace(/\+/g, ' '));
                const secret = decodeURIComponent(part.slice(separator + 1).replace(/\+/g, ' '));
                return isCredentialName(name) && secret ? [secret] : [];
            } catch {
                return [];
            }
        });
    }
}

function containsCredentialQuery(value: string): boolean {
    const queryStart = value.indexOf('?');
    if (queryStart < 0) return false;
    try {
        const parsed = new URL(value);
        return [...parsed.searchParams.keys()].some(isCredentialName);
    } catch {
        return value.slice(queryStart + 1).split('&').some(part => {
            const separator = part.indexOf('=');
            const name = separator >= 0 ? part.slice(0, separator) : part;
            try { return isCredentialName(decodeURIComponent(name.replace(/\+/g, ' '))); } catch { return true; }
        });
    }
}

function isCredentialName(value: string): boolean {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    return CREDENTIAL_QUERY_NAMES.has(normalized)
        || /(?:apikey|accesskey|accesstoken|authorization|auth|authtoken|bearertoken|clientsecret|cookie|credential|credentials|jwt|password|passwd|secret|session|sessionid|sig|signature|token)$/.test(normalized);
}

function isStrictLoopback(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    return normalized === 'localhost' || normalized === '127.0.0.1'
        || normalized === '::1' || normalized === '[::1]';
}

function configurationIdentity(server: RawMcpServer): string {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalJsonValue({
        schemaVersion: 1,
        name: server.name,
        scope: server.scope,
        configuration: server.value
    }))).digest('hex');
}

function canonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.keys(value).sort(compareText)
        .map(key => [key, canonicalJsonValue(value[key])]));
}

function serverReferencesCredential(server: RawMcpServer, environmentName: string): boolean {
    const command = typeof server.value.command === 'string' ? server.value.command : undefined;
    const url = typeof server.value.url === 'string' ? server.value.url : undefined;
    if (Boolean(command) === Boolean(url)) return false;
    if (command) {
        const env = isObject(server.value.env) ? server.value.env : undefined;
        return env?.[environmentName] === `\${${environmentName}}`;
    }
    return server.value.bearer_token_env_var === environmentName;
}

function pathEquals(left: string, right: string): boolean {
    if (!path.isAbsolute(right) || /[\0\r\n]/.test(right)) return false;
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
        : normalizedLeft === normalizedRight;
}

function pathIsInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readBoundedRegularFile(configPath: string, maxBytes: number, scope: McpConfigurationScope): string {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number;
    try {
        descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | noFollow);
    } catch {
        throw new Error(`Unable to open ${scope} MCP configuration safely.`);
    }
    try {
        const info = fs.fstatSync(descriptor);
        if (!info.isFile()) throw new Error(`The ${scope} MCP configuration must be a regular file.`);
        if (info.size > maxBytes) throw new Error(`The ${scope} MCP configuration is too large.`);
        const buffer = Buffer.allocUnsafe(maxBytes + 1);
        let length = 0;
        while (length <= maxBytes) {
            const read = fs.readSync(descriptor, buffer, length, maxBytes + 1 - length, null);
            if (read === 0) break;
            length += read;
        }
        if (length > maxBytes) throw new Error(`The ${scope} MCP configuration is too large.`);
        return buffer.subarray(0, length).toString('utf8');
    } finally {
        fs.closeSync(descriptor);
    }
}

/**
 * Exact-value redaction is intentionally bounded. Omitting a credential after
 * the bound is reached would silently weaken the logging boundary, so
 * oversized configurations fail before any descriptor is passed to ACP.
 */
class RedactionValueCollector {
    protected readonly collected = new Set<string>();
    protected totalBytes = 0;

    add(value: string): void {
        if (!value || this.collected.has(value)) return;
        const bytes = Buffer.byteLength(value, 'utf8');
        if (this.collected.size >= MAX_REDACTION_VALUES || this.totalBytes + bytes > MAX_REDACTION_BYTES) {
            throw new Error('The resolved MCP secret redaction set is too large.');
        }
        this.collected.add(value);
        this.totalBytes += bytes;
    }

    values(): string[] {
        // Longest first prevents a shorter value from partially rewriting a
        // longer credential before exact-value redaction sees it.
        return [...this.collected].sort((left, right) =>
            right.length - left.length || compareText(left, right));
    }
}

function validateRuntimeString(
    value: string,
    maxBytes: number,
    server: RawMcpServer,
    field: string,
    allowEmpty: boolean,
    rejectNewlines = false
): void {
    if ((!allowEmpty && value.length === 0) || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')
        || (rejectNewlines && /[\r\n]/.test(value))) {
        throw serverError(server.scope, server.name, `has an unsafe ${field}`);
    }
}

function serverError(scope: McpConfigurationScope, name: string, detail: string): Error {
    return new RuntimeMcpServerError(scope, name, detail);
}

class RuntimeMcpServerError extends Error {
    constructor(
        readonly scope: McpConfigurationScope,
        readonly serverName: string,
        readonly detail: string
    ) {
        super(`Invalid ${scope} MCP server "${serverName}": ${detail}.`);
        this.name = 'RuntimeMcpServerError';
    }
}

function runtimeMcpIssue(server: RawMcpServer, error: unknown): RuntimeMcpIssue {
    const detail = error instanceof RuntimeMcpServerError ? error.detail : undefined;
    const missingEnvironment = detail?.match(/requires environment variable ([A-Z][A-Z0-9_]*)$/)?.[1];
    if (missingEnvironment) {
        return {
            name: server.name,
            scope: server.scope,
            severity: 'error',
            code: 'missing-environment',
            message: `缺少环境变量 ${missingEnvironment}；当前会话已跳过该 MCP，Agent 与其他服务可继续使用。`
        };
    }
    return {
        name: server.name,
        scope: server.scope,
        severity: 'error',
        code: 'invalid-configuration',
        message: detail
            ? `配置无法加载（${detail}）；当前会话已跳过该 MCP，Agent 与其他服务可继续使用。`
            : '配置无法安全加载；当前会话已跳过该 MCP，Agent 与其他服务可继续使用。'
    };
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
