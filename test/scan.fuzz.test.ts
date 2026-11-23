import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../src/graph.js';
import { forAll, Rng } from './prng.js';

const SPEC_CHARS = [...'abcdefghijklmnopqrstuvwxyz0123456789', '.', '/', '-', '_', '@', '~', ':'];
const IDENT = ['a', 'b', 'foo', 'Bar', '$x', '_y', 'z9'];

function genSpec(rng: Rng): string {
  const kind = rng.int(0, 3);
  const body = rng.string(SPEC_CHARS, 1, 12);
  if (kind === 0) return './' + body;
  if (kind === 1) return '../' + body;
  if (kind === 2) return '@' + rng.string(SPEC_CHARS, 1, 5) + '/' + body;
  return body;
}

type Gen = { src: string; spec: string; kind: 'import' | 'dynamic-import' | 'require' };

function genStatement(rng: Rng): Gen {
  const spec = genSpec(rng);
  const q = rng.pick(["'", '"']);
  const s = `${q}${spec}${q}`;
  const id = rng.pick(IDENT);
  const id2 = rng.pick(IDENT);
  const ws = () => rng.pick([' ', '  ', '\t', '\n', ' \n  ']);
  const semi = rng.pick(['', ';']);
  switch (rng.int(0, 13)) {
    case 0: return { src: `import${ws()}${id} from${ws()}${s}${semi}`, spec, kind: 'import' };
    case 1: return { src: `import {${ws()}${id}, ${id2} as q${ws()}} from ${s}${semi}`, spec, kind: 'import' };
    case 2: return { src: `import * as ${id} from ${s}${semi}`, spec, kind: 'import' };
    case 3: return { src: `import ${s}${semi}`, spec, kind: 'import' };
    case 4: return { src: `export * from ${s}${semi}`, spec, kind: 'import' };
    case 5: return { src: `export { ${id} } from ${s}${semi}`, spec, kind: 'import' };
    case 6: return { src: `import type { ${id} } from ${s}${semi}`, spec, kind: 'import' };
    case 7: return { src: `import ${id}, { ${id2} } from ${s}${semi}`, spec, kind: 'import' };
    case 8: return { src: `export * as ${id} from ${s}${semi}`, spec, kind: 'import' };
    case 9: return { src: `const ${id} = await import(${s})${semi}`, spec, kind: 'dynamic-import' };
    case 10: return { src: `import(${ws()}${s}${ws()})${semi}`, spec, kind: 'dynamic-import' };
    case 11: return { src: `const ${id} = require(${s})${semi}`, spec, kind: 'require' };
    case 12: return { src: `const { ${id} } = require( ${s} )${semi}`, spec, kind: 'require' };
    default: return { src: `import ${id} = require(${s})${semi}`, spec, kind: 'require' };
  }
}

const NOISE = [
  'const x = 1;',
  'function f(a, b) { return a + b; }',
  '// plain comment',
  'export const answer = 42;',
  'class A { m() { return 1; } }',
  "const s = 'not an import';",
  'if (x) { y(); } else { z(); }',
  '',
];

function has(found: { spec: string; kind: string }[], spec: string, kind: string): boolean {
  return found.some((f) => f.spec === spec && f.kind === kind);
}

test('scanner: finds every import in generated valid sources', () => {
  forAll('scan-valid', 100, 1000, (rng) => {
    const stmts: Gen[] = [];
    const lines: string[] = [];
    for (let i = rng.int(1, 12); i > 0; i--) {
      if (rng.bool(0.3)) lines.push(rng.pick(NOISE));
      const g = genStatement(rng);
      stmts.push(g);
      lines.push(g.src);
    }
    const src = lines.join('\n');
    const r = scanSource(src);
    for (const g of stmts) {
      assert.ok(has(r.specs, g.spec, g.kind), `missing ${g.kind} ${JSON.stringify(g.spec)} in:\n${src}\nfound=${JSON.stringify(r.specs)}`);
    }
    // all literal specifiers: nothing may be reported as uncertain
    assert.deepEqual(r.uncertain, [], `unexpected uncertainty for:\n${src}`);
  });
});

test('scanner: spec results are complete even with CRLF endings and no trailing newline', () => {
  forAll('scan-crlf', 200, 300, (rng) => {
    const gens = Array.from({ length: rng.int(1, 6) }, () => genStatement(rng));
    const src = gens.map((g) => g.src).join('\r\n');
    const r = scanSource(src);
    for (const g of gens) assert.ok(has(r.specs, g.spec, g.kind), `missing ${g.spec} in ${JSON.stringify(src)}`);
  });
});

test('scanner: finds minified forms without whitespace', () => {
  forAll('scan-minified', 250, 200, (rng) => {
    const spec = genSpec(rng);
    const id = rng.pick(IDENT);
    for (const src of [`import{${id}}from"${spec}"`, `import"${spec}"`, `export*from"${spec}"`, `export{${id}}from'${spec}'`, `import*as ${id} from"${spec}"`]) {
      assert.ok(has(scanSource(src).specs, spec, 'import'), `missed ${src}`);
    }
  });
});

test('scanner: non-literal dynamic loading is reported as uncertain', () => {
  forAll('scan-uncertain', 300, 200, (rng) => {
    const id = rng.pick(IDENT);
    const dyn = rng.pick([`import(${id})`, `import(\`./x/\${${id}}\`)`, `import( ${id} + '.js')`]);
    assert.ok(scanSource(`${rng.pick(NOISE)}\nawait ${dyn};`).uncertain.length > 0, dyn);
    assert.ok(scanSource(`const m = require(${id});`).uncertain.length > 0);
    assert.ok(scanSource(`import.meta.glob('./*.ts')`).uncertain.length > 0);
    assert.ok(scanSource(`require.context('./x', true)`).uncertain.length > 0);
  });
});

const GARBAGE = [
  'import', 'export', 'from', 'require', '(', ')', '{', '}', ',', ';', '=', '*', ' ', '\n', '\r\n', "'", '"', '`', '\\', '/', '//', '/*', '*/',
  'a', 'type', 'as', 'await', '.meta', '.glob', '.context', 'import.meta.glob(', 'require.context(', '\0', 'é', '\u{1F600}', '\uD800', ' ', '0',
];

test('scanner: never throws on random garbage and always returns well-formed output', () => {
  forAll('scan-garbage', 500, 3000, (rng) => {
    const src = rng.string(GARBAGE, 0, 60);
    let r;
    try {
      r = scanSource(src);
    } catch (e) {
      assert.fail(`scanSource threw on ${JSON.stringify(src)}: ${String(e)}`);
    }
    assert.ok(Array.isArray(r.specs) && Array.isArray(r.uncertain));
    for (const s of r.specs) {
      assert.equal(typeof s.spec, 'string');
      assert.ok(s.spec.length > 0 && !s.spec.includes('\n'), `bad spec ${JSON.stringify(s.spec)}`);
      assert.ok(['import', 'dynamic-import', 'require', 'package'].includes(s.kind));
      // over-approximation is allowed, but every spec must literally occur in the source
      assert.ok(src.includes(s.spec), `spec ${JSON.stringify(s.spec)} not present in ${JSON.stringify(src)}`);
    }
  });
});

test('scanner: never throws on random byte-ish strings', () => {
  forAll('scan-bytes', 900, 1000, (rng) => {
    let src = '';
    for (let i = rng.int(0, 400); i > 0; i--) src += String.fromCharCode(rng.int(0, 0xffff));
    scanSource(src);
  });
});

test('scanner: mutated valid sources (truncated / spliced) never throw', () => {
  forAll('scan-mutate', 1300, 1500, (rng) => {
    const src = Array.from({ length: rng.int(1, 8) }, () => genStatement(rng).src).join('\n');
    const cut = rng.int(0, src.length);
    scanSource(src.slice(0, cut));
    scanSource(src.slice(cut));
    const i = rng.int(0, src.length);
    scanSource(src.slice(0, i) + rng.string(GARBAGE, 1, 5) + src.slice(i));
  });
});

test('scanner: pathological inputs complete quickly (no catastrophic regex backtracking)', () => {
  const N = 20000;
  const cases: [string, string][] = [
    ['long import without specifier', 'import ' + 'a '.repeat(N)],
    ['repeated import keywords', 'import '.repeat(3000)],
    ['repeated import from', 'import a from '.repeat(3000)],
    ['repeated export', 'export '.repeat(3000)],
    ['unterminated string', "import x from '" + 'a'.repeat(N)],
    ['many open parens', 'import('.repeat(N)],
    ['many require', 'require('.repeat(N)],
    ['long whitespace after import', 'import' + ' '.repeat(N)],
    ['whitespace then junk', 'import' + ' '.repeat(N) + '!'],
    ['import braces unterminated', 'import {' + ' a,'.repeat(N)],
    ['long single line', 'x'.repeat(200000)],
  ];
  for (const [name, src] of cases) {
    const t = process.hrtime.bigint();
    scanSource(src);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 2000, `${name}: ${ms.toFixed(0)}ms`);
  }
});
