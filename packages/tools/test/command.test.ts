import { describe, expect, it } from 'vitest';
import { isReadOnlyCommand, splitShellCommand } from '../src/index.ts';

const words = (command: string): string[][] =>
    splitShellCommand(command).segments.map((segment) => segment.words.map((word) => word.value));

describe('splitShellCommand', () => {
    it('splits on control operators and newlines', () => {
        expect(words('a 1 && b || c; d | e\nf & g')).toEqual([['a', '1'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']]);
        expect(splitShellCommand('a && b').segments.map((segment) => segment.text)).toEqual(['a', 'b']);
    });

    it('respects quotes and escapes', () => {
        expect(words(`echo "a && b" 'c; d' e\\;f "x\\"y" \\$HOME`)).toEqual([
            ['echo', 'a && b', 'c; d', 'e;f', 'x"y', '$HOME'],
        ]);
        expect(words('echo a\\\nb')).toEqual([['echo', 'ab']]);
        expect(words("echo ''")).toEqual([['echo', '']]);
    });

    it('keeps backslashes as ordinary characters for PowerShell', () => {
        const literal = (command: string): string[][] =>
            splitShellCommand(command, { literalBackslash: true }).segments.map((segment) =>
                segment.words.map((word) => word.value),
            );
        expect(literal('Remove-Item -Recurse C:\\work\\proj')).toEqual([['Remove-Item', '-Recurse', 'C:\\work\\proj']]);
        expect(literal('rm "C:\\my work\\" x')).toEqual([['rm', 'C:\\my work\\', 'x']]);
        expect(literal('del \\\\server\\share\\x; dir')).toEqual([['del', '\\\\server\\share\\x'], ['dir']]);
        // POSIX shells read the same text differently.
        expect(words('rm C:\\work\\proj')).toEqual([['rm', 'C:workproj']]);
    });

    it('drops comments', () => {
        expect(words('ls -la # && rm -rf /')).toEqual([['ls', '-la']]);
        expect(words('echo a#b')).toEqual([['echo', 'a#b']]);
    });

    it('flags output redirections, but not discards and descriptor copies', () => {
        const flagged = (command: string): boolean => splitShellCommand(command).hasOutputRedirection;
        expect(flagged('echo hi > out.txt')).toBe(true);
        expect(flagged('echo hi >> log')).toBe(true);
        expect(flagged('make &> build.log')).toBe(true);
        expect(flagged('make >&build.log')).toBe(true);
        expect(flagged('cat <> file')).toBe(true);
        expect(flagged('echo hi > $FILE')).toBe(true);
        expect(flagged('ls 2>/dev/null')).toBe(false);
        expect(flagged('ls > /dev/null 2>&1')).toBe(false);
        expect(flagged('echo oops >&2')).toBe(false);
        expect(flagged('wc -l < input.txt')).toBe(false);
        expect(flagged('cat <<< "text"')).toBe(false);
        const [segment] = splitShellCommand('sort 2> err.txt data.txt').segments;
        expect(segment?.words.map((word) => word.value)).toEqual(['sort', 'data.txt']);
        expect(segment?.redirects).toEqual([
            { operator: '>', target: { value: 'err.txt', dynamic: false }, writes: true },
        ]);
    });

    it('flags command and process substitution', () => {
        for (const command of [
            'echo $(whoami)',
            'echo `whoami`',
            'echo "$(whoami)"',
            'diff <(ls a) <(ls b)',
            'echo $((1+2))',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax under test
            'echo ${x:-$(id)}',
        ]) {
            expect(splitShellCommand(command).hasSubstitution, command).toBe(true);
        }
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax under test
        for (const command of ["echo '$(whoami)'", 'echo \\`whoami\\`', 'echo ${HOME}']) {
            expect(splitShellCommand(command).hasSubstitution, command).toBe(false);
        }
    });

    it('flags subshells and groups but still splits inside them', () => {
        const subshell = splitShellCommand('(cd sub && rm -rf build)');
        expect(subshell.hasSubshell).toBe(true);
        expect(subshell.segments.map((segment) => segment.words[0]?.value)).toEqual(['cd', 'rm']);
        const group = splitShellCommand('{ ls; pwd; } > out.txt');
        expect(group.hasSubshell).toBe(true);
        expect(group.hasOutputRedirection).toBe(true);
        expect(splitShellCommand('(ls) && pwd').incomplete).toBe(false);
    });

    it('marks what it cannot model as incomplete', () => {
        for (const command of [
            'echo "open',
            "echo 'open",
            'echo $(open',
            'cat <<EOF\nhi\nEOF',
            'ls &&',
            '| ls',
            'ls ; ; ls',
            'case x in a) ;; esac',
            'echo >',
        ]) {
            expect(splitShellCommand(command).incomplete, command).toBe(true);
        }
        expect(splitShellCommand('ls &&\n  pwd').incomplete).toBe(false);
        expect(splitShellCommand('ls;').incomplete).toBe(false);
    });

    it('marks words the shell may still expand', () => {
        const dynamic = (command: string): boolean[] =>
            splitShellCommand(command).segments.flatMap((segment) => segment.words.map((word) => word.dynamic));
        expect(dynamic('ls *.ts')).toEqual([false, true]);
        expect(dynamic('ls \'*.ts\' "a?"')).toEqual([false, false, false]);
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax under test
        expect(dynamic('echo $HOME ${USER} plain')).toEqual([false, true, true, false]);
        expect(dynamic('find -{de,}lete')).toEqual([false, true]);
        expect(dynamic('git show HEAD@{1}')).toEqual([false, false, false]);
        expect(dynamic("echo $'\\x41'")).toEqual([false, true]);
    });
});

describe('isReadOnlyCommand', () => {
    it.each([
        'ls -la',
        'ls',
        'pwd',
        'cat package.json | grep version | head -5',
        'wc -l src/*.ts',
        'echo $HOME',
        'cd packages/tools && ls',
        'ls 2>/dev/null',
        'grep -rn "TODO" src',
        'rg foo src --type ts',
        'find . -name "*.ts" -type f',
        'tree -L 2 -I node_modules',
        'sort data.txt | uniq -c',
        'du -sh .',
        'df -h',
        'diff a.txt b.txt',
        'stat README.md',
        'which node',
        'type ls',
        'file README.md',
        'git status',
        'git status --porcelain',
        'git diff --stat HEAD~1',
        'git log --oneline -n 5',
        'git show HEAD~1:src/a.ts',
        'git -C packages/tools status',
        'git --no-pager log -1',
        'git rev-parse --show-toplevel',
        'git ls-files',
        'git blame -L 1,10 README.md',
        'git branch',
        'git branch -a',
        'git branch -vv',
        "git branch --list 'feat/*'",
        'git branch --contains HEAD',
        'git branch --sort=-committerdate',
        'git tag',
        'git tag -l',
        "git tag -l 'v1.*'",
        'git remote -v',
        'git --version',
        'node --version',
        'npm -v',
        'pnpm --version',
        'python3 -V',
        'python --version',
        'ls # rm -rf /',
    ])('allows %s', (command) => {
        expect(isReadOnlyCommand(command)).toBe(true);
    });

    it.each([
        '',
        'rm -rf build',
        'find . -delete',
        'find . -name "*.tmp" -exec rm {} \\;',
        'find . -execdir rm {} +',
        'find . -fprint out.txt',
        'find . -ok rm {} \\;',
        'find *',
        'find . -{de,}lete',
        'git branch -D old',
        'git branch -d old',
        'git branch -m a b',
        'git branch new-feature',
        'git branch --set-upstream-to=origin/main',
        'git tag v1.0',
        'git tag -d v1.0',
        'git tag -a v1 -m release',
        'git log --output=log.txt',
        'git diff --out=diff.txt',
        'git -c core.pager=evil log',
        'git -c core.fsmonitor=evil status',
        '--git-dir=/tmp/x status',
        'git --git-dir=/tmp/x status',
        'git remote add origin url',
        'git push',
        'git commit -m "x"',
        'git checkout main',
        'git log $(evil)',
        'git log *',
        'echo hi > f',
        'echo hi >> f',
        'ls > listing.txt',
        'cat $(x)',
        'cat `x`',
        'cat <(rm -rf x)',
        'ls && rm -rf x',
        'ls; rm x',
        'ls | sh',
        'ls | xargs rm',
        '(ls)',
        '{ ls; }',
        'sort -o out.txt in.txt',
        'sort -ro out.txt in.txt',
        'sort --output=out.txt in.txt',
        'sort --compress-program=evil in.txt',
        'uniq in.txt out.txt',
        'tree -o out.txt',
        'file -C -m magic',
        'rg --pre ./evil foo',
        'rg --pre=./evil foo',
        'ag --pager less foo',
        'node script.js',
        "node -e \"require('fs').rmSync('x')\"",
        'npm install',
        'npm --version extra',
        'python -c "print(1)"',
        'PAGER=evil git log',
        'FOO=1 ls',
        './ls',
        '/bin/ls',
        '$CMD',
        'echo "unterminated',
        'cat <<EOF\nhello\nEOF',
        'sed -i s/a/b/ file',
        'awk "{print}" file',
        'env rm x',
        'command ls',
        'sudo ls',
        'ls &&',
    ])('refuses %s', (command) => {
        expect(isReadOnlyCommand(command)).toBe(false);
    });
});
