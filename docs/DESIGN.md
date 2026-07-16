# opencode-plugin-cc 設計書

最終更新: 2026-07-16
ステータス: フェーズチェーンまで設計確定、実地検証済み(shiori#210 → shiori PR #274 を本設計のチェーンで出荷)

## 1. 目的と位置づけ

opencode (anomalyco/opencode) を Claude Code から委譲可能なワーカーとして使うためのプラグイン。
Claude Code がオーケストレーター(計画・検収・publish 判断)、opencode + deepseek がワーカー(調査・実装・レビューの実働)という分業を成立させる。

動機はコスト構造: deepseek v4 Flash は安価(zen の日次無料枠 deepseek-v4-flash-free もある)で、実感として Haiku より良い仕事をする。調査・一次実装を実質無料で回し、仕上げだけ Pro に少額を払う構造を作る。

手本: openai/codex-plugin-cc (Apache-2.0)。プロンプト資産(adversarial-review.md / review-output.schema.json)は NOTICE 帰属付きで移植。

## 2. アーキテクチャ

```
Claude Code (オーケストレーター)
  └─ /opencode:task 等のコマンド → 転送専用サブエージェント (agents/opencode-worker.md)
       └─ scripts/opencode-companion.mjs (防波堤)
            └─ opencode serve (HTTP API, 127.0.0.1 + OPENCODE_SERVER_PASSWORD, on-demand 起動)
                 └─ deepseek ワーカー
                      └─ MCP: sunaba / shiori (opencode 側の opencode.json に設定)
                           └─ sunaba コンテナ (sandbox_attach で既存コンテナに合流)
```

### 採用した案と棄却した案

- **HTTP サーバー案を採用**。`opencode run` 直叩きは不採用 — 中間テキストが全ターン stdout に、ツールログが stderr に流れ、Claude のコンテキストを汚染するため。
- **companion スクリプトが防波堤**: SSE `/event` 購読、permission.asked への自動応答、イベントは state dir(`~/.opencode-plugin-cc/<hash(cwd)>/jobs/`)に保存、stdout には整形済み最終結果のみ。
- **転送専用サブエージェント**: オーケストレーターの認知負荷削減が最優先要件。コマンドの仕事は companion の実行と stdout の verbatim 転送のみ。
- opencode API は v1 面(`/session/...`, `/event`, `/permission/:id/reply`)を使用。v1→v2 移行中のため SDK を使う場合は pin する。

### 実行環境の前提

- ローカルに git リポジトリを持たない開発スタイル。作業はすべて sunaba コンテナ内で行い、ワーカーには container_id を渡して `sandbox_attach` で合流させる。opencode 本体はホスト側に留まる。
- sunaba の設計テーゼ(sunaba#478)と整合: **セッションは使い捨て、状態は外部**(合意=イシュー/PR、成果=コンテナ、監査=ジャーナル)。

## 3. フェーズチェーン(本設計の中核)

長いセッションはコンテキスト汚染が始まるため、作業を5フェーズに分割し、**各フェーズ=新規 opencode セッション**とする。フェーズ跨ぎのセッション再利用は禁止(`--resume-last` / `--session` は同一フェーズ内の追い込み専用)。

### フェーズとツールマトリクス

| フェーズ | 役割 | shiori | コード書込 | issue_write |
|---|---|---|---|---|
| 起票 | 重複チェック(横並び)+イシュー作成 | ○ | ✕ | ○(成果物) |
| investigate | イシュー深掘り、原因特定 | ○ | ✕ | ○(brief 追記) |
| implement | brief に基づく実装+verify | ✕ | ○ | ✕ |
| review | PR の adversarial レビュー | ○ | ✕ | ○ |
| respond | レビュー指摘への対応 | ✕ | ○ | ✕ |

設計原理:

- **shiori は縦横で使い分ける**。イシューが特定箇所を指す「縦」の調査はコンテナ内 grep で足りる(実測: shiori#210 は shiori なしで完走)。shiori が効くのは「横」= 類似パターンの横並びチェック、重複イシュー確認、issue→PR→ファイルの跨ぎ。よってプロンプトでは手段を強制せず「横断調査には shiori がある」と選択肢を提示する。
- **implement / respond に shiori を渡さないのは意図的**。brief を信じて実装に集中させる構造的強制であり、同時に小型モデルのツール選択負荷とスキーマ分コンテキストの削減になる。
- ツールが多いとモデルは迷うだけ。フェーズごとに必要最小限を渡す。

### brief(フェーズ間の引き継ぎ)

**GitHub イシューへの追記(`sunaba_issue_write`)を媒体とする。** コピペしない。

- sunaba#478 の「合意はイシュー/PR に住む」と一致する
- shiori が索引するため、調査成果がそのまま恒久的な検索可能知識になる
- コンテナ内ファイルと違い、複数の開発環境(VM / 自宅機)を跨げる

### フェーズ=opencode agent 定義

フェーズは opencode.json の agent 定義として実装する。deny リスト+モデル既定+システムプロンプトを agent に束ね、companion の `--phase <name>` は `--agent` への写像にする。

注意(1.17.x 実測): セッション `tools` 設定も agent の permission も**実行時 deny ルールに変換されるだけ**で、モデルに送られるツール一覧からは除外されない(`session/tools.ts` の MCP ループは無条件)。つまり `--deny` は実行ガードであり、コンテキスト削減にはならない。真のフェーズ別ロードの実現ルートは:

1. 上流修正(deny ツールをリクエストから除外する提案 → issue #8 でトラッキング)
2. sunaba / shiori 側にプロファイル別 MCP エンドポイント(例: `/mcp/investigate` は read 系+issue_write のみ列挙)

どちらが実現しても agent 定義がそのまま受け皿になる。

### 失敗時リトライ

**checkpoint_restore + 同じ brief + 新セッション(またはモデル昇格)。**
失敗アプローチへのアンカリングを構造的に排除する。実測: Flash が泥沼込み 343s で作った一次実装を、brief 付きの新セッションで Pro が 173s で仕上げた。

## 4. モデル運用

- **既定は Flash**: zen の deepseek-v4-flash-free(日次無料枠)→ go の deepseek v4 Flash。
- **品質昇格は自動化しない**: 検収(オーケストレーター)が指摘事項を brief にまとめて Pro に明示的に再委譲する。Flash 8割(無料)→検収→Pro 仕上げ(少額)のループが実測で成立済み。
- **自動フォールバックは quota エラー時のみ**。発動したら結果に明示する。
- **実際に使われた provider/model を必ず表示する**(issue #7)。zen 無料枠切れ→有料 go への無言フォールバックはコスト構造を無言で崩すため、可視化は必須要件。

## 5. 検収(オーケストレーターの責務)

- **二段 verify**: ワーカーの verify はサブセット/スコープ付きになりがち(実測: 「フルスイート」報告が単一ファイル21件だった)。publish 前の真のフル `verify_in_container` は必ずオーケストレーターが実行する。
- **publish はオーケストレーター専権**: ネットワーク出口(publish)はワーカーに渡さない。資格情報は sunaba がホスト側で解決し、コンテナ内にトークンは存在しない。
- ワーカーガードレール(issue #5): verify スコープはディレクトリ単位まで / 再現はモックのユニットテストで行う / ライブ環境構築・資格情報探索をしない(実測: Flash が `env | grep -i token` まで進んだ。sunaba の no-token 設計が実害を防止)。

## 6. 障害と復旧

ワーカーは固有状態を持たないため、opencode がサイレントに死んでも sunaba 側の痕跡から救出できる:

- どこまで進んだか = `checkpoint_list` + `diff_in_container`
- 何をやっていたか = ジャーナル(sandbox_attach で session_label が付け替わり、ワーカーの操作が記録される)
- 何を考えていたか = イシュー上の brief

復旧手順は品質不良時のリトライと**同一パス**(diff 検収 → 採用 or restore → 再委譲)。よって companion のウォッチドッグ(issue #6)は遠慮なく kill してよい — 失うのはフェーズ跨ぎでどうせ捨てる会話コンテキストのみ。

タイムアウトの層構造: sunaba exec < opencode `experimental.mcp_timeout`(600000 に引き上げ済み。フル verify の MCP 呼び出しが実測 110s で、既定 120s の崖の 10s 手前だった)< companion ウォッチドッグ。

## 7. 実測で判明した opencode の制約 (1.17.x)

| 制約 | 影響 | 対処 |
|---|---|---|
| `format: json_schema` でセッション破損 | provider 400 + 以後 GET /message も 400 | スキーマをプロンプト埋め込み。上流起票 → issue #8 |
| MCP ツールは permission ask を発生させない(無音許可) | companion の permission 防波堤が MCP に無効 | `tools: {name: false}`(= `--deny`)で実行時ブロック |
| deny してもツール一覧はモデルに全量送信 | コンテキスト削減にならない、無駄呼び出しの可能性 | 上流提案 or MCP サーバー側プロファイル(§3) |
| `mcp_timeout` 既定 120s | テスト増加でフル verify が時間切れ必至 | 600000 に引き上げ |

## 8. 検証記録 (2026-07-16, VM / opencode 1.17.20)

1. **serve モード E2E**: flash-free ワーカーが attach → フル verify(1443 tests)→ 正確な報告まで 121s で完走。
2. **実イシュー委譲 (shiori#210)**: Flash が原因特定(rg が単一ファイル引数で FILE: prefix を省略)→修正+回帰テスト→checkpoint→verify→構造化報告まで 343s。検収で3件指摘(スコープ付き verify の過大報告 / ハッキーな修正 / rel_path のユーザー入力エコー)。
3. **Pro 仕上げ再委譲**: 指摘を brief 化して Pro に 173s で再委譲。`rg -H` 化・パス正規化・repo 全体 verify(422/422)を正確に実施。shiori PR #274 として publish。

## 9. 残タスク

issue で管理: #3(フェーズチェーン実装)/ #4(job.stats バグ)/ #5(ワーカーガードレール)/ #6(ウォッチドッグ)/ #7(モデル可視化)/ #8(上流起票)/ #9(LICENSE)。
