// 画面処理：データ入力、変数の設定、ロジスティック回帰の結果・グラフ・予測と逆算、保存・印刷
(function () {
  'use strict';
  const Lg = window.LogitCalc, X = window.CpkXlsx, C = window.CpkCharts, T = window.MsaTable;
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const num = Lg.toNum;

  // ---------- 共通 ----------
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 2800);
  }
  const sig = (v, n = 4) => v == null || !Number.isFinite(v) ? '―' : (Math.abs(v) < 1e-12 ? '0' : String(Number(v.toPrecision(n))));
  const fix = (v, d = 2) => v == null || !Number.isFinite(v) ? '―' : v.toFixed(d);
  const pct = (v, d = 1) => v == null || !Number.isFinite(v) ? '―' : (100 * v < 0.1 && v > 0 ? (100 * v).toPrecision(2) : (100 * v).toFixed(d)) + '%';
  const pval = p => p == null || !Number.isFinite(p) ? '―' : p < 0.0001 ? '< 0.0001' : p.toFixed(4);
  const orFmt = v => v == null || !Number.isFinite(v) ? '―' : v > 1e4 || v < 1e-4 ? v.toExponential(2) : sig(v, 3);
  function download(data, name, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const stamp = () => { const d = new Date(), p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('shift_jis').decode(buf); }
  }
  const debounce = (f, ms = 300) => { let h; return () => { clearTimeout(h); h = setTimeout(f, ms); }; };
  const SER = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', '#c0398b', '#8a7a00', '#2a9bb0', '#7c5a3a'];

  // ---------- 状態と保存 ----------
  const KEY = 'logit-calc-v1';
  const newCol = (name, vals = []) => ({ name, vals, role: 'auto', type: 'auto', sq: false, ref: '' });
  function defaults() {
    return { cols: [newCol('結果'), newCol('説明変数1'), newCol('説明変数2')], nRows: 30, event: '', inter: [], method: 'auto', alpha: 0.05, threshold: 0.5, target: 1, goal: 'below', pred: {}, map: [], tab: 'main' };
  }
  let st = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && Array.isArray(s.cols) && s.cols.length) st = Object.assign(defaults(), s);
  } catch (e) { /* 保存できない環境・壊れた保存データは既定値で始める */ }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(st)); $('#saved').textContent = 'この端末に保存しました'; } catch (e) { /* 無視 */ } }, 400);
  }

  // ---------- 列の種類と使い方 ----------
  const guess = c => Lg.guessType(c.vals.slice(0, st.nRows));
  const typeOf = c => c.type !== 'auto' ? c.type : (guess(c) === 'num' ? 'num' : 'cat');
  function roleOf(i) {
    const c = st.cols[i];
    if (c.role !== 'auto') return c.role;
    // 自動：2 種類の値を持つ最初の列（名前が結果らしい列を優先）を目的変数、数値と区分の列を説明変数にする
    if (autoY() === i) return 'y';
    const g = guess(c);
    if (isIdCol(c)) return 'none';
    return g === 'num' || g === 'cat' ? 'x' : 'none';
  }
  // 通し番号の列（名前が No・ID など、または 1, 2, 3, … と 1 ずつ増える整数）は自動では使わない
  function isIdCol(c) {
    if (/^(no\.?|番号|通し番号|id|#|試料no\.?|サンプルno\.?|sample\s*no\.?)$/i.test(c.name.trim())) return true;
    const v = c.vals.slice(0, st.nRows).filter(x => String(x).trim() !== '').map(num);
    return v.length > 2 && v.every((x, i) => x != null && i > 0 ? x === v[i - 1] + 1 : Number.isInteger(x));
  }
  function autoY() {
    if (st.cols.some(c => c.role === 'y')) return st.cols.findIndex(c => c.role === 'y');
    const bin = st.cols.map((c, i) => [c, i]).filter(([c]) => c.role === 'auto' && Lg.levelsOf(c.vals.slice(0, st.nRows)).length === 2);
    const named = bin.find(([c]) => /結果|判定|合否|状態|不良|有無|発生|ok|ng|result|outcome/i.test(c.name));
    const text = bin.find(([c]) => guess(c) !== 'num');
    return (named || text || bin[0] || [null, -1])[1];
  }

  // ---------- テーマ ----------
  const charts = [];
  function mount(id, render) {
    const el = document.getElementById(id); if (!el) return;
    const draw = () => { const btn = el.querySelector('.save'); el.innerHTML = render(); if (btn) el.appendChild(btn); };
    draw(); charts.push({ el, render: draw });
  }
  function redrawCharts() { for (let i = charts.length - 1; i >= 0; i--) { if (!document.body.contains(charts[i].el)) charts.splice(i, 1); else charts[i].render(); } }
  const chartHtml = (id, name, wide) => `<div class="chart${wide ? ' wide' : ''}" id="${id}"><button class="btn small save no-print" type="button" data-png="${id}" data-name="${esc(name)}">画像を保存</button></div>`;
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-png]'); if (!b) return;
    const svg = document.getElementById(b.dataset.png).querySelector('svg');
    if (svg) C.svgToPng(svg, `${stamp()}_${b.dataset.name}.png`);
  });
  const THEMES = ['auto', 'light', 'dark'], THEME_LABEL = { auto: '表示：自動', light: '表示：ライト', dark: '表示：ダーク' };
  let theme = 'auto';
  try { theme = localStorage.getItem('logit-calc-theme') || 'auto'; } catch (e) { /* 無視 */ }
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
    $('#themeBtn').textContent = THEME_LABEL[t]; redrawCharts();
  }
  $('#themeBtn').addEventListener('click', () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; try { localStorage.setItem('logit-calc-theme', theme); } catch (e) { /* 無視 */ } applyTheme(theme); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (theme === 'auto') redrawCharts(); });
  // タブ
  function showTab(tab) {
    if (tab !== 'main' && tab !== 'explain') tab = 'main';
    $$('nav.tabs button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === tab)));
    $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    st.tab = tab; redrawCharts();
  }
  $$('nav.tabs button').forEach(b => b.addEventListener('click', () => { showTab(b.dataset.tab); save(); window.scrollTo({ top: 0 }); }));

  // ---------- データの表 ----------
  function fixShape() {
    st.nRows = Math.max(10, Math.min(5000, st.nRows | 0));
    for (const c of st.cols) { while (c.vals.length < st.nRows) c.vals.push(''); }
  }
  fixShape();
  const grid = T.create($('#grid'), {
    kind: 'text', autoRows: true,
    rows: () => st.nRows, cols: () => st.cols.length,
    get: (r, c) => st.cols[c].vals[r], set: (r, c, v) => { st.cols[c].vals[r] = v; },
    rowHead: r => String(r + 1),
    colHead: c => `<input class="colname" data-col="${c}" value="${esc(st.cols[c].name)}" aria-label="列${c + 1}の名前"><button class="gdel" type="button" data-del="${c}" title="この列を削除" aria-label="列を削除">×</button>`,
    colClass: c => 'role-' + roleOf(c),
    grow: (rows, cols) => {
      st.nRows = Math.min(5000, Math.max(st.nRows, rows));
      while (st.cols.length < Math.min(40, cols)) st.cols.push(newCol(`列${st.cols.length + 1}`));
      fixShape();
    },
    onPaste: (block, r0, c0) => {
      // 左上に見出しつきの表を貼り付けたら、表全体を置き換える
      const head = block[0].map(v => v.trim());
      const isHead = r0 === 0 && c0 === 0 && block.length > 1 && head.some(v => v !== '' && num(v) == null) && block.slice(1).some(row => row.some(v => num(v) != null));
      if (!isHead) return false;
      try { loadRows(block); toast(`${block.length - 1} 行 × ${head.length} 列を読み取りました`); } catch (e) { toast('読み取れませんでした：' + e.message); }
      return true;
    },
    onChange: () => changed(),
  });
  $('#grid').addEventListener('input', e => {
    const el = e.target.closest('.colname'); if (!el) return;
    st.cols[+el.dataset.col].name = el.value; renderVars(); changed();
  });
  $('#grid').addEventListener('click', e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const i = +b.dataset.del;
    if (st.cols.length <= 2) { toast('列は 2 列以上必要です'); return; }
    if (st.cols[i].vals.some(v => String(v).trim() !== '') && !confirm(`列「${st.cols[i].name}」を削除しますか？`)) return;
    st.cols.splice(i, 1);
    st.inter = st.inter.filter(([a, b2]) => a !== i && b2 !== i).map(([a, b2]) => [a > i ? a - 1 : a, b2 > i ? b2 - 1 : b2]);
    st.map = []; st.pred = {};
    refreshAll();
  });
  $('#addCol').addEventListener('click', () => { st.cols.push(newCol(`列${st.cols.length + 1}`)); fixShape(); refreshAll(); });
  // 表（1 行目が見出し）を読み込む
  function loadRows(rows) {
    rows = rows.map(r => (r || []).map(v => v == null ? '' : String(v).trim()));
    while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
    if (rows.length < 2) throw new Error('見出しの行とデータの行が必要です');
    const w = Math.max(...rows.map(r => r.length));
    const keep = [];
    for (let c = 0; c < w; c++) if (rows.some(r => (r[c] ?? '') !== '')) keep.push(c);
    st.cols = keep.map((c, k) => newCol(rows[0][c] || `列${k + 1}`, rows.slice(1).map(r => r[c] ?? '')));
    st.nRows = Math.max(10, rows.length - 1 + 5);
    st.event = ''; st.inter = []; st.pred = {}; st.map = [];
    fixShape(); refreshAll();
  }
  $('#fileIn').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const wb = /\.(csv|tsv|txt)$/i.test(f.name) ? X.readCsv(decodeText(buf)) : await X.readXlsx(buf);
      const sh = wb.sheets.find(s => s.cells.length);
      if (!sh) throw new Error('データのあるシートがありません');
      loadRows(sh.cells);
      toast(`${f.name} を読み込みました`);
    } catch (err) { toast('読み込めませんでした：' + err.message); console.error(err); }
    e.target.value = '';
  });
  $('#clearBtn').addEventListener('click', () => {
    if (!confirm('データと設定をすべて消去しますか？')) return;
    const keepTab = st.tab; st = defaults(); st.tab = keepTab; fixShape(); refreshAll();
  });

  // ---------- 変数の設定 ----------
  function renderVars() {
    const body = $('#varBody');
    body.innerHTML = st.cols.map((c, i) => {
      const role = roleOf(i), type = typeOf(c), g = guess(c);
      const vals = c.vals.slice(0, st.nRows).filter(v => String(v).trim() !== '');
      const lv = Lg.levelsOf(vals);
      let sum = `${vals.length} 件`;
      if (g === 'num') { const xs = vals.map(num); sum += `、${sig(Math.min(...xs))} 〜 ${sig(Math.max(...xs))}`; }
      else if (lv.length) sum += `、${lv.length} 種類（${lv.slice(0, 5).map(esc).join('・')}${lv.length > 5 ? '…' : ''}）`;
      const refSel = role === 'x' && type === 'cat' && lv.length ? `<select data-k="ref" data-i="${i}">${lv.map(l => `<option value="${esc(l)}"${(c.ref || lv[0]) === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` : '';
      return `<tr><td class="l"><b>${esc(c.name)}</b></td>
        <td class="l"><select data-k="role" data-i="${i}"><option value="y"${role === 'y' ? ' selected' : ''}>結果（目的変数）</option><option value="x"${role === 'x' ? ' selected' : ''}>説明変数</option><option value="none"${role === 'none' ? ' selected' : ''}>使わない</option></select></td>
        <td class="l">${role === 'y' ? '2値' : `<select data-k="type" data-i="${i}"><option value="num"${type === 'num' ? ' selected' : ''}${g !== 'num' ? ' disabled' : ''}>数値</option><option value="cat"${type === 'cat' ? ' selected' : ''}>区分</option></select>`}</td>
        <td class="l">${role === 'x' && type === 'num' ? `<label class="chk"><input type="checkbox" data-k="sq" data-i="${i}"${c.sq ? ' checked' : ''}>入れる</label>` : ''}</td>
        <td class="l">${refSel}</td><td class="sum">${sum}</td></tr>`;
    }).join('');
    // 起きた方の結果
    const yi = st.cols.findIndex((_, i) => roleOf(i) === 'y');
    const sel = $('#eventSel');
    if (yi >= 0) {
      const lv = Lg.levelsOf(st.cols[yi].vals.slice(0, st.nRows));
      const ev = lv.includes(st.event) ? st.event : Lg.guessEvent(lv);
      sel.innerHTML = lv.map(l => `<option value="${esc(l)}"${l === ev ? ' selected' : ''}>${esc(l)}</option>`).join('');
      sel.disabled = false;
    } else { sel.innerHTML = '<option>（結果の列を選んでください）</option>'; sel.disabled = true; }
    // 交互作用（数値の説明変数の組）
    const nums = st.cols.map((c, i) => i).filter(i => roleOf(i) === 'x' && typeOf(st.cols[i]) === 'num');
    st.inter = st.inter.filter(([a, b]) => nums.includes(a) && nums.includes(b));
    const pairs = [];
    for (let a = 0; a < nums.length; a++) for (let b = a + 1; b < nums.length; b++) pairs.push([nums[a], nums[b]]);
    $('#interBox').innerHTML = pairs.length ? `<div class="inline-opts"><span class="lbl">交互作用（一方の値によってもう一方の効き方が変わる）</span></div><div class="inter">${pairs.map(([a, b]) => `<label class="chk"><input type="checkbox" data-inter="${a},${b}"${st.inter.some(q => q[0] === a && q[1] === b) ? ' checked' : ''}>${esc(st.cols[a].name)} × ${esc(st.cols[b].name)}</label>`).join('')}</div>` : '';
    // 見出しの色（目的変数・説明変数）
    $$('#grid th.cl').forEach((th, c) => { th.className = `cl role-${roleOf(c)}`; });
  }
  $('#varBody').addEventListener('change', e => {
    const el = e.target, i = +el.dataset.i, k = el.dataset.k; if (!k) return;
    const c = st.cols[i];
    if (k === 'role') {
      if (el.value === 'y') st.cols.forEach((q, j) => { if (j !== i && roleOf(j) === 'y') q.role = 'x'; });
      // 自動のままの列は、今の判定で固定してから変える（ほかの列の自動判定が変わらないように）
      st.cols.forEach((q, j) => { if (j !== i && q.role === 'auto') q.role = roleOf(j); });
      c.role = el.value; st.event = '';
    } else if (k === 'type') c.type = el.value;
    else if (k === 'sq') c.sq = el.checked;
    else if (k === 'ref') c.ref = el.value;
    st.pred = {};
    renderVars(); changed();
  });
  $('#interBox').addEventListener('change', e => {
    const el = e.target; if (!el.dataset.inter) return;
    const [a, b] = el.dataset.inter.split(',').map(Number);
    st.inter = st.inter.filter(q => !(q[0] === a && q[1] === b));
    if (el.checked) st.inter.push([a, b]);
    changed();
  });
  $('#eventSel').addEventListener('change', e => { st.event = e.target.value; changed(); });
  const segSync = () => $$('#methodSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st.method)));
  $('#methodSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; st.method = b.dataset.v; segSync(); changed(); });
  segSync();
  $('#alphaIn').value = st.alpha;
  $('#alphaIn').addEventListener('input', e => { st.alpha = e.target.value; changed(); });

  // ---------- 計算 ----------
  let R = null;
  function spec() {
    const yi = st.cols.findIndex((_, i) => roleOf(i) === 'y');
    const x = st.cols.map((c, i) => i).filter(i => roleOf(i) === 'x').map(i => ({ col: i, type: typeOf(st.cols[i]), sq: !!st.cols[i].sq, ref: st.cols[i].ref || null }));
    return { names: st.cols.map(c => c.name), y: yi < 0 ? null : yi, event: st.event || null, x, inter: st.inter };
  }
  function compute() {
    const out = $('#out'), head = '<h2><span class="step">3</span>結果</h2>';
    const filled = st.cols.some(c => c.vals.some(v => String(v).trim() !== ''));
    if (!filled) { out.innerHTML = head + '<p class="empty">データを入力するか、「サンプルデータで試す」を押してください。</p>'; R = null; return; }
    const alpha = Math.min(0.5, Math.max(0.001, num(st.alpha) ?? 0.05));
    try {
      R = Lg.analyze(st.cols.map(c => c.vals.slice(0, st.nRows)), spec(), { method: st.method, alpha });
    } catch (e) { out.innerHTML = head + `<p class="err-msg">${esc(e.message)}</p>`; R = null; return; }
    render(out, head);
  }
  const changed = debounce(() => { save(); compute(); });

  // 予測に使う条件（数値は平均、区分は基準の水準）
  function predVals() {
    const v = {};
    for (const q of R.vars) {
      const s = st.pred[q.col];
      if (q.type === 'num') v[q.col] = num(s) ?? q.mean;
      else v[q.col] = q.levels.includes(s) ? s : q.ref;
    }
    return v;
  }
  const condText = (vals, except) => R.vars.filter(q => q.col !== except && !(Array.isArray(except) && except.includes(q.col))).map(q => `${q.name} ${q.type === 'num' ? sig(vals[q.col]) : vals[q.col]}`).join('、');

  function render(out, head) {
    const ev = R.event, conf = Math.round((1 - R.alpha) * 1000) / 10;
    const ranked = [...R.vars].sort((a, b) => b.lr - a.lr);
    const top = ranked[0];
    const sigAll = R.pAll < R.alpha;
    let h = head;
    h += `<div class="banner ${sigAll ? 'sig' : ''}"><span class="big">${sigAll ? `「${esc(ev)}」と関連のある変数がある` : `「${esc(ev)}」と有意な関連は見られない`}</span>`
      + `<span class="sub">モデル全体の尤度比検定 p ${pval(R.pAll)} ／ 最も効いている変数：${esc(top.name)}（p ${pval(top.p)}）／ AUC ${fix(R.auc, 3)} ／ ${R.n} 件中「${esc(ev)}」${R.events} 件 ／ ${R.firth ? 'Firth 法' : '最尤法'}</span></div>`;
    // 変数ごとの効き方
    h += `<h3 class="sec">変数ごとの効き方（影響の大きい順）</h3>` + tbl(['変数', '種類', '自由度', '尤度比 χ²', 'p 値', '1σ 増えたときのオッズ比', `${conf}% 信頼区間`, '向き'],
      ranked.map(v => [esc(v.name), v.type === 'num' ? '数値' : '区分', String(v.df), fix(v.lr, 2), { v: pval(v.p), cls: v.p < R.alpha ? 'sig' : '' },
        v.orPerSD != null ? orFmt(v.orPerSD) : '―', v.orPerSDCI ? `${orFmt(v.orPerSDCI[0])} 〜 ${orFmt(v.orPerSDCI[1])}` : '―',
        v.direction == null ? (v.type === 'cat' ? '水準ごとに下の表' : '2乗項・交互作用あり（図を参照）') : { v: v.direction > 0 ? `増えると「${esc(ev)}」が増える` : `増えると「${esc(ev)}」が減る`, cls: v.p < R.alpha ? (v.direction > 0 ? 'up' : 'down') : '' }]))
      + `<p class="hint">オッズ比は「${esc(ev)}」のオッズ（起きる確率 ÷ 起きない確率）が何倍になるか。1σ はその変数のデータの標準偏差で、単位の違う変数どうしを比べるための尺度です。</p>`;
    // 係数
    h += `<h3 class="sec">係数</h3>` + tbl(['項', '係数', '標準誤差', 'z', 'p 値', 'オッズ比（1 単位あたり）', `${conf}% 信頼区間`],
      R.coef.map(c => [esc(c.label), sig(c.beta, 5), sig(c.se, 4), fix(c.z, 3), { v: pval(c.p), cls: c.kind !== 'intercept' && c.p < R.alpha ? 'sig' : '' },
        c.kind === 'intercept' ? '' : orFmt(c.or), c.kind === 'intercept' ? '' : `${orFmt(c.orCI[0])} 〜 ${orFmt(c.orCI[1])}`]));
    const catVars = R.vars.filter(v => v.type === 'cat');
    for (const v of catVars) h += `<p class="hint">${esc(v.name)}：基準の水準は「${esc(v.ref)}」。${v.counts.map(c => `${esc(c.level)} ${c.events}/${c.n}`).join('、')}（「${esc(ev)}」の件数／件数）</p>`;
    // 当てはまり
    h += `<h3 class="sec">当てはまり</h3>` + kv([
      ['使ったデータ', `${R.n} 件`, R.dropped.length ? `除いた行 ${R.dropped.length}` : ''], [`「${ev}」`, `${R.events} 件`, `${pct(R.events / R.n)}`],
      ['係数 1 個あたりの件数', fix(R.epv, 1), '10 以上が目安'], ['推定方法', R.firth ? 'Firth 法' : '最尤法', `${R.iter} 回で${R.converged ? '収束' : '未収束'}`],
      ['尤度比 χ²（全体）', fix(R.lrAll, 2), `自由度 ${R.dfAll}、p ${pval(R.pAll)}`], ['McFadden R²', fix(R.mcfadden, 3)], ['逸脱度', sig(R.deviance, 5), `帰無モデル ${sig(R.nullDeviance, 5)}`],
      ['AIC', sig(R.aic, 5)], ['AUC', fix(R.auc, 3), R.auc >= 0.8 ? '判別力は高い' : R.auc >= 0.7 ? '判別力は中程度' : '判別力は低い'],
      ['Hosmer-Lemeshow', R.hl ? `p ${pval(R.hl.p)}` : '―', R.hl ? `χ² ${fix(R.hl.stat, 2)}、${R.hl.g} 組` : 'データが少ない'],
    ]);
    if (R.vif.length > 1) h += `<p class="hint">VIF（説明変数どうしの相関の強さ。10 を超えると係数が不安定）：${R.coef.slice(1).map((c, k) => `${esc(c.label)} ${fix(R.vif[k], 2)}`).join('、')}。2乗項・交互作用の列は元の変数と相関するので VIF が大きくなるのが普通です。</p>`;
    h += notes(R.notes);
    // 予測と逆算
    h += `<h3 class="sec">予測と逆算</h3><p class="hint">条件を入れると「${esc(ev)}」の確率を計算します。グラフもこの条件（動かす変数以外）で描きます。</p><div class="pred" id="predIn">`
      + R.vars.map(v => v.type === 'num'
        ? `<label class="field"><span class="lbl">${esc(v.name)}</span><input type="number" step="any" data-pred="${v.col}" value="${esc(st.pred[v.col] ?? sig(v.mean, 4))}"></label>`
        : `<label class="field"><span class="lbl">${esc(v.name)}</span><select data-pred="${v.col}">${v.levels.map(l => `<option value="${esc(l)}"${(st.pred[v.col] ?? v.ref) === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('')
      + `<label class="field"><span class="lbl">確率を</span><select id="goalSel"><option value="below"${st.goal !== 'above' ? ' selected' : ''}>目標以下にしたい</option><option value="above"${st.goal === 'above' ? ' selected' : ''}>目標以上にしたい</option></select></label>`
      + `<label class="field"><span class="lbl">目標の確率（%）</span><input type="number" step="any" min="0.001" max="99.999" id="targetIn" value="${esc(st.target)}"></label></div><div class="pred-out" id="predOut"></div>`;
    // 判別
    h += `<h3 class="sec">判別（しきい値で「${esc(ev)}」を予測したとき）</h3><div class="inline-opts"><label class="field"><span class="lbl">しきい値（%）</span><input type="number" step="any" min="0" max="100" id="thIn" value="${esc(100 * st.threshold)}"></label></div><div id="confOut"></div>`;
    // グラフ
    const numVars = R.vars.filter(v => v.type === 'num');
    h += `<h3 class="sec">グラフ</h3>`;
    if (numVars.length >= 2) {
      const [a, b] = mapVars();
      const opt = sel => numVars.map(v => `<option value="${v.col}"${v.col === sel ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
      h += `<div class="map-opts no-print"><span class="lbl">確率の地図</span>横軸 <select id="mapA">${opt(a)}</select> 縦軸 <select id="mapB">${opt(b)}</select></div>`;
    }
    h += `<div class="charts">${numVars.length >= 2 ? chartHtml('cMap', '確率の地図', true) + '<p class="hint wide-note" id="mapNote"></p>' : ''}${numVars.map(v => chartHtml(`cEff${v.col}`, `効果_${v.name}`)).join('')}${catVars.map(v => chartHtml(`cCat${v.col}`, `水準_${v.name}`)).join('')}${chartHtml('cForest', 'オッズ比')}${chartHtml('cRoc', 'ROC')}</div>`;
    h += `<div class="tools no-print"><button class="btn" type="button" id="printBtn">印刷・PDF</button><button class="btn" type="button" id="xlsxBtn">結果を Excel で保存</button></div>`;
    out.innerHTML = h;
    // 入力欄
    $$('#predIn [data-pred]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { st.pred[el.dataset.pred] = el.value; save(); predUpdate(); }));
    $('#targetIn').addEventListener('input', e => { st.target = e.target.value; save(); predUpdate(); });
    $('#goalSel').addEventListener('change', e => { st.goal = e.target.value; save(); predUpdate(); });
    $('#thIn').addEventListener('input', e => { const t = num(e.target.value); if (t != null) { st.threshold = Math.min(1, Math.max(0, t / 100)); save(); confUpdate(); } });
    if ($('#mapA')) ['#mapA', '#mapB'].forEach(id => $(id).addEventListener('change', () => { st.map = [+$('#mapA').value, +$('#mapB').value]; save(); redrawCharts(); }));
    $('#printBtn').addEventListener('click', () => { $('#printDate').textContent = new Date().toLocaleString('ja-JP'); window.print(); });
    $('#xlsxBtn').addEventListener('click', exportXlsx);
    predUpdate(); confUpdate();
    // グラフ
    if (numVars.length >= 2) mount('cMap', mapChart);
    numVars.forEach(v => mount(`cEff${v.col}`, () => effectChart(v)));
    catVars.forEach(v => mount(`cCat${v.col}`, () => catChart(v)));
    mount('cForest', forestChart);
    mount('cRoc', rocChart);
  }
  function mapVars() {
    const numVars = R.vars.filter(v => v.type === 'num');
    let [a, b] = st.map;
    if (!numVars.some(v => v.col === a) || !numVars.some(v => v.col === b) || a === b) {
      const r = [...numVars].sort((x, y) => y.lr - x.lr); a = r[0].col; b = r[1].col;
    }
    return [a, b];
  }
  const tbl = (head, rows) => `<div class="tbl-wrap"><table><thead><tr>${head.map((x, i) => `<th class="${i === 0 ? 'l' : ''}">${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => { const o = typeof c === 'object' && c !== null ? c : { v: c }; return `<td class="${i === 0 ? 'l' : 'num'} ${o.cls || ''}">${o.v}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  const kv = items => `<dl class="kv">${items.map(([k, v, s]) => `<div><dt>${esc(k)}</dt><dd class="num">${v}${s ? ` <small>${esc(s)}</small>` : ''}</dd></div>`).join('')}</dl>`;
  const notes = list => list.length ? `<ul class="log">${list.map(([k, s]) => `<li class="${k}">${esc(s)}</li>`).join('')}</ul>` : '';

  // 予測と逆算の表示
  function predUpdate() {
    if (!R) return;
    const vals = predVals(), r = R.predict(vals), ev = esc(R.event), conf = Math.round((1 - R.alpha) * 1000) / 10;
    const target = Math.min(0.99999, Math.max(0.00001, (num(st.target) ?? 1) / 100));
    let h = `<div class="card"><h4>この条件で「${ev}」の確率</h4><div class="big">${pct(r.p, 2)}</div><div class="hint">${conf}% 信頼区間 ${pct(r.lo, 2)} 〜 ${pct(r.hi, 2)}</div></div>`;
    for (const v of R.vars.filter(q => q.type === 'num')) {
      const iv = R.inverse(v.col, target, vals);
      const inRange = x => x >= v.min - (v.max - v.min) * 0.05 && x <= v.max + (v.max - v.min) * 0.05;
      let body;
      if (!iv.est.length) body = `この条件では、${esc(v.name)} をデータの範囲の外まで動かしても確率が ${pct(target, 2)} になりません。`;
      else {
        // 目標の側（以下にしたいなら確率が下がる向き、以上にしたいなら上がる向き）を求める
        const above = st.goal === 'above';
        const band = above ? iv.lower : iv.upper, bandName = above ? '下限' : '上限';
        const lines = iv.est.map(x0 => {
          const d = (v.max - v.min) * 1e-3 || 1e-6;
          const pr = R.predict(Object.assign({}, vals, { [v.col]: x0 + d })).p;
          const side = (above ? pr > target : pr < target) ? '以上' : '以下';
          // 確実な側：信頼帯の上限（以上にしたいときは下限）が目標になる値のうち、x0 から目標の側にある最も近い値
          const cand = band.filter(u => (side === '以上' ? u >= x0 - 1e-12 : u <= x0 + 1e-12));
          const u = cand.length ? (side === '以上' ? Math.min(...cand) : Math.max(...cand)) : null;
          return `<b>${sig(x0, 4)}</b> ${side}で ${pct(target, 2)} ${above ? '超' : '未満'}（推定）${u != null ? `、信頼帯の${bandName}で見ると <b>${sig(u, 4)}</b> ${side}（確実な側）` : `、信頼帯の${bandName}では範囲内に境目なし`}${inRange(x0) ? '' : '　※データの範囲外（外挿）'}`;
        });
        body = lines.join('<br>');
      }
      h += `<div class="card"><h4>「${ev}」が ${pct(target, 2)} になる ${esc(v.name)}</h4><div class="lim">${body}</div><div class="hint">ほかの条件：${esc(condText(vals, v.col)) || 'なし'}。データの範囲 ${sig(v.min)} 〜 ${sig(v.max)}</div></div>`;
    }
    $('#predOut').innerHTML = h;
    redrawCharts();
  }
  function confUpdate() {
    if (!R) return;
    const c = Lg.confusion(R.y, R.pr, st.threshold), ev = esc(R.event), ne = esc(R.nonEvent);
    $('#confOut').innerHTML = tbl(['', `予測：${ev}`, `予測：${ne}`, '正しく判別'], [
      [`実際：${ev}`, String(c.tp), String(c.fn), `感度 ${pct(c.sens)}`],
      [`実際：${ne}`, String(c.fp), String(c.tn), `特異度 ${pct(c.spec)}`],
    ]) + `<p class="hint">予測確率が ${pct(st.threshold)} 以上なら「${ev}」と予測。正解率 ${pct(c.acc)}。</p>`;
  }

  // ---------- グラフ ----------
  const W = 640, H = 380;
  function axes(s, x0, x1, y0, y1, L, Rm, Tp, B, xl, yl, yFmt, noX) {
    const X0 = v => L + (v - x0) / (x1 - x0) * (W - L - Rm), Y0 = v => H - B - (v - y0) / (y1 - y0) * (H - Tp - B);
    const tx = C.ticks(x0, x1, 7), ty = C.ticks(y0, y1, 5);
    const dg = st2 => { let d = 0; while (d < 8 && Math.abs(Math.round(st2 * 10 ** d) - st2 * 10 ** d) > 1e-6 * 10 ** d) d++; return d; };
    for (const v of ty.t) if (v >= y0 - 1e-9 && v <= y1 + 1e-9) s.push(`<line x1="${L}" x2="${W - Rm}" y1="${Y0(v)}" y2="${Y0(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${Y0(v) + 4}" font-size="11" text-anchor="end" fill="var(--muted)" font-family="var(--f-num)">${yFmt ? yFmt(v) : v.toFixed(dg(ty.step))}</text>`);
    if (!noX) for (const v of tx.t) if (v >= x0 - 1e-9 && v <= x1 + 1e-9) s.push(`<line x1="${X0(v)}" x2="${X0(v)}" y1="${Tp}" y2="${H - B}" stroke="var(--grid)"/><text x="${X0(v)}" y="${H - B + 16}" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="var(--f-num)">${v.toFixed(dg(tx.step))}</text>`);
    s.push(`<text x="${(L + W - Rm) / 2}" y="${H - 8}" font-size="12" text-anchor="middle" fill="var(--ink2)">${esc(xl)}</text>`);
    s.push(`<text transform="translate(14 ${(Tp + H - B) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="var(--ink2)">${esc(yl)}</text>`);
    return { X: X0, Y: Y0 };
  }
  const svgOpen = title => [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="var(--f-ui)" role="img" aria-label="${esc(title)}"><rect width="${W}" height="${H}" fill="var(--surface)"/><text x="58" y="20" font-size="14" font-weight="700" fill="var(--ink)">${esc(title)}</text>`];
  const legend = (s, items, row = 0) => {
    let x = W - 16;
    const y = 16 + row * 18;
    for (const [label, draw] of [...items].reverse()) { const w = 24 + [...label].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 11.5 : 6.5), 0) + 10; x -= w; s.push(draw(x + 8, y) + `<text x="${x + 20}" y="${y + 4}" font-size="11" fill="var(--ink2)">${esc(label)}</text>`); }
  };
  const markEvent = (x, y, r = 3.6) => `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}" stroke="var(--s4)" stroke-width="1.8"/>`;
  const markNon = (x, y, r = 3.2) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="var(--ink2)" stroke-width="1.3" stroke-opacity=".75"/>`;
  // 背景色と強調色を t : 1−t で混ぜた不透明な色（半透明のマスを並べると継ぎ目が濃く見えるため）
  function mix(t) {
    const css = getComputedStyle(document.documentElement);
    const rgb = name => { const h = css.getPropertyValue(name).trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const a = rgb('--surface'), b = rgb('--accent');
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  // 2つの数値変数の確率の地図（ほかの変数は予測の条件に固定）
  function mapChart() {
    const [a, b] = mapVars();
    const va = R.vars.find(v => v.col === a), vb = R.vars.find(v => v.col === b);
    const pad = (v, k) => (v.max - v.min) * k || 1;
    const x0 = va.min - pad(va, 0.05), x1 = va.max + pad(va, 0.05), y0 = vb.min - pad(vb, 0.05), y1 = vb.max + pad(vb, 0.05);
    const vals = predVals(), ev = R.event;
    const s = svgOpen(`「${ev}」の確率（${va.name} × ${vb.name}）`);
    const L = 62, Rm = 70, Tp = 46, B = 46;
    const ax = axes(s, x0, x1, y0, y1, L, Rm, Tp, B, va.name, vb.name);
    const N = 60, P = [];
    for (let j = 0; j <= N; j++) { P.push([]); for (let i = 0; i <= N; i++) P[j].push(R.predict(Object.assign({}, vals, { [a]: x0 + (x1 - x0) * i / N, [b]: y0 + (y1 - y0) * j / N })).p); }
    const cw = (W - L - Rm) / N, ch = (H - Tp - B) / N;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const p = (P[j][i] + P[j][i + 1] + P[j + 1][i] + P[j + 1][i + 1]) / 4;
      s.push(`<rect x="${(L + i * cw).toFixed(2)}" y="${(H - B - (j + 1) * ch).toFixed(2)}" width="${(cw + 0.6).toFixed(2)}" height="${(ch + 0.6).toFixed(2)}" fill="${mix(0.6 * p)}"/>`);
    }
    // 等確率線（マーチングスクエア）
    const target = Math.min(0.99999, Math.max(0.00001, (num(st.target) ?? 1) / 100));
    const levels = [...new Set([target, 0.1, 0.5, 0.9].map(v => Number(v.toPrecision(6))))].sort((p, q) => p - q);
    for (const lv of levels) {
      const seg = [];
      const gx = i => L + i * cw, gy = j => H - B - j * ch;
      const lerp = (p1, p2) => (lv - p1) / (p2 - p1);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const c = [P[j][i], P[j][i + 1], P[j + 1][i + 1], P[j + 1][i]];
        const pts = [];
        const e = [[0, 1, (t) => [gx(i + t), gy(j)]], [1, 2, (t) => [gx(i + 1), gy(j + t)]], [3, 2, (t) => [gx(i + t), gy(j + 1)]], [0, 3, (t) => [gx(i), gy(j + t)]]];
        for (const [u, v, f] of e) if ((c[u] - lv) * (c[v] - lv) < 0) pts.push(f(lerp(c[u], c[v])));
        if (pts.length >= 2) seg.push(`M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}L${pts[1][0].toFixed(1)} ${pts[1][1].toFixed(1)}`);
        if (pts.length === 4) seg.push(`M${pts[2][0].toFixed(1)} ${pts[2][1].toFixed(1)}L${pts[3][0].toFixed(1)} ${pts[3][1].toFixed(1)}`);
      }
      const isT = lv === Number(target.toPrecision(6));
      s.push(`<path d="${seg.join('')}" fill="none" stroke="${isT ? 'var(--ink)' : 'var(--ink2)'}" stroke-width="${isT ? 2.2 : 1}" ${isT ? '' : 'stroke-dasharray="4 3"'}/>`);
      // ラベル：線の右端付近
      let best = null;
      for (let j = 0; j <= N; j++) for (let i = N; i >= 0; i--) { if (i < N && (P[j][i] - lv) * (P[j][i + 1] - lv) <= 0) { if (!best || i > best[0]) best = [i, j]; break; } }
      if (best) s.push(`<text x="${(gx(best[0]) - 4).toFixed(1)}" y="${(gy(best[1]) - 4).toFixed(1)}" font-size="11" text-anchor="end" fill="var(--ink)" paint-order="stroke" stroke="var(--surface)" stroke-width="3">${pct(lv, 1)}</text>`);
    }
    // 実データ
    const iA = R.rows.map(i => R.design.valsOf(i));
    iA.forEach((v, k) => { const x = ax.X(v[a]), y = ax.Y(v[b]); s.push(R.y[k] ? markEvent(x, y) : markNon(x, y)); });
    s.push(`<rect x="${L}" y="${Tp}" width="${W - L - Rm}" height="${H - Tp - B}" fill="none" stroke="var(--line)"/>`);
    // 色の凡例
    const gy0 = Tp + 6, gh = H - Tp - B - 12;
    for (let k = 0; k < 20; k++) s.push(`<rect x="${W - Rm + 18}" y="${gy0 + gh * (1 - (k + 1) / 20)}" width="12" height="${gh / 20 + 0.5}" fill="${mix(0.6 * (k + 0.5) / 20)}"/>`);
    [0, 0.5, 1].forEach(t => s.push(`<text x="${W - Rm + 34}" y="${gy0 + gh * (1 - t) + 4}" font-size="10" fill="var(--muted)" font-family="var(--f-num)">${Math.round(t * 100)}%</text>`));
    legend(s, [[R.event, (x, y) => markEvent(x, y - 4)], [R.nonEvent, (x, y) => markNon(x, y - 4)], [`目標 ${pct(target, 2)}`, (x, y) => `<line x1="${x - 8}" x2="${x + 6}" y1="${y - 4}" y2="${y - 4}" stroke="var(--ink)" stroke-width="2.2"/>`]], 1);
    const others = condText(vals, [a, b]);
    const note = $('#mapNote'); if (note) note.textContent = others ? `ほかの条件は「予測と逆算」の値に固定：${others}` : '';
    return C.resolveVars(s.join('') + '</svg>');
  }
  // 1 変数の効果（確率の曲線と信頼帯、実データ、区間ごとの実績）
  function effectChart(v) {
    const vals = predVals(), ev = R.event;
    const pad = (v.max - v.min) * 0.04 || 1, x0 = v.min - pad, x1 = v.max + pad;
    const s = svgOpen(`${v.name} と「${ev}」の確率`);
    const L = 58, Rm = 16, Tp = 34, B = 46;
    const ax = axes(s, x0, x1, 0, 1, L, Rm, Tp, B, v.name, `「${ev}」の確率`, t => Math.round(t * 100) + '%');
    const N = 120, curve = [], lo = [], hi = [];
    for (let i = 0; i <= N; i++) { const x = x0 + (x1 - x0) * i / N, r = R.predict(Object.assign({}, vals, { [v.col]: x })); curve.push([ax.X(x), ax.Y(r.p)]); lo.push([ax.X(x), ax.Y(r.lo)]); hi.push([ax.X(x), ax.Y(r.hi)]); }
    const d = pts => pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');
    s.push(`<path d="${d(hi)}L${[...lo].reverse().map(q => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('L')}Z" fill="var(--s1)" fill-opacity=".14"/>`);
    s.push(`<path d="${d(curve)}" fill="none" stroke="var(--s1)" stroke-width="2.2"/>`);
    const target = Math.min(0.99999, Math.max(0.00001, (num(st.target) ?? 1) / 100));
    s.push(`<line x1="${L}" x2="${W - Rm}" y1="${ax.Y(target)}" y2="${ax.Y(target)}" stroke="var(--ink)" stroke-dasharray="5 4"/><text x="${W - Rm - 4}" y="${ax.Y(target) - 4}" font-size="11" text-anchor="end" fill="var(--ink)" paint-order="stroke" stroke="var(--surface)" stroke-width="3">目標 ${pct(target, 2)}</text>`);
    // 実データ（0% と 100% の位置に少しずらして）
    const xs = R.rows.map(i => R.design.valsOf(i)[v.col]);
    xs.forEach((x, k) => { const jit = ((k * 7919) % 13 - 6) * 0.9; s.push(R.y[k] ? markEvent(ax.X(x), ax.Y(1) + 8 + jit * 0.5, 3) : markNon(ax.X(x), ax.Y(0) - 8 - jit * 0.5, 2.6)); });
    // 区間ごとの実績（件数がほぼ等しい区間）
    const k = Math.max(3, Math.min(8, Math.floor(R.n / 12)));
    const ord = xs.map((x, i) => i).sort((p, q) => xs[p] - xs[q]);
    for (let g = 0; g < k; g++) {
      const part = ord.slice(Math.floor(g * R.n / k), Math.floor((g + 1) * R.n / k));
      if (!part.length) continue;
      const mx = part.reduce((a2, i) => a2 + xs[i], 0) / part.length, rate = part.reduce((a2, i) => a2 + R.y[i], 0) / part.length;
      s.push(`<rect x="${ax.X(mx) - 4}" y="${ax.Y(rate) - 4}" width="8" height="8" fill="var(--s2)" stroke="var(--surface)"/>`);
    }
    s.push(`<rect x="${L}" y="${Tp}" width="${W - L - Rm}" height="${H - Tp - B}" fill="none" stroke="var(--line)"/>`);
    legend(s, [['推定', (x, y) => `<line x1="${x - 8}" x2="${x + 6}" y1="${y - 4}" y2="${y - 4}" stroke="var(--s1)" stroke-width="2.5"/>`], ['区間の実績', (x, y) => `<rect x="${x - 4}" y="${y - 8}" width="8" height="8" fill="var(--s2)"/>`], [ev, (x, y) => markEvent(x, y - 4, 3)]]);
    return C.resolveVars(s.join('') + '</svg>');
  }
  // 区分の水準ごとの予測確率
  function catChart(v) {
    const vals = predVals(), ev = R.event;
    const s = svgOpen(`${v.name} の水準ごとの「${ev}」の確率`);
    const L = 58, Rm = 16, Tp = 34, B = 46, n = v.levels.length;
    const rs = v.levels.map(l => R.predict(Object.assign({}, vals, { [v.col]: l })));
    const obs = v.counts.map(c => c.events / c.n);
    const top = Math.min(1, Math.max(...rs.map(r => r.hi), ...obs) * 1.1 || 1);
    const ax = axes(s, 0.5, n + 0.5, 0, top, L, Rm, Tp, B, v.name, `「${ev}」の確率`, t => (t * 100).toFixed(top < 0.1 ? 1 : 0) + '%', true);
    s.push(`<rect x="${L}" y="${Tp}" width="${W - L - Rm}" height="${H - Tp - B}" fill="none" stroke="var(--line)"/>`);
    v.levels.forEach((l, i) => {
      const x = ax.X(i + 1), r = rs[i];
      s.push(`<line x1="${x}" x2="${x}" y1="${ax.Y(r.lo)}" y2="${ax.Y(r.hi)}" stroke="var(--s1)" stroke-width="2"/><circle cx="${x}" cy="${ax.Y(r.p)}" r="5" fill="var(--s1)"/>`);
      s.push(`<rect x="${x + 10}" y="${ax.Y(obs[i]) - 4}" width="8" height="8" fill="var(--s2)"/>`);
      s.push(`<text x="${x}" y="${H - B + 16}" font-size="12" text-anchor="middle" fill="var(--ink2)">${esc(l)}${l === v.ref ? '（基準）' : ''}</text>`);
    });
    legend(s, [['推定と信頼区間', (x, y) => `<circle cx="${x}" cy="${y - 4}" r="4" fill="var(--s1)"/>`], ['実績（ほかの条件を問わない割合）', (x, y) => `<rect x="${x - 4}" y="${y - 8}" width="8" height="8" fill="var(--s2)"/>`]]);
    return C.resolveVars(s.join('') + '</svg>');
  }
  // オッズ比（対数目盛り）
  function forestChart() {
    const items = [];
    for (const v of R.vars) if (v.orPerSD != null) items.push({ label: `${v.name}（+1σ = ${sig(v.sd, 3)}）`, or: v.orPerSD, ci: v.orPerSDCI, p: v.p });
    for (const c of R.coef) if (c.kind === 'dummy') items.push({ label: c.label + '（対 基準）', or: c.or, ci: c.orCI, p: c.p });
    const s = svgOpen('オッズ比と信頼区間（1 より右：起きる確率が上がる）');
    if (!items.length) return C.resolveVars(s.join('') + `<text x="${W / 2}" y="${H / 2}" font-size="13" text-anchor="middle" fill="var(--muted)">2乗項・交互作用のある変数はオッズ比が一定でないため表示しません</text></svg>`);
    const lg = v => Math.log10(Math.min(1e6, Math.max(1e-6, v)));
    let lo = Math.min(0, ...items.map(i => lg(i.ci[0]))), hi = Math.max(0, ...items.map(i => lg(i.ci[1])));
    lo = Math.floor(lo * 2) / 2 - 0.1; hi = Math.ceil(hi * 2) / 2 + 0.1;
    const L = 210, Rm = 20, Tp = 40, B = 40;
    const X0 = v => L + (lg(v) - lo) / (hi - lo) * (W - L - Rm);
    const rowH = Math.min(36, (H - Tp - B) / items.length);
    for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) for (const m of [1, 2, 5]) {
      const v = m * 10 ** e; if (lg(v) < lo || lg(v) > hi) continue;
      s.push(`<line x1="${X0(v)}" x2="${X0(v)}" y1="${Tp}" y2="${H - B}" stroke="var(--grid)"/><text x="${X0(v)}" y="${H - B + 16}" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="var(--f-num)">${v >= 1 ? v : v.toPrecision(1)}</text>`);
    }
    s.push(`<line x1="${X0(1)}" x2="${X0(1)}" y1="${Tp}" y2="${H - B}" stroke="var(--ink)" stroke-width="1.5"/>`);
    items.forEach((it, i) => {
      const y = Tp + rowH * (i + 0.5), col = it.p < R.alpha ? 'var(--accent)' : 'var(--muted)';
      s.push(`<text x="${L - 10}" y="${y + 4}" font-size="12" text-anchor="end" fill="var(--ink)">${esc(it.label)}</text>`);
      s.push(`<line x1="${X0(it.ci[0])}" x2="${X0(it.ci[1])}" y1="${y}" y2="${y}" stroke="${col}" stroke-width="2.5"/><rect x="${X0(it.or) - 5}" y="${y - 5}" width="10" height="10" fill="${col}"/>`);
    });
    s.push(`<text x="${(L + W - Rm) / 2}" y="${H - 8}" font-size="12" text-anchor="middle" fill="var(--ink2)">オッズ比（対数目盛り）</text>`);
    return C.resolveVars(s.join('') + '</svg>');
  }
  function rocChart() {
    return C.plot({
      title: `ROC 曲線（AUC ${fix(R.auc, 3)}）`, xLabel: '1 − 特異度（誤って予測した割合）', yLabel: '感度', x: [0, 1], y: [0, 1.02],
      layers: [{ type: 'line', data: [[0, 0], [1, 1]], color: 'var(--muted)', dash: '5 4', width: 1 }, { type: 'line', data: R.roc.points, color: 'var(--s1)', width: 2.2, label: 'ROC' }],
    });
  }

  // ---------- Excel 保存 ----------
  function exportXlsx() {
    if (!R) return;
    const coef = [['項', '係数', '標準誤差', 'z', 'p 値', 'オッズ比', 'オッズ比 下限', 'オッズ比 上限']].concat(R.coef.map(c => [c.label, c.beta, c.se, c.z, c.p, c.kind === 'intercept' ? null : c.or, c.kind === 'intercept' ? null : c.orCI[0], c.kind === 'intercept' ? null : c.orCI[1]]));
    const vars = [['変数', '自由度', '尤度比 χ²', 'p 値', '1σ あたりのオッズ比', '下限', '上限']].concat(R.vars.map(v => [v.name, v.df, v.lr, v.p, v.orPerSD, v.orPerSDCI ? v.orPerSDCI[0] : null, v.orPerSDCI ? v.orPerSDCI[1] : null]));
    const fitRows = [['項目', '値'], ['件数', R.n], [`「${R.event}」の件数`, R.events], ['推定方法', R.firth ? 'Firth 法' : '最尤法'], ['尤度比 χ²（全体）', R.lrAll], ['自由度', R.dfAll], ['p 値（全体）', R.pAll], ['McFadden R²', R.mcfadden], ['逸脱度', R.deviance], ['AIC', R.aic], ['AUC', R.auc], ['Hosmer-Lemeshow χ²', R.hl ? R.hl.stat : null], ['Hosmer-Lemeshow p 値', R.hl ? R.hl.p : null]];
    const names = st.cols.map(c => c.name);
    const data = [['行'].concat(names, ['予測確率'])].concat(R.rows.map((i, k) => [i + 1].concat(st.cols.map(c => { const x = num(c.vals[i]); return x != null ? x : c.vals[i]; }), [R.pr[k]])));
    download(X.writeXlsx([{ name: '変数ごと', rows: vars }, { name: '係数', rows: coef }, { name: '当てはまり', rows: fitRows }, { name: 'データと予測', rows: data }]), `${stamp()}_要因解析.xlsx`, XLSX_TYPE);
  }
  // 印刷は常にライト表示にする
  let themeBeforePrint = null;
  window.addEventListener('beforeprint', () => { themeBeforePrint = document.documentElement.getAttribute('data-theme'); document.documentElement.dataset.theme = 'light'; redrawCharts(); });
  window.addEventListener('afterprint', () => { if (themeBeforePrint == null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = themeBeforePrint; redrawCharts(); });

  // ---------- サンプル ----------
  // 種の発芽試験（架空のデータ）：温度・水やりの量・土の種類と、発芽したかどうか
  function sample() {
    let s0 = 20261010 >>> 0;
    const u = () => { s0 = (s0 * 1664525 + 1013904223) >>> 0; return (s0 + 0.5) / 4294967296; };
    const nrm = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    const rows = [['No', '温度(℃)', '水(mL/日)', '土', '結果']];
    for (let i = 0; i < 120; i++) {
      const temp = 10 + u() * 20, water = Math.max(2, 15 + nrm() * 5), soil = u() < 0.5 ? 'A' : 'B';
      const eta = -3.2 + 0.22 * (temp - 20) + 0.2 * (water - 15) + (soil === 'B' ? 1.0 : 0) + 1.2;
      const ok = u() < 1 / (1 + Math.exp(-eta));
      rows.push([String(i + 1), temp.toFixed(1), water.toFixed(1), soil, ok ? '発芽' : '未発芽']);
    }
    loadRows(rows);
    st.event = '発芽'; st.target = 50; st.goal = 'above'; save();
    renderVars();
    toast('サンプルデータを入れました');
    compute();
  }
  $('#sampleBtn').addEventListener('click', sample);

  // ---------- 開始 ----------
  function refreshAll() { grid.render(); renderVars(); save(); compute(); }
  applyTheme(theme);
  renderVars();
  compute();
  showTab(location.hash.slice(1) || st.tab);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
