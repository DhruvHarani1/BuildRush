import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export async function tmpProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildrush-test-')));
  await writeFiles(dir, files);
  return dir;
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

export const rm = (dir: string) => fs.rm(dir, { recursive: true, force: true });

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
}

/** A small project with real subprocess tasks (no installs needed). */
export function fixtureFiles(extraConfig: Record<string, unknown> = {}): Record<string, string> {
  const config = {
    version: 1,
    project: { name: 'fixture' },
    concurrency: 4,
    tasks: {
      lint: { command: 'node scripts/lint.js', kind: 'check', inputs: ['src/**', 'scripts/lint.js'] },
      compile: { command: 'node scripts/compile.js', kind: 'build', inputs: ['src/**', 'scripts/compile.js'], outputs: ['dist/**'] },
      test: { command: 'node --test', kind: 'test', affected: true, dependsOn: ['compile'], inputs: ['src/**', 'test/**'] },
    },
    pipelines: { default: ['lint', 'compile', 'test'] },
    ...extraConfig,
  };
  return {
    'buildrush.json': JSON.stringify(config, null, 2),
    'src/a.js': "export const a = 1;\n",
    'src/b.js': "import { a } from './a.js';\nexport const b = a + 1;\n",
    'src/c.js': "export const c = 3;\n",
    'scripts/lint.js': "console.log('lint ok');\n",
    'scripts/compile.js': [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const parts = fs.readdirSync('src').sort().map((f) => fs.readFileSync(path.join('src', f), 'utf8'));",
      "fs.mkdirSync('dist', { recursive: true });",
      "fs.writeFileSync('dist/bundle.txt', parts.join('---\\n'));",
      "console.log('compiled', parts.length);",
    ].join('\n'),
    'package.json': '{"type":"module","name":"fixture"}',
    'test/a.test.js': "import test from 'node:test'; import assert from 'node:assert'; import { b } from '../src/b.js';\ntest('b', () => assert.equal(b, 2));\n",
    'test/c.test.js': "import test from 'node:test'; import assert from 'node:assert'; import { c } from '../src/c.js';\ntest('c', () => assert.equal(c, 3));\n",
  };
}
