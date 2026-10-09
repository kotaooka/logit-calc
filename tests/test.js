// js/logit.js の計算を tests/reference.json（statsmodels・scipy・scikit-learn で別に計算した値）と照合する
// 実行: node tests/test.js   （不一致があれば終了コード 1）
'use strict';
const path = require('path');
const fs = require('fs');
const Lg = require('../js/logit.js');
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'reference.json'), 'utf8'));

let fails = 0, checks = 0;
function close(name, got, want, rel = 1e-6, abs = 1e-9) {
  checks++;
  const ok = Number.isFinite(got) && Number.isFinite(want) && Math.abs(got - want) <= Math.max(abs, rel * Math.abs(want));
  if (!ok) { fails++; console.log(`✗ ${name}: ${got} ≠ ${want}`); }
}
function same(name, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.log(`✗ ${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); }
}
function throws(name, f) {
  checks++;
  try { f(); fails++; console.log(`✗ ${name}: 例外が出ない`); } catch (e) { /* 期待どおり */ }
}

// 参照データ（列名つき）を js/logit.js の入力の形にする
function toInput(c) {
  const names = Object.keys(c.columns), cols = names.map(n => c.columns[n]);
  const ix = n => names.indexOf(n);
  const spec = {
    names, y: ix(c.spec.y), event: c.spec.event,
    x: c.spec.x.map(t => ({ col: ix(t.col), type: t.type, sq: !!t.sq, ref: t.ref })),
    inter: (c.spec.inter || []).map(([a, b]) => [ix(a), ix(b)]),
  };
  const vals = v => Object.fromEntries(Object.entries(v).map(([k, x]) => [ix(k), typeof x === 'number' ? x : String(x)]));
  return { names, cols, spec, ix, vals };
}

for (const c of ref.cases) {
  const { cols, spec, ix, vals } = toInput(c);
  const R = Lg.analyze(cols, spec, { method: c.firth ? 'firth' : 'ml' });
  same(`${c.name} 項の並び`, R.terms.map(t => t.label), c.labels);
  // Firth 法は scipy の数値最適化と比べるので許容差を広げる
  const tol = c.firth ? 2e-5 : 1e-6;
  c.beta.forEach((b, j) => close(`${c.name} β${j}`, R.coef[j].beta, b, tol, 1e-7));
  c.bse.forEach((b, j) => close(`${c.name} 標準誤差${j}`, R.coef[j].se, b, c.firth ? 1e-4 : 1e-6));
  if (!c.firth) {
    c.pvalues.forEach((p, j) => close(`${c.name} p 値${j}`, R.coef[j].p, p, 1e-5, 1e-12));
    close(`${c.name} 対数尤度`, R.ll, c.llf, 1e-9);
    close(`${c.name} 帰無モデルの対数尤度`, R.llNull, c.llnull, 1e-9);
    close(`${c.name} AIC`, R.aic, c.aic, 1e-9);
    close(`${c.name} BIC`, R.bic, c.bic, 1e-9);
    close(`${c.name} McFadden R²`, R.mcfadden, c.prsquared, 1e-7);
    close(`${c.name} 全体の尤度比`, R.lrAll, c.llr, 1e-7);
    close(`${c.name} 全体の p 値`, R.pAll, c.llr_pvalue, 1e-5, 1e-14);
  } else {
    close(`${c.name} 罰則つき対数尤度`, R.crit, c.crit, 1e-7);
    if (c.lrAll) close(`${c.name} 全体の罰則つき尤度比`, R.lrAll, c.lrAll.lr, 1e-4, 1e-6);
  }
  for (const [name, w] of Object.entries(c.lr)) {
    const v = R.vars.find(q => q.col === ix(name));
    same(`${c.name} ${name} 自由度`, v.df, w.df);
    close(`${c.name} ${name} 尤度比`, v.lr, w.lr, c.firth ? 1e-4 : 1e-6, 1e-6);
    close(`${c.name} ${name} 尤度比の p 値`, v.p, w.p, c.firth ? 1e-3 : 1e-5, 1e-12);
  }
  close(`${c.name} AUC`, R.auc, c.auc, c.firth ? 1e-9 : 1e-12);
  close(`${c.name} HL 統計量`, R.hl.stat, c.hl.stat, c.firth ? 1e-3 : 1e-6);
  same(`${c.name} HL 自由度`, R.hl.df, c.hl.df);
  c.vif.forEach((v, j) => close(`${c.name} VIF${j + 1}`, R.vif[j], v, 1e-8));
  for (const pv of c.pred) {
    const r = R.predict(vals(pv.vals));
    const t2 = c.firth ? 1e-4 : 1e-7;
    close(`${c.name} 予測 ${JSON.stringify(pv.vals)}`, r.p, pv.p, t2);
    close(`${c.name} 予測の下限 ${JSON.stringify(pv.vals)}`, r.lo, pv.lo, t2);
    close(`${c.name} 予測の上限 ${JSON.stringify(pv.vals)}`, r.hi, pv.hi, t2);
  }
  for (const iv of c.inverse) {
    const r = R.inverse(ix(iv.col), iv.target, vals(iv.vals));
    const t2 = c.firth ? 1e-4 : 1e-7;
    close(`${c.name} 逆算 ${iv.col}`, r.est.find(x => Math.abs(x - iv.est) < 1) ?? NaN, iv.est, t2, 1e-7);
    close(`${c.name} 逆算（信頼帯の上限） ${iv.col}`, r.upper.find(x => Math.abs(x - iv.upper) < 1) ?? NaN, iv.upper, t2, 1e-7);
    if (iv.lower != null) close(`${c.name} 逆算（信頼帯の下限） ${iv.col}`, r.lower.find(x => Math.abs(x - iv.lower) < 1) ?? NaN, iv.lower, t2, 1e-7);
  }
}

// 自動選択：完全分離なら Firth 法に切り替える。分離していなければ最尤法
{
  const sep = ref.cases.find(c => c.name === '分離・Firth');
  const { cols, spec } = toInput(sep);
  const R = Lg.analyze(cols, spec, { method: 'auto' });
  same('分離の検出', [R.separation, R.method], [true, 'firth']);
  const ok = ref.cases.find(c => c.name === '3変数・区分あり');
  const t = toInput(ok);
  const R2 = Lg.analyze(t.cols, t.spec, { method: 'auto' });
  same('分離なし', [R2.separation, R2.method], [false, 'ml']);
}

// しきい値での集計と ROC の端
{
  const y = [1, 1, 0, 0, 1, 0], pr = [0.9, 0.6, 0.6, 0.2, 0.4, 0.1];
  same('混同行列', Lg.confusion(y, pr, 0.5), { tp: 2, fp: 1, tn: 2, fn: 1, sens: 2 / 3, spec: 2 / 3, acc: 4 / 6 });
  // AUC：組 (陽性, 陰性) 9 組のうち、陽性が大きい 7 組 + 同順位 1 組 × 1/2 = 7.5
  close('AUC（同順位あり）', Lg.rocCurve(y, pr).auc, 7.5 / 9, 1e-12);
}

// 値の読み取りと事象の推定
same('事象の推定 あり', Lg.guessEvent(['なし', 'あり']), 'あり');
same('事象の推定 0/1', Lg.guessEvent(['0', '1']), '1');
same('事象の推定 NG', Lg.guessEvent(['OK', 'NG']), 'NG');
same('値をそろえる', ['1', '1.0', ' 1 '].map(Lg.key), ['1', '1', '1']);
same('列の種類', [Lg.guessType(['1', '2.5', '']), Lg.guessType(['A', 'B', 'A', 'B']), Lg.guessType(['a1', 'a2', 'a3', 'a4', 'a5'])], ['num', 'cat', 'id']);

// 入力の不備
const base = { names: ['x', 'y'], y: 1, x: [{ col: 0, type: 'num' }] };
throws('結果が 1 種類', () => Lg.analyze([['1', '2', '3'], ['OK', 'OK', 'OK']], base));
throws('結果が 3 種類', () => Lg.analyze([['1', '2', '3'], ['A', 'B', 'C']], base));
throws('説明変数なし', () => Lg.analyze([['1', '2'], ['OK', 'NG']], { names: ['x', 'y'], y: 1, x: [] }));
throws('値が一定', () => Lg.analyze([['1', '1', '1', '1'], ['OK', 'NG', 'OK', 'NG']], base));
{
  // 空欄・数値でない行は除く
  const R = Lg.analyze([['1', '2', '', 'abc', '3', '4', '5', '6'], ['OK', 'NG', 'OK', 'NG', 'OK', 'NG', 'NG', 'OK']], base);
  same('除いた行', R.dropped, [2, 3]);
  same('使った行数', R.n, 6);
}

console.log(`${checks} 項目中 ${checks - fails} 項目一致`);
if (fails) process.exit(1);
