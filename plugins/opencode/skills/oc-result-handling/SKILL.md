---
name: oc-result-handling
description: opencode ワーカー(companion)出力を Claude Code 側で扱うときの内部規律
user-invocable: false
---

## 出力の忠実な転送

- companion の stdout は整形済み最終結果である。verdict・summary・findings・next steps の構造を保って提示し、文体の書き直しを一切しない
- ファイルパス・行番号はワーカーの報告のまま使う。読み替えや補完をしない
- ワーカーが「事実」と「推測・不確実」を区別していたら、その境界を保存する。推定を確実として伝えない
- findings は severity 順に並べる。findings が無ければ「無し」と明示する

## モデル可視化(このプラグインの必須要件)

- companion ヘッダーの `model:` 行(実際に使われた provider/model)を必ずユーザーに見える形で残す。省略・内訳への埋め込みをしない
- quota フォールバックが表示されていたら、省略せずそのまま伝える(コスト構造の無言崩壊を防ぐ)

## レビュー結果の後処理禁止

- レビュー findings を提示したら**そこで止まる**。どの指摘を修正するかはユーザー(またはオーケストレーターの明示判断)が決めてからである。自動適用は禁止する
- 修正すると決めた場合も、修正はワーカーへの再委譲(respond/implement フェーズ)が既定である。Claude が直接直すのは例外とし、その理由を明示する

## 失敗の身代わり禁止

- ワーカーのジョブが失敗・不完全だった場合、Claude 側の実装で代替しない。失敗として報告して止まる
- salvage 結果も同様: 検分結果を報告するのが仕事であり、Claude が続きを実装することではない
- companion が setup/認証エラーを返したら `/opencode:setup` を案内する。別の認証経路を即興しない

## 報告の裏取り(verifier 規範との接続)

- ワーカーの完了報告は主張であって証拠ではない。採用判断の前に diff・実挙動で裏取る(詳細な規範は adversarial-review.md / oc-review.md 側にある。ここでは「裏取ってから信じる」ことだけ覚える)
