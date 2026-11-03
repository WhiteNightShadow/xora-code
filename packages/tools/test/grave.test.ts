import { describe, expect, it } from 'vitest';
import { graveOfCommand, graveOfTool } from '../src/grave.ts';

/** What still comes to the user when a supervisor reviews the rest (06 §24): mass deletion and dropping databases. */

const where = { cwd: '/work/shop', roots: ['/work/shop'], home: '/Users/me' };
const action = (command: string) => graveOfCommand(command, where)?.action;

describe('grave actions', () => {
    it('finds deletes that reach far: the system, the home folder, a workspace as a whole', () => {
        for (const command of [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf ~/Documents',
            'rm -rf /Users/me',
            'sudo rm -rf /usr/local',
            'rm -rf /opt/homebrew',
            'rm -rf /data',
            'rm -rf .',
            'rm -rf *',
            'rm -rf ./*',
            'rm -rf .git',
            'rm -rf ..',
            'rm -rf "$BUILD_DIR"/',
            'rm -rf $TARGET/*',
            'rm --no-preserve-root -rf /x',
            'find . -delete',
            'find ~ -type f -exec rm {} +',
            'bash -c "rm -rf ~/Desktop"',
            // PowerShell takes forward slashes too; a backslash is an escape outside Windows.
            'Remove-Item -Recurse C:/Users/me',
            'dd if=/dev/zero of=/dev/disk2',
            'diskutil eraseDisk APFS X disk2',
            'terraform destroy -auto-approve',
            'kubectl delete namespace prod',
            'aws s3 rm s3://bucket --recursive',
            "ssh prod 'rm -rf /var/www'",
        ]) {
            expect(action(command), command).toBe('mass_delete');
        }
    });

    it('counts many targets at once as mass deletion', () => {
        expect(action(`rm -rf ${Array.from({ length: 10 }, (_, index) => `dir${index}`).join(' ')}`)).toBe(
            'mass_delete',
        );
        expect(action('rm -rf a b c')).toBeUndefined();
    });

    it('finds dropped databases: SQL to a client, database tools, framework resets, volumes and database files', () => {
        for (const command of [
            'psql -c "DROP DATABASE shop"',
            'mysql -e "drop table users"',
            'mysql shop -e "TRUNCATE orders"',
            "echo 'DROP SCHEMA public CASCADE' | psql",
            'psql <<SQL\nDROP TABLE orders;\nSQL',
            'dropdb shop',
            'mysqladmin -u root drop shop',
            'redis-cli -n 0 FLUSHALL',
            'mongosh shop --eval "db.dropDatabase()"',
            'npx prisma migrate reset --force',
            'pnpm prisma db push --force-reset',
            'bin/rails db:drop',
            'python manage.py flush --noinput',
            'php artisan migrate:fresh',
            'supabase db reset',
            'docker compose down -v',
            'docker volume prune -f',
            'rm -f prisma/dev.db',
            'rm data.sqlite3',
            'rm -rf /var/lib/mysql',
            "ssh db1 'redis-cli flushall'",
        ]) {
            expect(action(command), command).toBe('drop_database');
        }
    });

    it('leaves ordinary work to the supervisor', () => {
        for (const command of [
            'rm -rf node_modules dist build .cache coverage',
            'rm -rf src/generated',
            'rm -rf src/*',
            'rm -rf /tmp/xora-build',
            'rm -rf ~/Library/Caches/shop',
            'rm notes.txt',
            'find . -name "*.pyc" -delete',
            'git clean -fdx',
            'git push origin main',
            'npm publish',
            'grep -rn "DROP TABLE" migrations',
            'cat schema.sql',
            'docker compose down',
            'psql -c "select count(*) from users"',
            'sqlite3 app.db "delete from sessions where expired = 1"',
            "ssh prod 'systemctl restart shop'",
            'pnpm test',
        ]) {
            expect(action(command), command).toBeUndefined();
        }
    });

    it('reads MCP tools by their names', () => {
        expect(graveOfTool('mcp__postgres__drop_table')?.action).toBe('drop_database');
        expect(graveOfTool('mcp__supabase__resetDatabase')?.action).toBe('drop_database');
        expect(graveOfTool('mcp__mongo__deleteCollection')?.action).toBe('drop_database');
        expect(graveOfTool('mcp__postgres__query')).toBeUndefined();
        expect(graveOfTool('mcp__files__delete_file')).toBeUndefined();
        expect(graveOfTool('edit')).toBeUndefined();
    });
});
