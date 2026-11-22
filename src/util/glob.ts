/**
 * Minimal, dependency-free glob matcher for project-relative POSIX paths.
 *
 * Supported: `**` (any depth), `*`, `?`, `{a,b}` alternation. A trailing `/`
 * means "everything beneath". Dotfiles ARE matched (conservative for inputs).
 * Everything else is literal. No negation: use `ignore` for exclusion.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\/]/g, '\\$&');
    }
  }
  if (braceDepth !== 0) throw new Error(`unbalanced "{" in glob: ${pattern}`);
  const rx = new RegExp(`^${re}$`);
  cache.set(pattern, rx);
  return rx;
}

export function compileGlobs(patterns: string[]): (rel: string) => boolean {
  const rxs = patterns.map(globToRegExp);
  return (rel) => rxs.some((r) => r.test(rel));
}
