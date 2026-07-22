// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

/**
 * Packaging / startup guard for editor syntax highlighting.
 *
 * Monaco needs VS Code builtin language extensions (TextMate grammars) under
 * the monorepo `plugins/` directory. Without them, source files open as plain
 * text. Required languages are listed in builtin-language-plugins.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const pluginsDir = path.resolve(__dirname, '..', '..', '..', 'plugins');
const manifestPath = path.join(__dirname, 'builtin-language-plugins.json');
const minExpected = 20;

function main() {
    if (!fs.existsSync(pluginsDir)) {
        fail(`plugins directory missing: ${pluginsDir}`);
    }

    const entries = fs.readdirSync(pluginsDir).filter(name => name !== '.gitkeep' && !name.startsWith('.'));
    if (entries.length < minExpected) {
        fail(
            `only ${entries.length} plugin(s) found in ${pluginsDir} (need ≥ ${minExpected}).\n` +
            `Run from repo root: yarn download:plugins\n` +
            `This installs vscode-builtin-extensions (JS/TS/C/C++/Python/JSON/Markdown/… syntax highlighting).`
        );
    }

    const required = loadRequiredPluginIds();
    const missing = required.filter(id => !pluginPresent(entries, id));
    if (missing.length) {
        fail(
            `missing required language plugin(s):\n  - ${missing.join('\n  - ')}\n` +
            `Run from repo root: yarn download:plugins`
        );
    }

    const summary = required
        .slice(0, 12)
        .map(id => id.replace(/^vscode\./, ''))
        .join(', ');
    console.log(
        `ensure-plugins: ok (${entries.length} plugins; required languages present: ${summary}, …)`
    );
    console.log('ensure-plugins: plain .txt uses the editor built-in plaintext mode (no grammar plugin).');
}

function loadRequiredPluginIds() {
    if (!fs.existsSync(manifestPath)) {
        // Fallback core set if the manifest is missing.
        return [
            'vscode.javascript',
            'vscode.typescript',
            'vscode.cpp',
            'vscode.python',
            'vscode.json',
            'vscode.markdown'
        ];
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return (manifest.required || []).map(item => item.id).filter(Boolean);
}

function pluginPresent(entries, pluginId) {
    // Downloaded packs may appear as either a directory name or a packed .vsix stem.
    if (entries.includes(pluginId)) return true;
    return entries.some(name => name === pluginId || name.startsWith(`${pluginId}@`) || name.startsWith(`${pluginId}-`));
}

function fail(message) {
    console.error(`ensure-plugins: ${message}`);
    process.exit(1);
}

main();
