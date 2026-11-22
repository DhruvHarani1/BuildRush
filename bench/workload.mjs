// Deterministic synthetic TypeScript app generator for benchmarks. No randomness: same input, same bytes.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PRESETS = {
  small: { modules: 60, tests: 12, assets: 0 },
  medium: { modules: 400, tests: 60, assets: 0 },
  assets: { modules: 150, tests: 20, assets: 600 }, // many generated assets / JSON modules
};

export function generate(dir, { modules, tests, assets }) {
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('package.json', JSON.stringify({
    name: 'bench-app', private: true, type: 'module', version: '0.0.0',
    devDependencies: { typescript: '^5.9.0', vite: '^6.0.0', vitest: '^3.0.0' },
  }, null, 2));
  w('tsconfig.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src', 'tests', 'vite.config.ts'],
  }, null, 2));
  w('vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({ build: { outDir: 'dist', minify: true } });\n");
  w('index.html', '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>\n');
  for (let i = 0; i < modules; i++) {
    const deps = [i - 1, i - 7].filter((d) => d >= 0);
    const imports = deps.map((d) => `import { f${d} } from './m${d}';`).join('\n');
    const body = deps.map((d) => `f${d}(x)`).concat(['x']).join(' + ');
    // Memoised per module so the call tree is linear (an un-memoised fan-out of 2 is exponential in depth).
    w(`src/lib/m${i}.ts`, `${imports}\nconst memo = new Map<number, number>();\nexport function f${i}(x: number): number {\n  const hit = memo.get(x);\n  if (hit !== undefined) return hit;\n  let acc = ${body};\n  for (let k = 0; k < ${(i % 5) + 1}; k++) acc = (acc * 31 + ${i}) % 1000003;\n  memo.set(x, acc);\n  return acc;\n}\n`);
  }
  const top = modules - 1;
  w('src/main.ts', `import { f${top} } from './lib/m${top}';\n${assets ? "import { assetCount } from './assets';\n" : ''}console.log(f${top}(1)${assets ? ' + assetCount' : ''});\n`);
  if (assets) {
    for (let a = 0; a < assets; a++) w(`src/assets/a${a}.json`, JSON.stringify({ id: a, name: `asset-${a}`, tags: ['x', 'y', String(a % 7)] }));
    w('src/assets/index.ts', Array.from({ length: assets }, (_, a) => `import a${a} from './a${a}.json';`).join('\n') + `\nexport const assetCount = [${Array.from({ length: assets }, (_, a) => `a${a}`).join(',')}].length;\n`);
  }
  // Test k covers module round(k * (modules-1)/(tests-1)): the first covers m0 (wide), the last covers the top (narrow).
  for (let k = 0; k < tests; k++) {
    const m = tests === 1 ? 0 : Math.round((k * (modules - 1)) / (tests - 1));
    w(`tests/t${k}.test.ts`, `import { describe, expect, it } from 'vitest';\nimport { f${m} } from '../src/lib/m${m}';\ndescribe('m${m}', () => {\n  it('is deterministic', () => {\n    expect(f${m}(3)).toBe(f${m}(3));\n    expect(typeof f${m}(5)).toBe('number');\n  });\n});\n`);
  }
  w('buildrush.json', JSON.stringify({
    version: 1, project: { name: 'bench-app' },
    tasks: { typecheck: { adapter: 'tsc' }, build: { adapter: 'vite', dependsOn: ['typecheck'] }, test: { adapter: 'vitest', affected: true } },
    pipelines: { default: ['typecheck', 'build', 'test'] },
  }, null, 2));
  w('.gitignore', 'node_modules/\ndist/\n.buildrush/\n');
  return { narrowModule: `src/lib/m${top}.ts`, wideModule: 'src/lib/m0.ts' };
}
