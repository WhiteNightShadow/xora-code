import { describe, expect, it } from 'vitest';
import { globsOverlap, normalizePath, outOfOwnership, ownershipMatcher, ownershipOverlap } from '../src/index.ts';

describe('globsOverlap', () => {
    it.each([
        ['src/auth/**', 'src/auth/sms/verify.ts', true],
        ['src/auth/**', 'src/routes/auth.ts', false],
        ['src/**/*.ts', 'src/auth/**', true],
        ['src/*.ts', 'src/auth/**', false],
        ['src/**/*.ts', 'src/**/*.css', false],
        ['**/*.test.ts', 'src/auth/*.ts', true],
        ['src/auth', 'src/auth/sms/**', true],
        ['src/auth/', 'src/auth.ts', false],
        ['src/auth', 'src/authz/index.ts', false],
        ['src/{auth,users}/**', 'src/users/model.ts', true],
        ['src/{auth,users}/**', 'src/billing/**', false],
        ['src/**/auth/*.ts', 'src/server/**', true],
        ['docs/*.md', 'docs/guide/*.md', false],
        ['packages/*/src/**', 'packages/workflows/src/board.ts', true],
        ['*.config.ts', 'vite.config.*', true],
        ['./src/a.ts', 'src\\a.ts', true],
        ['src/a?.ts', 'src/ab.ts', true],
        ['src/[ab].ts', 'src/c.ts', false],
        ['!src/auth/**', 'src/auth/a.ts', false],
    ])('%s ~ %s is %s', (a, b, expected) => {
        expect(globsOverlap(a, b)).toBe(expected);
        expect(globsOverlap(b, a)).toBe(expected);
    });

    it('lists the overlapping pairs of two ownership lists', () => {
        expect(ownershipOverlap(['src/auth/**', 'docs/auth.md'], ['src/routes/**', 'src/auth/index.ts'])).toEqual([
            ['src/auth/**', 'src/auth/index.ts'],
        ]);
        expect(ownershipOverlap(['src/a/**'], ['src/b/**'])).toEqual([]);
        expect(ownershipOverlap([], ['**'])).toEqual([]);
    });
});

describe('outOfOwnership', () => {
    it('flags changes outside the globs, literals owning what is below them', () => {
        const card = { ownership: ['src/auth/sms/**', 'src/routes/auth.ts', 'docs/auth'] };
        expect(
            outOfOwnership(card, [
                'src/auth/sms/verify.ts',
                './src/routes/auth.ts',
                'docs/auth/README.md',
                'src/auth/session.ts',
                'src\\db\\schema.ts',
                'src/auth/session.ts',
            ]),
        ).toEqual(['src/auth/session.ts', 'src/db/schema.ts']);
    });

    it('treats everything as outside an empty ownership', () => {
        expect(outOfOwnership({ ownership: [] }, ['a.ts'])).toEqual(['a.ts']);
    });

    it('honours exclusions, dotfiles and literal bracket paths', () => {
        const owned = ownershipMatcher(['src/**', '!src/generated/**', 'app/[id]/page.tsx']);
        expect(owned('src/.env.example')).toBe(true);
        expect(owned('src/generated/api.ts')).toBe(false);
        // Read both ways: literally (a next.js route directory) and as a glob.
        expect(owned('app/[id]/page.tsx')).toBe(true);
        expect(owned('app/i/page.tsx')).toBe(true);
        expect(owned('app/x/page.tsx')).toBe(false);
    });

    it('normalises paths', () => {
        expect(normalizePath(' ./src//auth/ ')).toBe('src/auth');
        expect(normalizePath('src\\a.ts')).toBe('src/a.ts');
    });
});
