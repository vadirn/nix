// writing/levenshtein — edit-distance primitives for spell's revert check
// (has the LLM's rewrite of a block drifted too far from the source?) and
// name-lint's nearest-source-name search. Leaf module: imports nothing.

export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Bounded variant: exact distance when <= bound, else bound+1. Trims the common
// prefix/suffix, short-circuits on the length delta (a Levenshtein lower bound),
// and abandons the DP once a whole row exceeds the bound — so spell verify's hot
// case (a huge block returned nearly unchanged) costs O(len), and a wholesale
// rewrite exits after ~bound rows instead of filling the full len² table.
// Residual: a large block with edits scattered at both ends still pays the DP on
// the untrimmed middle.
export function levenshteinBounded(a: string, b: string, bound: number): number {
  if (a === b) return 0;
  let s = 0,
    ae = a.length,
    be = b.length;
  while (s < ae && s < be && a[s] === b[s]) s++;
  while (ae > s && be > s && a[ae - 1] === b[be - 1]) {
    ae--;
    be--;
  }
  const x = a.slice(s, ae),
    y = b.slice(s, be);
  if (Math.abs(x.length - y.length) > bound) return bound + 1;
  const m = x.length,
    n = y.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > bound) return bound + 1;
    prev = cur;
  }
  return Math.min(prev[n], bound + 1);
}
