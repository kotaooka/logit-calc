# 開発者向け情報（logit-calc）

利用者向けの説明は [README.md](README.md) にあります。

## ファイル構成

```
index.html             画面（スタイルを含む）。解説は docs/explanation.md から埋め込む
js/logit.js            ロジスティック回帰の計算（最尤法・Firth 法・検定・適合度・予測・逆算）。Node でも読み込み可
js/stats.js            分布関数（cpk-calc・msa-calc と同じファイル）
js/table.js            入力表（キー操作・複数セルの貼り付け。msa-calc と同じファイル）
js/xlsx.js             .xlsx の読み書きと CSV の読み込み（cpk-calc と同じファイル）
js/charts.js           SVG のグラフと PNG 保存（cpk-calc と同じファイル）
js/app.js              画面処理
sw.js                  オフライン用のキャッシュ処理（Service Worker）
manifest.webmanifest   アプリとして追加するための設定
icons/                 アプリアイコン（tools/make_icons.py で作成）
docs/explanation.md    「解説」タブの原稿
docs/screenshots/      README 用のスクリーンショット（tools/screenshots.py で撮影）
tools/build.py         解説を index.html に埋め込む
tests/                 テスト（下記）
.github/workflows/     push 時の自動テスト
```

## 更新して公開するとき

- `index.html`・`js/`・`icons/` を変更したら、**`sw.js` 先頭の `VERSION` を必ず上げてから** push してください。上げないと、すでに使っている人の端末に古いファイルが残り続けます
- 解説を直すときは `docs/explanation.md` を編集し、`python tools/build.py`（`pip install markdown`）で index.html に埋め込んでください。埋め込み忘れは CI で検出します
- `js/stats.js`・`js/xlsx.js`・`js/charts.js`・`js/table.js` はほかのツールと共通です。直すときは両方に反映してください
- GitHub Pages は main ブランチのルートを公開しています

## テスト

```
node tests/test.js                 # 不一致があれば終了コード 1
python tests/make_reference.py     # 参照値 tests/reference.json を作り直す（numpy・scipy・pandas・statsmodels・scikit-learn）
```

- 参照値は js/logit.js と別の方法で計算しています（README の「計算の検証」）
- テストが計算の誤りを検出できることは、式を一部変えて失敗することで確かめています（Firth 法の修正スコア、罰則の尺度の補正、Hosmer-Lemeshow、AUC の同順位、信頼帯、元の尺度への変換）

## 実装のメモ

- **当てはめ**：切片以外の列を平均 0・標準偏差 1 にしてからニュートン法（歩幅の半減つき）で解き、β = T b、Cov = T C Tᵀ で元の尺度に戻します（Z = X T）
- **Firth 法**：修正スコア U* = Xᵀ(y − π + h(1/2 − π))（h はハット行列の対角）をニュートン法で 0 にします。U* は罰則つき対数尤度 l + ½ log|I| の勾配です。罰則の値は尺度に依存するので、元の尺度の値に直します：log|I_X| = log|I_Z| + 2 Σ log s
- **尤度比検定**：検定する係数を 0 に固定して当てはめ直します。Firth 法では罰則の情報行列を常に全列で計算します（Heinze & Schemper 2002 の罰則つき尤度比検定）
- **分離の判定**（自動のとき）：最尤法が収束しない、情報行列が特異になる、または標準化した係数の絶対値が 12 を超えて予測確率が 0・1 に張り付く
- **Hosmer-Lemeshow**：予測確率の小さい順（同じ値は行の順）に並べ、組 = floor(順位 × g / n)、g = min(10, floor(n/5))、自由度 g − 2
- **逆算**：その変数をデータの範囲の両側に範囲の幅だけ広げた区間を 600 分割し、符号が変わる区間を二分法で解きます。安全側は信頼帯の上限が目標になる値のうち、推定値から確率が下がる向きにある最も近い値
- **区分の水準**：文字コード順。基準の既定は先頭
- **入力の保存**：ブラウザの localStorage（キー `logit-calc-v1`）に表と設定を保存します
