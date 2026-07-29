// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

export type RunnerPlatform = 'posix' | 'windows';
export type RunnerMode = 'run' | 'test';

export interface RunnerAction {
    readonly label: string;
    readonly executable: string;
    readonly args: readonly string[];
}

export interface CurrentFileRunnerPlan {
    readonly language: string;
    readonly run: RunnerAction;
    readonly test?: RunnerAction;
}

export const toTerminalCommandArgs = (action: RunnerAction): string[] => [action.executable, ...action.args];

const fileExtension = (filePath: string): string => {
    const fileName = filePath.split(/[\\/]/).pop() ?? '';
    const separator = fileName.lastIndexOf('.');
    return separator > 0 ? fileName.slice(separator).toLowerCase() : '';
};

const directAction = (label: string, executable: string, ...args: string[]): RunnerAction => ({
    label,
    executable,
    args
});

const nativePosixAction = (
    filePath: string,
    compiler: 'cc' | 'c++' | 'rustc',
    testMode: boolean
): RunnerAction => {
    const compilerFlags = testMode && compiler !== 'rustc'
        ? '"$compiler" -Wall -Wextra "$source" -o "$output"'
        : compiler === 'rustc' && testMode
            ? '"$compiler" --test "$source" -o "$output"'
            : '"$compiler" "$source" -o "$output"';
    const script = [
        'compiler="$1"',
        'source="$2"',
        'output="${TMPDIR:-/tmp}/xora-code-run-$$"',
        'trap \'rm -f "$output"\' EXIT INT TERM',
        'if ! command -v "$compiler" >/dev/null 2>&1; then echo "Xora Code：未找到编译器 $compiler，请先安装对应开发工具。" >&2; exit 127; fi',
        compilerFlags,
        '"$output"'
    ].join('; ');
    return directAction(testMode ? '编译并测试当前文件' : '编译并运行当前文件', 'sh', '-c', script, 'xora-run', compiler, filePath);
};

const nativeWindowsAction = (
    filePath: string,
    language: 'c' | 'cpp' | 'rust',
    testMode: boolean
): RunnerAction => {
    const candidates = language === 'c'
        ? '@("gcc", "clang")'
        : language === 'cpp'
            ? '@("g++", "clang++")'
            : '@("rustc")';
    const flags = language === 'rust'
        ? testMode ? '@("--test", $source, "-o", $output)' : '@($source, "-o", $output)'
        : testMode ? '@("-Wall", "-Wextra", $source, "-o", $output)' : '@($source, "-o", $output)';
    const script = [
        '$source = $args[0]',
        '$output = Join-Path $env:TEMP ("xora-code-run-" + [guid]::NewGuid().ToString("N") + ".exe")',
        `$compiler = Get-Command ${candidates} -ErrorAction SilentlyContinue | Select-Object -First 1`,
        'if (-not $compiler) { Write-Error "Xora Code：未找到可用编译器，请先安装 GCC、Clang 或 Rust 工具链。"; exit 127 }',
        'try {',
        `  $compileArgs = ${flags}`,
        '  & $compiler.Source @compileArgs',
        '  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '  & $output',
        '  exit $LASTEXITCODE',
        '} finally { Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue }'
    ].join('; ');
    return directAction(
        testMode ? '编译并测试当前文件' : '编译并运行当前文件',
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
        filePath
    );
};

const nativeAction = (
    filePath: string,
    language: 'c' | 'cpp' | 'rust',
    platform: RunnerPlatform,
    testMode: boolean
): RunnerAction => {
    if (platform === 'windows') {
        return nativeWindowsAction(filePath, language, testMode);
    }
    const compiler = language === 'c' ? 'cc' : language === 'cpp' ? 'c++' : 'rustc';
    return nativePosixAction(filePath, compiler, testMode);
};

/**
 * Produces shell-safe execution arguments without interpolating the source path
 * into scripts. TerminalWidget.executeCommand performs the final shell quoting.
 */
export const createCurrentFileRunnerPlan = (filePath: string, platform: RunnerPlatform): CurrentFileRunnerPlan | undefined => {
    const extension = fileExtension(filePath);
    switch (extension) {
        case '.py': {
            const executable = platform === 'windows' ? 'py' : 'python3';
            const prefix = platform === 'windows' ? ['-3'] : [];
            return {
                language: 'Python',
                run: directAction('运行当前 Python 文件', executable, ...prefix, filePath),
                test: directAction('测试当前 Python 文件', executable, ...prefix, '-m', 'pytest', filePath)
            };
        }
        case '.js':
        case '.mjs':
        case '.cjs':
            return {
                language: 'JavaScript',
                run: directAction('运行当前 JavaScript 文件', 'node', filePath),
                test: directAction('使用 Node Test 测试当前文件', 'node', '--test', filePath)
            };
        case '.ts':
        case '.mts':
        case '.cts':
            return {
                language: 'TypeScript',
                run: directAction('运行当前 TypeScript 文件（需要 Node.js 22.6+）', 'node', '--experimental-strip-types', filePath),
                test: directAction('使用 Node Test 测试当前 TypeScript 文件', 'node', '--experimental-strip-types', '--test', filePath)
            };
        case '.c':
            return {
                language: 'C',
                run: nativeAction(filePath, 'c', platform, false),
                test: nativeAction(filePath, 'c', platform, true)
            };
        case '.cc':
        case '.cpp':
        case '.cxx':
            return {
                language: 'C++',
                run: nativeAction(filePath, 'cpp', platform, false),
                test: nativeAction(filePath, 'cpp', platform, true)
            };
        case '.java':
            return {
                language: 'Java',
                run: directAction('运行当前 Java 源文件（需要 Java 11+）', 'java', filePath),
                test: directAction('以断言模式测试当前 Java 源文件', 'java', '-ea', filePath)
            };
        case '.go':
            return {
                language: 'Go',
                run: directAction('运行当前 Go 文件', 'go', 'run', filePath),
                test: directAction('测试当前 Go 包', 'go', 'test', '.')
            };
        case '.rs':
            return {
                language: 'Rust',
                run: nativeAction(filePath, 'rust', platform, false),
                test: nativeAction(filePath, 'rust', platform, true)
            };
        case '.sh':
        case '.bash':
            return {
                language: 'Shell',
                run: directAction('运行当前 Shell 文件', 'bash', filePath),
                test: directAction('检查当前 Shell 文件语法', 'bash', '-n', filePath)
            };
        default:
            return undefined;
    }
};
