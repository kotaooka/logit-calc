# 参照値 tests/reference.json を作る。js/logit.js とは別の方法で計算し、tests/test.js で照合する
#   最尤法：statsmodels の Logit（係数・標準誤差・p 値・対数尤度）、縮小モデルの当てはめ直しによる尤度比検定、
#           GLM の get_prediction（予測確率の信頼区間）、variance_inflation_factor（VIF）
#   Firth 法：罰則つき対数尤度を scipy.optimize で直接最大化（js/logit.js は修正スコアのニュートン法）
#   AUC：scikit-learn の roc_auc_score。Hosmer-Lemeshow：pandas で同じ組分けを独立に実装
# 実行: python tests/make_reference.py   （numpy・scipy・pandas・statsmodels・scikit-learn が必要）
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize, stats
import statsmodels.api as sm
from statsmodels.stats.outliers_influence import variance_inflation_factor
from sklearn.metrics import roc_auc_score

OUT = Path(__file__).with_name('reference.json')
rng = np.random.default_rng(20261010)
Z = stats.norm.ppf(0.975)


def build(df, spec):
    """js/logit.js の design() と同じ規則で計画行列を作る（列の順：切片、説明変数ごとに 主効果・2乗・ダミー、交互作用）"""
    cols, labels, varsof = [np.ones(len(df))], ['切片'], [[]]
    for t in spec['x']:
        c = df[t['col']]
        if t['type'] == 'num':
            cols.append(c.astype(float).values); labels.append(t['col']); varsof.append([t['col']])
            if t.get('sq'):
                cols.append(c.astype(float).values ** 2); labels.append(t['col'] + '²'); varsof.append([t['col']])
        else:
            levels = sorted(set(c.astype(str)))
            ref = t.get('ref', levels[0])
            for lv in [l for l in levels if l != ref]:
                cols.append((c.astype(str) == lv).astype(float).values); labels.append(f"{t['col']}＝{lv}"); varsof.append([t['col']])
    for a, b in spec.get('inter', []):
        cols.append(df[a].astype(float).values * df[b].astype(float).values); labels.append(f'{a}×{b}'); varsof.append([a, b])
    return np.column_stack(cols), labels, varsof


def firth_fit(X, y, free=None):
    """罰則つき対数尤度 l(β) + 0.5 log|XᵀWX| を最大化（free 以外の係数は 0 に固定）"""
    n, p = X.shape
    free = list(range(p)) if free is None else free
    m = X[:, 1:].mean(axis=0); s = X[:, 1:].std(axis=0, ddof=1)
    Zm = np.column_stack([np.ones(n), (X[:, 1:] - m) / s])
    T = np.eye(p); T[0, 1:] = -m / s; T[1:, 1:] = np.diag(1 / s)
    # 0 に固定するのは元の尺度の係数。Z の尺度では β = T b なので、b の自由度を β の拘束に合わせて解く
    fixed = [j for j in range(p) if j not in free]

    def unpack(theta):
        beta = np.zeros(p); beta[free] = theta
        return beta

    def negpen(theta):
        beta = unpack(theta)
        eta = X @ beta
        ll = np.sum(y * eta - np.logaddexp(0, eta))
        pr = 1 / (1 + np.exp(-eta)); w = pr * (1 - pr)
        I = (Zm * w[:, None]).T @ Zm
        sign, ld = np.linalg.slogdet(I)
        return -(ll + 0.5 * ld)

    # 初期値：最尤法に近い値から（罰則つき尤度は凹なので初期値に依らない）
    theta0 = np.zeros(len(free)); theta0[0] = math.log((y.mean()) / (1 - y.mean())) if 0 in free else 0
    best = None
    for meth in ['BFGS', 'Nelder-Mead']:
        r = optimize.minimize(negpen, theta0 if best is None else best.x, method=meth, options={'gtol': 1e-11, 'maxiter': 20000} if meth == 'BFGS' else {'xatol': 1e-12, 'fatol': 1e-14, 'maxiter': 200000})
        if best is None or r.fun < best.fun: best = r
    r = optimize.minimize(negpen, best.x, method='BFGS', options={'gtol': 1e-12, 'maxiter': 20000})
    beta = unpack(r.x)
    # 罰則は Z 尺度の情報行列で計算したので、元の尺度に直す：log|I_X| = log|I_Z| + 2Σlog s
    crit = -r.fun + float(np.sum(np.log(s)))
    eta = X @ beta; pr = 1 / (1 + np.exp(-eta)); w = pr * (1 - pr)
    I = (X * w[:, None]).T @ X
    return beta, crit, np.linalg.inv(I)


def hosmer(y, pr):
    n = len(y); g = min(10, n // 5)
    order = np.lexsort((np.arange(n), pr))
    grp = np.empty(n, dtype=int); grp[order] = (np.arange(n) * g) // n
    d = pd.DataFrame({'y': y, 'p': pr, 'g': grp}).groupby('g').agg(n=('y', 'size'), o=('y', 'sum'), e=('p', 'sum'))
    stat = float((((d.o - d.e) ** 2 / d.e) + (((d.n - d.o) - (d.n - d.e)) ** 2 / (d.n - d.e))).sum())
    return {'stat': stat, 'df': g - 2, 'p': float(stats.chi2.sf(stat, g - 2))}


def case(name, df, spec, firth=False, preds=(), inverse=()):
    X, labels, varsof = build(df, spec)
    y = (df[spec['y']].astype(str) == spec['event']).astype(float).values
    n, p = X.shape
    out = {'name': name, 'columns': {c: [str(v) for v in df[c]] for c in df.columns}, 'spec': spec, 'firth': firth, 'labels': labels}
    if not firth:
        res = sm.Logit(y, X).fit(disp=0, method='newton', maxiter=200, tol=1e-12)
        beta, cov, crit = res.params, res.cov_params(), res.llf
        out.update({'bse': list(res.bse), 'pvalues': list(res.pvalues), 'llf': res.llf, 'llnull': res.llnull, 'aic': res.aic, 'bic': res.bic,
                    'prsquared': res.prsquared, 'llr': res.llr, 'llr_pvalue': res.llr_pvalue})
        refit = lambda keep: sm.Logit(y, X[:, keep]).fit(disp=0, method='newton', maxiter=200, tol=1e-12).llf
    else:
        beta, crit, cov = firth_fit(X, y)
        out.update({'bse': list(np.sqrt(np.diag(cov))), 'crit': crit})
        refit = lambda keep: firth_fit(X, y, keep)[1]
    out['beta'] = list(beta)
    # 変数ごとの尤度比検定
    lr = {}
    for t in spec['x']:
        keep = [j for j in range(p) if t['col'] not in varsof[j]]
        stat = max(0.0, 2 * (crit - refit(keep)))
        df_ = p - len(keep)
        lr[t['col']] = {'lr': stat, 'df': df_, 'p': float(stats.chi2.sf(stat, df_))}
    out['lr'] = lr
    if firth:
        stat = 2 * (crit - refit([0])); out['lrAll'] = {'lr': stat, 'p': float(stats.chi2.sf(stat, p - 1))}
    eta = X @ beta; pr = 1 / (1 + np.exp(-eta))
    out['auc'] = float(roc_auc_score(y, pr))
    out['hl'] = hosmer(y, pr)
    out['vif'] = [float(variance_inflation_factor(X, j)) for j in range(1, p)] if p > 2 else [1.0]
    # 予測確率と信頼区間（GLM の get_prediction。Firth は同じ式 η ± z√(xᵀCx) を numpy で）
    pv = []
    for vals in preds:
        row = fix_dummies(df, spec, vals)
        if not firth:
            glm = sm.GLM(y, X, family=sm.families.Binomial()).fit(tol=1e-13)
            f = glm.get_prediction(row[None, :]).summary_frame(alpha=0.05)
            pv.append({'vals': vals, 'p': float(f['mean'].iloc[0]), 'lo': float(f['mean_ci_lower'].iloc[0]), 'hi': float(f['mean_ci_upper'].iloc[0])})
        else:
            e = float(row @ beta); se = float(np.sqrt(row @ cov @ row))
            sg = lambda v: 1 / (1 + math.exp(-v))
            pv.append({'vals': vals, 'p': sg(e), 'lo': sg(e - Z * se), 'hi': sg(e + Z * se)})
    out['pred'] = pv
    # 逆算：col を動かしたとき予測確率（と信頼帯の上限）が target になる値（brentq）
    inv = []
    for col, target, vals, lo, hi in inverse:
        def fn(x, which):
            v = dict(vals); v[col] = x
            row = fix_dummies(df, spec, v)
            e = float(row @ beta); se = float(np.sqrt(row @ cov @ row))
            q = {'p': e, 'hi': e + Z * se, 'lo': e - Z * se}[which]
            return 1 / (1 + math.exp(-q)) - target
        rec = {'col': col, 'target': target, 'vals': vals, 'est': optimize.brentq(fn, lo, hi, args=('p',), xtol=1e-13), 'upper': optimize.brentq(fn, lo, hi, args=('hi',), xtol=1e-13)}
        if fn(lo, 'lo') * fn(hi, 'lo') < 0: rec['lower'] = optimize.brentq(fn, lo, hi, args=('lo',), xtol=1e-13)
        inv.append(rec)
    out['inverse'] = inv
    return out


def fix_dummies(df, spec, vals):
    """予測用の 1 行：区分の水準はデータ全体の水準で作る（1 行だけでは水準が足りないため）"""
    cols = [1.0]
    for t in spec['x']:
        if t['type'] == 'num':
            cols.append(float(vals[t['col']]))
            if t.get('sq'): cols.append(float(vals[t['col']]) ** 2)
        else:
            levels = sorted(set(df[t['col']].astype(str)))
            ref = t.get('ref', levels[0])
            for lv in [l for l in levels if l != ref]: cols.append(1.0 if str(vals[t['col']]) == lv else 0.0)
    for a, b in spec.get('inter', []): cols.append(float(vals[a]) * float(vals[b]))
    return np.array(cols)


cases = []
# 1. 説明変数 1 つ
n = 80
x1 = np.round(rng.uniform(5, 30, n), 1)
ev = rng.random(n) < 1 / (1 + np.exp(-(-6 + 0.3 * x1)))
df = pd.DataFrame({'x1': x1, '結果': np.where(ev, 'あり', 'なし')})
cases.append(case('1変数', df, {'y': '結果', 'event': 'あり', 'x': [{'col': 'x1', 'type': 'num'}]},
                  preds=[{'x1': 10.0}, {'x1': 25.0}], inverse=[('x1', 0.05, {'x1': 0.0}, 0, 30)]))
# 2. 数値 2 つと区分 1 つ
n = 150
x2 = np.round(rng.uniform(0.4, 1.6, n), 2); x1 = np.round(rng.uniform(5, 30, n), 1); grp = rng.choice(['A', 'B', 'C'], n)
eta = -4 + 3.0 * (x2 - 1.0) + 0.15 * (x1 - 15) + np.where(grp == 'B', 0.8, np.where(grp == 'C', -0.5, 0)) + 2.5
ev = rng.random(n) < 1 / (1 + np.exp(-eta))
df = pd.DataFrame({'x2': x2, 'x1': x1, '群': grp, '結果': np.where(ev, '1', '0')})
spec = {'y': '結果', 'event': '1', 'x': [{'col': 'x2', 'type': 'num'}, {'col': 'x1', 'type': 'num'}, {'col': '群', 'type': 'cat'}]}
cases.append(case('3変数・区分あり', df, spec, preds=[{'x2': 1.2, 'x1': 20.0, '群': 'B'}, {'x2': 0.6, 'x1': 8.0, '群': 'C'}],
                  inverse=[('x1', 0.1, {'x2': 1.0, 'x1': 0.0, '群': 'A'}, -20, 60)]))
# 3. 2乗項と交互作用（x2が小さすぎても大きすぎてもありる）
n = 200
x2 = np.round(rng.uniform(0.2, 1.8, n), 2); x1 = np.round(rng.uniform(5, 30, n), 1)
eta = -2.5 + 6 * (x2 - 1.0) ** 2 + 0.08 * (x1 - 15) + 0.1 * (x2 - 1) * (x1 - 15)
ev = rng.random(n) < 1 / (1 + np.exp(-eta))
df = pd.DataFrame({'x2': x2, 'x1': x1, '結果': np.where(ev, 'あり', 'なし')})
spec = {'y': '結果', 'event': 'あり', 'x': [{'col': 'x2', 'type': 'num', 'sq': True}, {'col': 'x1', 'type': 'num'}], 'inter': [['x2', 'x1']]}
cases.append(case('2乗項・交互作用', df, spec, preds=[{'x2': 1.0, 'x1': 15.0}, {'x2': 1.7, 'x1': 28.0}]))
# 4. 完全分離（x1 18 N を超えると必ずありる）→ Firth 法
n = 40
x1 = np.round(rng.uniform(5, 30, n), 1); grp = rng.choice(['A', 'B'], n)
ev = x1 > 18  # 完全分離
df = pd.DataFrame({'x1': x1, '群': grp, '結果': np.where(ev, 'あり', 'なし')})
spec = {'y': '結果', 'event': 'あり', 'x': [{'col': 'x1', 'type': 'num'}, {'col': '群', 'type': 'cat'}]}
cases.append(case('分離・Firth', df, spec, firth=True, preds=[{'x1': 15.0, '群': 'A'}], inverse=[('x1', 0.5, {'x1': 0.0, '群': 'A'}, 5, 30)]))
# 5. 分離していないデータの Firth 法（最尤法に近いが少し 0 に寄る）
cases.append(case('Firth（分離なし）', pd.DataFrame(cases[1]['columns']), {'y': '結果', 'event': '1', 'x': [{'col': 'x2', 'type': 'num'}, {'col': 'x1', 'type': 'num'}, {'col': '群', 'type': 'cat'}]}, firth=True))

OUT.write_text(json.dumps({'cases': cases}, ensure_ascii=False, indent=1, default=float), encoding='utf-8')
print(f'{OUT} を書き出しました')
