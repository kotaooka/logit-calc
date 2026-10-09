// 2値ロジスティック回帰の計算。最尤法と Firth 法（罰則つき尤度、完全分離に対応）
// ブラウザでは window.LogitCalc、Node では require('./logit.js') で使う。分布関数は stats.js（CpkStats）を使う
(function (root) {
  'use strict';
  const S = typeof module !== 'undefined' && module.exports ? require('./stats.js') : root.CpkStats;
  const { gammaQ, normSf, normPpf } = S;
  const chi2Sf = (x, df) => (x <= 0 ? 1 : gammaQ(df / 2, x / 2));
  const sum = a => a.reduce((s, v) => s + v, 0);
  const sigmoid = e => (e >= 0 ? 1 / (1 + Math.exp(-e)) : Math.exp(e) / (1 + Math.exp(e)));
  const log1pexp = e => (e > 0 ? e + Math.log1p(Math.exp(-e)) : Math.log1p(Math.exp(e)));
  const logit = p => Math.log(p / (1 - p));

  // ---- 行列（小さい対称正定値行列） ----
  function chol(A) {
    const n = A.length, L = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (!(s > 1e-300)) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
    return L;
  }
  function cholSolve(L, b) {
    const n = L.length, y = new Float64Array(n), x = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
    return x;
  }
  function cholInv(L) {
    const n = L.length, inv = Array.from({ length: n }, () => new Float64Array(n));
    for (let j = 0; j < n; j++) { const e = new Float64Array(n); e[j] = 1; const c = cholSolve(L, e); for (let i = 0; i < n; i++) inv[i][j] = c[i]; }
    return inv;
  }
  const logdet = L => 2 * L.reduce((s, row, i) => s + Math.log(row[i]), 0);
  const sub = (A, idx) => idx.map(i => idx.map(j => A[i][j]));

  // ---- 当てはめ ----
  // X: n 行 p 列（1 列目は切片の 1）、y: 0/1。free: 推定する列（それ以外は 0 に固定。尤度比検定の縮小モデル）
  // Firth 法では罰則 0.5·log|I(β)| の I は常に全 p 列の情報行列（Heinze & Schemper 2002 の罰則つき尤度比検定と同じ）
  function fitCore(X, y, firth, free, maxIter = 200) {
    const n = X.length, p = X[0].length;
    free = free || Array.from({ length: p }, (_, j) => j);
    const b = new Float64Array(p);
    const ybar = sum(y) / n;
    b[0] = logit(Math.min(1 - 0.5 / n, Math.max(0.5 / n, ybar)));
    function evalAt(beta) {
      const eta = new Float64Array(n), pr = new Float64Array(n), w = new Float64Array(n);
      let ll = 0;
      for (let i = 0; i < n; i++) {
        let e = 0; const xi = X[i];
        for (let j = 0; j < p; j++) e += xi[j] * beta[j];
        eta[i] = e; pr[i] = sigmoid(e); w[i] = pr[i] * (1 - pr[i]);
        ll += y[i] * e - log1pexp(e);
      }
      const I = Array.from({ length: p }, () => new Float64Array(p));
      for (let i = 0; i < n; i++) { const xi = X[i], wi = w[i]; for (let a = 0; a < p; a++) { const v = wi * xi[a]; for (let c = 0; c <= a; c++) I[a][c] += v * xi[c]; } }
      for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) I[c][a] = I[a][c];
      const L = chol(I);
      const crit = firth ? (L ? ll + 0.5 * logdet(L) : -Infinity) : ll;
      return { eta, pr, w, I, L, ll, crit };
    }
    let cur = evalAt(b), iter = 0, converged = false, singular = false;
    for (; iter < maxIter; iter++) {
      if (!cur.L) { singular = true; break; }
      // 勾配（Firth 法では修正スコア U* = Xᵀ(y − π + h(1/2 − π))、h はハット行列の対角）
      const U = new Float64Array(p);
      let Iinv = null;
      if (firth) Iinv = cholInv(cur.L);
      for (let i = 0; i < n; i++) {
        const xi = X[i];
        let r = y[i] - cur.pr[i];
        if (firth) {
          let q = 0;
          for (let a = 0; a < p; a++) { let s = 0; for (let c = 0; c < p; c++) s += Iinv[a][c] * xi[c]; q += xi[a] * s; }
          r += cur.w[i] * q * (0.5 - cur.pr[i]);
        }
        for (let a = 0; a < p; a++) U[a] += xi[a] * r;
      }
      const Lf = chol(sub(cur.I, free));
      if (!Lf) { singular = true; break; }
      const stepF = cholSolve(Lf, free.map(j => U[j]));
      let step = new Float64Array(p);
      free.forEach((j, k) => { step[j] = Math.max(-5, Math.min(5, stepF[k])); });
      // 目的関数が下がるときは歩幅を半分にする
      let next, nb, half = 0;
      for (;;) {
        nb = b.map((v, j) => v + step[j]);
        next = evalAt(nb);
        if (next.crit >= cur.crit - 1e-12 || half >= 40) break;
        step = step.map(v => v / 2); half++;
      }
      const dmax = Math.max(...step.map(Math.abs));
      const dcrit = Math.abs(next.crit - cur.crit);
      b.set(nb); cur = next;
      if (dmax < 1e-10 || (dcrit < 1e-13 && dmax < 1e-6)) { converged = true; iter++; break; }
    }
    return { beta: Array.from(b), ll: cur.ll, crit: cur.crit, pr: Array.from(cur.pr), I: cur.I, L: cur.L, iter, converged, singular };
  }

  // ---- データの読み取り ----
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v == null) return null;
    const s = String(v).trim().replace(/,/g, '').replace(/[０-９．－＋]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/−/g, '-');
    return NUM_RE.test(s) ? Number(s) : null;
  }
  const blank = v => v == null || String(v).trim() === '';
  // 判定の値をそろえる（"1" と "1.0" を同じにする）
  const key = v => { const x = toNum(v); return x != null ? String(x) : String(v).trim(); };
  const EVENT_RE = /^(1|あり|有|有り|ng|n\.g\.|不良|不合格|否|×|✕|x|fail|failed|yes|y|true|発生|異常|陽性)$/i;
  // 列の種類を推定する：数値・区分・ID（全部違う文字列）
  function guessType(values) {
    const v = values.filter(x => !blank(x));
    if (!v.length) return 'empty';
    if (v.every(x => toNum(x) != null)) return 'num';
    const lv = new Set(v.map(key));
    if (lv.size <= Math.max(2, Math.min(20, v.length / 2))) return 'cat';
    return 'id';
  }
  function levelsOf(values) {
    const out = [];
    for (const v of values) if (!blank(v)) { const k = key(v); if (!out.includes(k)) out.push(k); }
    return out;
  }
  function guessEvent(levels) {
    return levels.find(l => EVENT_RE.test(l)) ?? (levels.length === 2 ? [...levels].sort()[1] : levels[0]);
  }

  // ---- 計画行列 ----
  // cols: 列ごとの値の配列。spec: { y, event, x: [{ col, type, sq, ref }], inter: [[colA, colB]], names }
  function design(cols, spec) {
    const names = spec.names || cols.map((_, i) => `列${i + 1}`);
    const xs = spec.x || [];
    if (spec.y == null) throw new Error('目的変数（2 種類の値を持つ結果の列）を選んでください');
    if (!xs.length) throw new Error('説明変数を 1 つ以上選んでください');
    const ylv = levelsOf(cols[spec.y]);
    if (ylv.length !== 2) throw new Error(`目的変数「${names[spec.y]}」の値が ${ylv.length} 種類です（2 種類である必要があります）`);
    const event = spec.event != null && ylv.includes(key(spec.event)) ? key(spec.event) : guessEvent(ylv);
    const nonEvent = ylv.find(l => l !== event);
    const used = [spec.y, ...xs.map(t => t.col)];
    const n0 = Math.max(...cols.map(c => c.length));
    const rows = [], dropped = [];
    for (let i = 0; i < n0; i++) {
      const allBlank = cols.every(c => blank(c[i]));
      if (allBlank) continue;
      const bad = used.some(c => blank(cols[c][i]) || (xs.find(t => t.col === c && t.type === 'num') && toNum(cols[c][i]) == null));
      if (bad) dropped.push(i); else rows.push(i);
    }
    // 区分の水準
    const cat = {};
    for (const t of xs) if (t.type === 'cat') {
      const lv = levelsOf(rows.map(i => cols[t.col][i])).sort(); // 水準は文字コード順（基準の既定は先頭）
      const ref = t.ref != null && lv.includes(key(t.ref)) ? key(t.ref) : lv[0];
      cat[t.col] = { levels: lv, ref, others: lv.filter(l => l !== ref) };
      if (lv.length < 2) throw new Error(`説明変数「${names[t.col]}」の水準が 1 種類だけです`);
    }
    // 列（項）の定義：{ label, vars: [変数の列番号], f: 値の取り出し(vals) }
    const terms = [{ label: '切片', vars: [], kind: 'intercept', f: () => 1 }];
    for (const t of xs) {
      if (t.type === 'num') {
        terms.push({ label: names[t.col], vars: [t.col], kind: 'main', col: t.col, f: v => v[t.col] });
        if (t.sq) terms.push({ label: `${names[t.col]}²`, vars: [t.col], kind: 'sq', col: t.col, f: v => v[t.col] * v[t.col] });
      } else {
        for (const l of cat[t.col].others) terms.push({ label: `${names[t.col]}＝${l}`, vars: [t.col], kind: 'dummy', col: t.col, level: l, f: v => (v[t.col] === l ? 1 : 0) });
      }
    }
    for (const [a, b] of spec.inter || []) {
      const ta = xs.find(t => t.col === a), tb = xs.find(t => t.col === b);
      if (!ta || !tb || ta.type !== 'num' || tb.type !== 'num' || a === b) continue;
      terms.push({ label: `${names[a]}×${names[b]}`, vars: [a, b], kind: 'inter', f: v => v[a] * v[b] });
    }
    const valsOf = i => { const v = {}; for (const t of xs) v[t.col] = t.type === 'num' ? toNum(cols[t.col][i]) : key(cols[t.col][i]); return v; };
    const X = rows.map(i => { const v = valsOf(i); return terms.map(tm => tm.f(v)); });
    const y = rows.map(i => (key(cols[spec.y][i]) === event ? 1 : 0));
    return { X, y, terms, rows, dropped, event, nonEvent, cat, xs, names, valsOf };
  }

  // ---- 解析 ----
  // opt: { method: 'auto'|'ml'|'firth', alpha }
  function analyze(cols, spec, opt = {}) {
    const D = design(cols, spec);
    const { X, y, terms } = D;
    const n = X.length, p = terms.length;
    const alpha = opt.alpha != null ? opt.alpha : 0.05;
    const z = normPpf(1 - alpha / 2);
    const events = sum(y);
    if (n < p + 1) throw new Error(`使えるデータが ${n} 行です。推定する係数（${p} 個）より多い行が必要です`);
    if (events === 0 || events === n) throw new Error(`「${D.event}」が ${events === 0 ? '1 件もありません' : 'すべての行です'}。両方の結果が必要です`);
    // 数値の安定のため、切片以外の列を平均 0・標準偏差 1 にしてから当てはめ、元の尺度に戻す
    const m = new Array(p).fill(0), s = new Array(p).fill(1);
    for (let j = 1; j < p; j++) {
      const col = X.map(r => r[j]); m[j] = sum(col) / n;
      s[j] = Math.sqrt(sum(col.map(v => (v - m[j]) ** 2)) / (n - 1));
      if (!(s[j] > 0)) throw new Error(`「${terms[j].label}」の値がすべて同じです（使える行で 1 種類だけ）`);
    }
    const Z = X.map(r => r.map((v, j) => (j === 0 ? 1 : (v - m[j]) / s[j])));
    const logDetT = -sum(s.slice(1).map(Math.log)); // log|det T|（Z = X T）
    const notes = [];
    let method = opt.method || 'auto', fit, separation = false;
    if (method !== 'firth') {
      fit = fitCore(Z, y, false);
      const big = fit.beta.slice(1).some(v => Math.abs(v) > 12);
      const extreme = fit.pr.filter(v => v < 1e-9 || v > 1 - 1e-9).length;
      separation = !fit.converged || fit.singular || (big && extreme > 0);
      if (separation && method === 'auto') { method = 'firth'; notes.push(['warn', 'データが完全（または準完全）に分離しているため、最尤法では係数が無限大に発散します。Firth 法（罰則つき最尤法）で計算しました']); }
      else if (separation) notes.push(['err', 'データが分離しているため、最尤法の係数・標準誤差は信頼できません。Firth 法を選んでください']);
      else method = 'ml';
    }
    if (method === 'firth') fit = fitCore(Z, y, true);
    const firth = method === 'firth';
    if (!fit.converged) notes.push(['warn', `計算が収束しませんでした（${fit.iter} 回）。結果は参考値です`]);
    if (!fit.L) throw new Error('情報行列が特異です。説明変数どうしが完全に相関していないか（同じ内容の列、区分の水準の組み合わせ）を確認してください');
    // 元の尺度へ：β = T b、Cov = T C Tᵀ
    const T = Array.from({ length: p }, (_, i) => new Float64Array(p));
    T[0][0] = 1;
    for (let j = 1; j < p; j++) { T[j][j] = 1 / s[j]; T[0][j] = -m[j] / s[j]; }
    const Cz = cholInv(fit.L);
    const beta = Array.from({ length: p }, (_, i) => sum(Array.from({ length: p }, (_, k) => T[i][k] * fit.beta[k])));
    const cov = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => {
      let v = 0; for (let a = 0; a < p; a++) { if (!T[i][a]) continue; for (let b = 0; b < p; b++) v += T[i][a] * Cz[a][b] * T[j][b]; } return v;
    }));
    // 元の尺度での目的関数（罰則つきなら log|I_X| = log|I_Z| − 2 log|det T|）
    const toX = c => (firth ? c - logDetT : c);
    const crit = toX(fit.crit);
    // 係数表
    const coef = terms.map((tm, j) => {
      const se = Math.sqrt(cov[j][j]), zz = beta[j] / se;
      const sx = j ? s[j] : null;
      return {
        label: tm.label, kind: tm.kind, vars: tm.vars, beta: beta[j], se, z: zz, p: 2 * normSf(Math.abs(zz)),
        ci: [beta[j] - z * se, beta[j] + z * se], or: Math.exp(beta[j]), orCI: [Math.exp(beta[j] - z * se), Math.exp(beta[j] + z * se)],
        sd: sx, std: j ? beta[j] * sx : null,
      };
    });
    // 尤度比検定（縮小モデルは係数を 0 に固定して当てはめ直す）
    const constrained = keep => toX(fitCore(Z, y, firth, keep).crit);
    const all = Array.from({ length: p }, (_, j) => j);
    const nullCrit = constrained([0]);
    const lrAll = 2 * (crit - nullCrit), dfAll = p - 1;
    const vars = D.xs.map(t => {
      const idx = terms.map((tm, j) => (tm.vars.includes(t.col) ? j : -1)).filter(j => j >= 0);
      const c = constrained(all.filter(j => !idx.includes(j)));
      const lr = Math.max(0, 2 * (crit - c));
      const main = terms.findIndex(tm => tm.kind === 'main' && tm.col === t.col);
      const values = D.rows.map(i => D.valsOf(i)[t.col]);
      const info = t.type === 'num'
        ? { min: Math.min(...values), max: Math.max(...values), mean: sum(values) / n, sd: Math.sqrt(sum(values.map(v => (v - sum(values) / n) ** 2)) / (n - 1)) }
        : { levels: D.cat[t.col].levels, ref: D.cat[t.col].ref, counts: D.cat[t.col].levels.map(l => { const r = values.map((v, i) => [v, y[i]]).filter(([v]) => v === l); return { level: l, n: r.length, events: sum(r.map(q => q[1])) }; }) };
      const pure = idx.length === 1 && main >= 0; // 2乗項・交互作用がないとき、オッズ比が一定
      return {
        col: t.col, name: D.names[t.col], type: t.type, idx, df: idx.length, lr, p: chi2Sf(lr, idx.length),
        orPerSD: pure ? Math.exp(beta[main] * info.sd) : null,
        orPerSDCI: pure ? [Math.exp((beta[main] - z * Math.sqrt(cov[main][main])) * info.sd), Math.exp((beta[main] + z * Math.sqrt(cov[main][main])) * info.sd)] : null,
        direction: pure ? Math.sign(beta[main]) : null, ...info,
      };
    });
    // 予測確率と適合度
    const eta = X.map(r => sum(r.map((v, j) => v * beta[j])));
    const pr = eta.map(sigmoid);
    const ll = sum(y.map((yi, i) => yi * eta[i] - log1pexp(eta[i])));
    const nullP = events / n, llNull = events * Math.log(nullP) + (n - events) * Math.log(1 - nullP);
    const deviance = -2 * ll, nullDeviance = -2 * llNull;
    const hl = hosmerLemeshow(y, pr);
    const roc = rocCurve(y, pr);
    const vif = vifOf(X);
    const epv = Math.min(events, n - events) / (p - 1);
    if (D.dropped.length) notes.push(['info', `空欄または数値でないセルがある ${D.dropped.length} 行を除きました（${D.dropped.slice(0, 8).map(i => i + 1).join('、')}${D.dropped.length > 8 ? ' ほか' : ''} 行目）`]);
    if (epv < 10) notes.push(['warn', `少ない方の結果（${Math.min(events, n - events)} 件）が、推定する係数 1 個あたり ${epv.toFixed(1)} 件です。10 件以上が目安で、少ないと係数が過大に出やすくなります${firth ? '' : '（Firth 法を使うと偏りを抑えられます）'}`]);
    vif.forEach((v, k) => { const tm = terms[k + 1]; if (v > 10 && tm.kind === 'main') notes.push(['warn', `「${tm.label}」の VIF が ${v.toFixed(1)} です。ほかの説明変数と強く相関しているため、係数の解釈に注意してください`]); });
    if (hl && hl.p < 0.05) notes.push(['warn', `Hosmer-Lemeshow 検定で当てはまりが悪い（p = ${hl.p.toFixed(3)}）。2乗項や交互作用、見落としている変数がないか確認してください`]);
    if (firth) notes.push(['info', 'Firth 法の p 値は罰則つき尤度比検定、係数の信頼区間は Wald の区間です']);
    // 予測：vals は { 列番号: 値 }
    const rowFor = vals => terms.map(tm => tm.f(vals));
    function predict(vals) {
      const x = rowFor(vals);
      const e = sum(x.map((v, j) => v * beta[j]));
      let q = 0; for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) q += x[a] * cov[a][b] * x[b];
      const h = z * Math.sqrt(Math.max(0, q));
      return { eta: e, p: sigmoid(e), lo: sigmoid(e - h), hi: sigmoid(e + h), se: Math.sqrt(Math.max(0, q)) };
    }
    // 逆算：col の値を動かし、ほかは vals に固定したとき、確率（または信頼帯の上限・下限）が target になる値
    function inverse(col, target, vals, range) {
      const v = vars.find(q => q.col === col);
      const span = v.max - v.min || Math.abs(v.mean) || 1;
      const [lo, hi] = range || [v.min - span, v.max + span];
      const f = (x, which) => { const r = predict(Object.assign({}, vals, { [col]: x })); return r[which] - target; };
      const roots = which => {
        const N = 600, out = [];
        let x0 = lo, f0 = f(x0, which);
        for (let k = 1; k <= N; k++) {
          const x1 = lo + (hi - lo) * k / N, f1 = f(x1, which);
          if (f0 === 0) out.push(x0);
          else if (f0 * f1 < 0) { let a = x0, b = x1, fa = f0; for (let it = 0; it < 80; it++) { const c = (a + b) / 2, fc = f(c, which); if (fa * fc <= 0) b = c; else { a = c; fa = fc; } } out.push((a + b) / 2); }
          x0 = x1; f0 = f1;
        }
        return out;
      };
      return { est: roots('p'), upper: roots('hi'), lower: roots('lo'), range: [lo, hi] };
    }
    return {
      method, firth, separation, n, events, nonEvents: n - events, event: D.event, nonEvent: D.nonEvent, p: p, terms, coef, vars,
      ll, crit, llNull, deviance, nullDeviance, lrAll, dfAll, pAll: chi2Sf(lrAll, dfAll), mcfadden: 1 - ll / llNull,
      aic: deviance + 2 * p, bic: deviance + p * Math.log(n), hl, roc, auc: roc.auc, vif, epv, iter: fit.iter, converged: fit.converged,
      beta, cov, alpha, z, pr, y, X, rows: D.rows, dropped: D.dropped, design: D, predict, inverse, notes,
    };
  }

  // Hosmer-Lemeshow：予測確率の小さい順に並べ、件数がほぼ等しい g 組に分ける（組 = floor(順位 × g / n)）
  function hosmerLemeshow(y, pr, g) {
    const n = y.length;
    g = g || Math.min(10, Math.floor(n / 5));
    if (g < 3) return null;
    const order = pr.map((v, i) => i).sort((a, b) => pr[a] - pr[b] || a - b);
    const grp = Array.from({ length: g }, () => ({ n: 0, o: 0, e: 0 }));
    order.forEach((i, r) => { const k = Math.floor(r * g / n); grp[k].n++; grp[k].o += y[i]; grp[k].e += pr[i]; });
    let stat = 0;
    for (const q of grp) {
      if (q.e > 0) stat += (q.o - q.e) ** 2 / q.e;
      const e0 = q.n - q.e; if (e0 > 0) stat += ((q.n - q.o) - e0) ** 2 / e0;
    }
    return { stat, df: g - 2, p: chi2Sf(stat, g - 2), groups: grp, g };
  }
  // ROC 曲線と AUC（同順位は 1/2 として数える）
  function rocCurve(y, pr) {
    const pos = [], neg = [];
    y.forEach((v, i) => (v ? pos : neg).push(pr[i]));
    let a = 0;
    const sn = [...neg].sort((x, z) => x - z);
    const lower = v => { let lo = 0, hi = sn.length; while (lo < hi) { const md = (lo + hi) >> 1; if (sn[md] < v) lo = md + 1; else hi = md; } return lo; };
    const upper = v => { let lo = 0, hi = sn.length; while (lo < hi) { const md = (lo + hi) >> 1; if (sn[md] <= v) lo = md + 1; else hi = md; } return lo; };
    for (const v of pos) { const l = lower(v), u = upper(v); a += l + (u - l) / 2; }
    const auc = a / (pos.length * neg.length);
    const th = [...new Set(pr)].sort((x, z) => z - x);
    const pts = [[0, 0]];
    for (const t of th) pts.push([neg.filter(v => v >= t).length / neg.length, pos.filter(v => v >= t).length / pos.length]);
    return { auc, points: pts };
  }
  // しきい値 t 以上を「事象あり」と予測したときの集計
  function confusion(y, pr, t) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    y.forEach((v, i) => { const hat = pr[i] >= t; if (v && hat) tp++; else if (v) fn++; else if (hat) fp++; else tn++; });
    return { tp, fp, tn, fn, sens: tp / (tp + fn), spec: tn / (tn + fp), acc: (tp + tn) / y.length };
  }
  // VIF：切片以外の列の相関行列の逆行列の対角
  function vifOf(X) {
    const p = X[0].length - 1;
    if (p < 2) return p === 1 ? [1] : [];
    const n = X.length;
    const cols = Array.from({ length: p }, (_, j) => X.map(r => r[j + 1]));
    const z = cols.map(c => { const mu = sum(c) / n, sd = Math.sqrt(sum(c.map(v => (v - mu) ** 2))); return c.map(v => (v - mu) / sd); });
    const R = z.map(a => z.map(b => sum(a.map((v, i) => v * b[i]))));
    const L = chol(R);
    if (!L) return new Array(p).fill(Infinity);
    const inv = cholInv(L);
    return inv.map((row, i) => row[i]);
  }

  const api = { fitCore, design, analyze, hosmerLemeshow, rocCurve, confusion, vifOf, guessType, levelsOf, guessEvent, toNum, key, sigmoid, logit, chi2Sf, EVENT_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogitCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
