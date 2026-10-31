import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type HighRiskAction, highRiskOfCommand, highRiskOfTool } from '../src/index.ts';

const workspace = path.resolve('/work/project');
const home = path.resolve('/home/me');
const action = (command: string): HighRiskAction | undefined =>
    highRiskOfCommand(command, { cwd: workspace, roots: [workspace], home })?.action;

/**
 * High-risk actions (06 §8) need a person at every autonomy level. Each row is a command and what it does; a miss
 * here is an action that could run unattended.
 */
const FLAGGED: Array<[string, HighRiskAction]> = [
    // Pushing
    ['git push', 'push'],
    ['git push origin main --force', 'push'],
    ['git -C ../other push', 'push'],
    ['git --git-dir=.git -c core.askpass=true push origin', 'push'],
    ['git add . && git commit -m "x" && git push', 'push'],
    ['cd sub; git push -u origin feature', 'push'],
    ['GIT_TRACE=1 git push', 'push'],
    ['/usr/bin/git push', 'push'],
    ['sudo -u deploy git push', 'push'],
    ['env -i PATH=/usr/bin git push', 'push'],
    ['timeout 60 git push', 'push'],
    ['bash -lc "git push"', 'push'],
    ["sh -c 'cd repo && git push'", 'push'],
    ['eval "git push"', 'push'],
    ['echo "$(git push 2>&1)"', 'push'],
    ['git commit -F- <<EOF\nmessage\nEOF\ngit push', 'push'],
    ['if git push; then echo ok; fi', 'push'],
    ['gh pr merge 12 --squash', 'push'],
    ['gh repo sync', 'push'],
    ['gh api -X PATCH repos/o/r -f name=x', 'push'],
    ["gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }'", 'push'],
    ['glab mr merge 3', 'push'],
    // Publishing
    ['npm publish', 'publish'],
    ['npm publish --access public', 'publish'],
    ['pnpm publish', 'publish'],
    ['pnpm -r publish --no-git-checks', 'publish'],
    ['pnpm --filter @scope/pkg publish', 'publish'],
    ['yarn publish', 'publish'],
    ['yarn npm publish', 'publish'],
    ['yarn workspaces foreach -A npm publish', 'publish'],
    ['bun publish', 'publish'],
    ['npm run release', 'publish'],
    ['pnpm deploy:prod', 'publish'],
    ['yarn release', 'publish'],
    ['make deploy', 'publish'],
    ['cargo publish', 'publish'],
    ['cargo +nightly publish --allow-dirty', 'publish'],
    ['twine upload dist/*', 'publish'],
    ['python -m twine upload dist/*', 'publish'],
    ['python3 setup.py sdist upload', 'publish'],
    ['poetry publish --build', 'publish'],
    ['uv publish', 'publish'],
    ['gem push pkg-1.0.gem', 'publish'],
    ['mvn clean deploy', 'publish'],
    ['./gradlew publishToSonatype', 'publish'],
    ['dotnet nuget push pkg.nupkg', 'publish'],
    ['docker push registry.example.com/app:1.0', 'publish'],
    ['docker image push app', 'publish'],
    ['docker buildx build --push -t app .', 'publish'],
    ['podman push app', 'publish'],
    ['gh release create v1.0.0 --notes x', 'publish'],
    ['gh workflow run deploy.yml', 'publish'],
    ['npx semantic-release', 'publish'],
    ['npx -y vercel --prod', 'publish'],
    ['vercel deploy', 'publish'],
    ['npx wrangler deploy', 'publish'],
    ['netlify deploy --prod', 'publish'],
    ['firebase deploy --only hosting', 'publish'],
    ['fly deploy', 'publish'],
    ['kubectl apply -f deploy.yaml', 'publish'],
    ['helm upgrade --install app ./chart', 'publish'],
    ['helm install -n prod app ./chart', 'publish'],
    ['poetry publish -n', 'publish'],
    ['terraform apply -auto-approve', 'publish'],
    ['aws s3 sync dist s3://bucket/site', 'publish'],
    ['gcloud run deploy api --image x', 'publish'],
    ['rsync -avz dist/ deploy@server:/srv/www', 'publish'],
    ['scp build.tar.gz user@host:/tmp/', 'publish'],
    // Deleting outside the workspace or broadly
    ['rm -rf /', 'delete'],
    ['rm -rf /tmp/build', 'delete'],
    ['rm -rf ~', 'delete'],
    ['rm -rf ~/projects/other', 'delete'],
    ['rm -rf ..', 'delete'],
    ['rm -rf ../sibling', 'delete'],
    ['rm -rf .', 'delete'],
    ['rm -rf ./', 'delete'],
    ['rm -rf *', 'delete'],
    ['rm -rf ./*', 'delete'],
    ['rm -rf .git', 'delete'],
    ['rm -rf "$BUILD_DIR/"', 'delete'],
    ['rm -r $(mktemp -d)', 'delete'],
    ['rm -f /etc/hosts', 'delete'],
    ['rm --no-preserve-root -rf /', 'delete'],
    ['sudo rm -rf /var/lib/app', 'delete'],
    ['find / -name "*.log" -delete', 'delete'],
    ['find . -delete', 'delete'],
    ['find /tmp -type f -exec rm {} +', 'delete'],
    ['ls | xargs rm -rf', 'delete'],
    ['git clean -fdx', 'delete'],
    ['shred -u secret.txt', 'delete'],
    ['docker volume rm data', 'delete'],
    ['docker compose down -v', 'delete'],
    ['kubectl delete namespace prod', 'delete'],
    ['terraform destroy', 'delete'],
    ['aws s3 rm s3://bucket --recursive', 'delete'],
    ['gh repo delete o/r --yes', 'delete'],
    ['npm unpublish pkg@1.0.0', 'delete'],
    ['ssh prod "rm -rf /var/www/app/cache"', 'delete'],
    ['rsync -a --delete dist/ /var/www/', 'delete'],
    ['curl -X DELETE https://api.example.com/items/1', 'delete'],
    // Messaging outside the team
    ['curl -X POST https://hooks.slack.com/services/T/B/x -d \'{"text":"hi"}\'', 'external_message'],
    ['curl -sSd \'{"text":"hi"}\' https://discord.com/api/webhooks/1/x', 'external_message'],
    ['curl --json \'{"a":1}\' https://example.com/api', 'external_message'],
    ['curl smtp://mail.example.com --mail-rcpt a@example.com -T mail.txt', 'external_message'],
    ['wget --post-data "a=1" https://example.com/form', 'external_message'],
    ['http POST https://api.example.com/messages text=hi', 'external_message'],
    ['xh https://api.example.com/messages text=hi', 'external_message'],
    ['gh pr create --fill', 'external_message'],
    ['gh issue comment 5 --body "done"', 'external_message'],
    ['mail -s "report" boss@example.com < report.txt', 'external_message'],
    ['sendmail -t < message.eml', 'external_message'],
    ['git send-email --to=list@example.com 0001.patch', 'external_message'],
    // Payments
    ['curl https://api.stripe.com/v1/charges -u sk_test_x: -d amount=100', 'payment'],
    ['curl -X POST https://api-m.paypal.com/v2/checkout/orders', 'payment'],
    ['stripe charges create --amount 100', 'payment'],
    ['stripe post /v1/payment_intents -d amount=100', 'payment'],
];

/** Look like it, but stay on this machine and inside the workspace, or only read. */
const NOT_FLAGGED: string[] = [
    'git status',
    'git log --grep=push',
    'git push --dry-run',
    'git push -n origin main',
    'git commit -m "push later; then publish"',
    'git stash push -m wip',
    'git clean -n',
    'echo "git push"',
    'grep -r "rm -rf /" .',
    'gh pr view 12',
    'gh pr list',
    'gh api repos/o/r/pulls',
    'gh api graphql -f query="query { viewer { login } }"',
    'npm publish --dry-run',
    'npm run build',
    'npm test',
    'pnpm install',
    'pnpm deploy ./out',
    'pnpm run dev',
    'yarn build',
    'cargo build --release',
    'cargo publish --dry-run',
    'python -m pip install -r requirements.txt',
    'mvn install',
    './gradlew publishToMavenLocal',
    'docker build -t app .',
    'docker run --rm app',
    'docker rm old-container',
    'docker compose down',
    'kubectl get pods',
    'kubectl apply --dry-run=client -f x.yaml',
    'kubectl rollout status deploy/app',
    'terraform plan',
    'helm template ./chart',
    'vercel dev',
    'aws s3 ls s3://bucket',
    'gcloud projects list',
    'rm -rf node_modules dist',
    'rm -rf build/*',
    'rm *.log',
    'rm -f "$TMPFILE"',
    'rmdir empty-dir',
    'find . -name "*.pyc" -delete',
    'find . -type f -name "*.tmp" -exec rm {} +',
    'rsync -a src/ backup/',
    'scp user@host:/var/log/app.log .',
    'curl https://example.com',
    'curl -s http://localhost:3000/api -X POST -d x=1',
    'curl -X POST http://127.0.0.1:8080/hook',
    'http GET https://api.example.com/items',
    'wget https://example.com/file.tar.gz',
    'ssh host ls -la',
    'mail',
    'stripe listen --forward-to localhost:3000',
    'gh constructor create',
    'cargo constructor',
    "rm -rf '$NOT_EXPANDED'",
];

describe('highRiskOfCommand', () => {
    for (const [command, expected] of FLAGGED) {
        it(`${JSON.stringify(command)} → ${expected}`, () => {
            expect(action(command)).toBe(expected);
        });
    }
    for (const command of NOT_FLAGGED) {
        it(`${JSON.stringify(command)} → not high risk`, () => {
            expect(action(command)).toBeUndefined();
        });
    }

    it('says what matched', () => {
        expect(highRiskOfCommand('cd x && git push origin main', { cwd: workspace })).toEqual({
            action: 'push',
            what: 'git push origin main',
        });
        expect(highRiskOfCommand('rm -rf /tmp/x', { cwd: workspace, home })?.what).toBe('rm -rf /tmp/x');
    });

    it('judges deletes against every root it is given', () => {
        const worktree = path.resolve('/data/worktrees/t1');
        const roots = [workspace, worktree];
        expect(highRiskOfCommand(`rm -rf ${worktree}/dist`, { cwd: workspace, roots, home })).toBeUndefined();
        expect(highRiskOfCommand(`rm -rf ${worktree}`, { cwd: workspace, roots, home })?.action).toBe('delete');
    });

    it('treats every delete on another machine as high risk', () => {
        expect(action('ssh host rm old.log')).toBe('delete');
        expect(action('kubectl exec app-0 -- rm -rf /data/tmp')).toBe('delete');
    });
});

describe('highRiskOfTool', () => {
    const TOOLS: Array<[string, HighRiskAction | undefined]> = [
        ['mcp__github__merge_pull_request', 'push'],
        ['mcp__github__push_files', 'push'],
        ['mcp__github__create_or_update_file', 'push'],
        ['mcp__github__create_issue', 'external_message'],
        ['mcp__github__add_issue_comment', 'external_message'],
        ['mcp__github__get_issue', undefined],
        ['mcp__github__list_pull_requests', undefined],
        ['mcp__slack__slack_post_message', 'external_message'],
        ['mcp__slack__slack_reply_to_thread', 'external_message'],
        ['mcp__slack__slack_get_channel_history', undefined],
        ['mcp__gmail__sendEmail', 'external_message'],
        ['mcp__gmail__searchEmails', undefined],
        ['mcp__stripe__create_payment_intent', 'payment'],
        ['mcp__stripe__create_refund', 'payment'],
        ['mcp__stripe__list_payment_intents', undefined],
        ['mcp__db__delete_rows', 'delete'],
        ['mcp__vercel__deploy_project', 'publish'],
        ['mcp__filesystem__write_file', undefined],
        ['mcp__filesystem__read_file', undefined],
        ['mcp__browser__click', undefined],
        ['mcp__context7__get-library-docs', undefined],
        ['read', undefined],
        ['bash', undefined],
    ];
    for (const [tool, expected] of TOOLS) {
        it(`${tool} → ${expected ?? 'not high risk'}`, () => {
            expect(highRiskOfTool(tool)?.action).toBe(expected);
        });
    }
});
