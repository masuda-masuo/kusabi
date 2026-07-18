# kusabi 設計書

最終更新: 2026-07-19
ステータス: フェーズチェーンまで設計確定+実地検証、自動チェーン(chain サブコマンド+sunaba-rpc)実装済み/main 反映済み。段階B/C/D は計画(#36 参照)。

## 1. 目的と位置づけ

opencode (anomalyco/opencode) を Claude Code から委譲可能なワーカーとして使うためのプラグイン。
Claude Code がオーケストレーター(計画・検収・publish 判断)、opencode + deepseek がワーカー(調査・実装・レビューの実働)という分業を成立させる。

動機はコスト構造: deepseek v4 Flash は安価(zen の日次無料枠 deepseek-v4-flash-free もある)で、実感として Haiku より良い仕事をする。調査・一次実装を実質無料で回し、仕上げだけ Pro に少額を払う構造を作る。

手本: openai/codex-plugin-cc (Apache-2.0)。プロンプト資産(adversarial-review.md / review-output.schema.json)は NOTICE 帰属付きで移植。

## 2. アーキテクチャ

```
Claude Code (オーケストレーター)
  └─ /kusabi:task 等のコマンド → 転送専用サブエージェント (agents/opencode-worker.md)
       └─ scripts/kusabi-companion.mjs (防波堤)
            └─ opencode serve (HTTP API, 127.0.0.1 + OPENCODE_SERVER_PASSWORD, on-demand 起動)
                 └─ deepseek ワーカー
                      └─ MCP: sunaba / shiori (opencode 側の opencode.json に設定)
                           └─ sunaba コンテナ (sandbox_attach で既存コンテナに合流)
```

### 採用した案と棄却した案

- **HTTP サーバー案を採用**。`opencode run` 直叩きは不採用 — 中間テキストが全ターン stdout に、ツールログが stderr に流れ、Claude のコンテキストを汚染するため。
- **companion スクリプトが防波堤**: SSE `/event` 購読、permission.asked への自動応答、イベントは state dir(`~/.kusabi/<hash(cwd)>/jobs/`)に保存、stdout には整形済み最終結果のみ。
- **転送専用サブエージェント**: オーケストレーターの認知負荷削減が最優先要件。コマンドの仕事は companion の実行と stdout の verbatim 転送のみ。
- opencode API は v1 面(`/session/...`, `/event`, `/permission/:id/reply`)を使用。v1→v2 移行中のため SDK を使う場合は pin する。

### 実行環境の前提

- ローカルに git リポジトリを持たない開発スタイル。作業はすべて sunaba コンテナ内で行い、ワーカーには container_id を渡して `sandbox_attach` で合流させる。opencode 本体はホスト側に留まる。
- sunaba の設計テーゼ(sunaba#478)と整合: **セッションは使い捨て、状態は外部**(合意=イシュー/PR、成果=コンテナ、監査=ジャーナル)。

## 3. フェーズチェーン(本設計の中核)

長いセッションはコンテキスト汚染が始まるため、作業を5フェーズに分割し、**各フェーズ=新規 opencode セッション**とする。フェーズ跨ぎのセッション再利用は禁止(`--resume-last` / `--session` は同一フェーズ内の追い込み専用)。

### 3.1 フェーズとツールマトリクス

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

### 3.2 brief(フェーズ間の引き継ぎ)

**GitHub イシューへの追記(`sunaba_issue_write`)を媒体とする。** コピペしない。

- sunaba#478 の「合意はイシュー/PR に住む」と一致する
- shiori が索引するため、調査成果がそのまま恒久的な検索可能知識になる
- コンテナ内ファイルと違い、複数の開発環境(VM / 自宅機)を跨げる

### 3.3 フェーズ=opencode agent 定義

フェーズは opencode.json の agent 定義として実装する。deny リスト+モデル既定+システムプロンプトを agent に束ね、companion の `--phase <name>` は `--agent` への写像にする。

注意(1.17.x 実測→1.18.3 で改善): セッション `tools` 設定も agent の permission も**実行時 deny ルールに変換される**。1.17.x ではモデルに送られるツール一覧から除外されていなかったが、**1.18.3 の `resolveTools` 修正により全面 `deny` は物理除外される**(issue #3 2026-07-17 実機A/B確認)。つまり `--deny` は実行ガードであると同時にコンテキスト削減にもなる。

真のフェーズ別ロードの実現ルートは:

1. 上流修正(deny ツールをリクエストから除外する提案 → issue #8 でトラッキング)
2. sunaba / shiori 側にプロファイル別 MCP エンドポイント(例: `/mcp/investigate` は read 系+issue_write のみ列挙)

どちらが実現しても agent 定義がそのまま受け皿になる。

### 3.4 失敗時リトライ

**checkpoint_restore + 同じ brief + 新セッション(またはモデル昇格)。**
失敗アプローチへのアンカリングを構造的に排除する。実測: Flash が泥沼込み 343s で作った一次実装を、brief 付きの新セッションで Pro が 173s で仕上げた。

### 3.5 自動チェーン(chain サブコマンド) — 実装済み

`chain --container <cid> --model <m> [--max-rounds N] "<brief>"` で起動する。実装は `plugins/kusabi/scripts/kusabi-companion.mjs` の `cmdChain`。

#### 3.5.1 ラウンド構造

各ラウンド r (1..maxRounds, 既定 3) の流れ:

1. **implement**: `kusabi-implement` agent で実装。r=1 は brief 全文、r≧2 は前ラウンド findings + brief の acceptance criteria のみ。前セッションの試行錯誤ログは渡さない
2. **決定論的プローブ**(→3.5.2): sunaba-rpc 経由でコンテナ内を非LLM検査
3. **review**: `kusabi-review` agent で adversarial レビュー。`--prior` で前ラウンド findings を持ち越す
4. **処遇導出**(→3.5.4): 機械的に disposition を決める

#### 3.5.2 決定論的プローブ(P1/P2, 非LLM)

sunaba-rpc(→3.6) 経由でコンテナ内を直接検査。LLM に触らせない:

| プローブ | 内容 | 失敗時の動作 |
|---|---|---|
| **P1: HEAD clean** | chain 開始時に `git rev-parse HEAD` で baseSha を記録。implement 後に HEAD≠base なら `git reset --mixed <base>` を自動実行 | 自動修復(コンテキスト汚染の実測: brief で明示禁止しても3回中2回発生)。事実はメタデータに記録 |
| **P2: verify gate** | `verify_in_container`(skip フラグ一切なし)を実行 | gate_passed=false なら review をスキップし、結果を findings 化して rework(ラウンド消費) |

段階B で P3(テスト件数不変)・P4(パッチ挿入検査)・P5(移設バイト同一性)が追加予定(→§9.3)。

#### 3.5.3 レビュー

`plugins/kusabi/prompts/adversarial-review.md` + `plugins/kusabi/schemas/review-output.schema.json` を使用。JSON schema は opencode の `format: json_schema` ではなく**プロンプトに埋め込む**(opencode 1.17.x のバグ回避、issue #8)。companion がモデルの応答から JSON を抽出(`extractJson`+`strip`)+整形(`renderReview`)する。

レビュアー(kusabi-review)の権限:
- **allow**: `sunaba_verify_in_container`, `sunaba_lint_in_container`, `sunaba_type_check_in_container` — 実装者の「gate 緑」申告を独立に再実行して裏取る(PR#37/#40)
- **deny**: 変更系全般(sandbox_exec, write_file, edit_file, checkout, publish 等) — レビュアーが直し始めたら独立性が消えるため

verdict は4値 + optional `unverified`:
| verdict | 意味 |
|---|---|
| `approve` | 全 acceptance criteria が検証可能かつ合格 |
| `approve-partial` | 一部の criteria が検証できなかった。`unverified` に列挙 |
| `needs-attention` | 修正可能な欠陥あり |
| `discard` | 前提・方針が誤り。`discard_reason` 必須(`wrong_premise` / `needs_stronger_model`) |

#### 3.5.4 処遇導出(deriveDisposition)

`plugins/kusabi/scripts/kusabi-companion.mjs` の純関数 `deriveDisposition({verdict, probesGreen, round, maxRounds, repeatedAreas})`:

| verdict | probesGreen | 条件 | disposition | 意味 |
|---|---|---|---|---|
| approve | true | — | **accept** | 収束、orchestrator へ |
| approve | false | — | rework | プローブ失敗 |
| approve-partial | — | — | **escalate** | 未確認項目あり、orchestrator 判断へ |
| needs-attention | — | repeatedAreas=false | rework | 修正して再レビュー |
| needs-attention | — | repeatedAreas=true | **escalate** | 同ファイル領域の指摘が2ラウンド連続=停滞 |
| discard | — | — | **escalate** | レビュアーが廃棄判定 |
| — | — | round ≥ maxRounds かつ未accept | **escalate** | 最大ラウンド到達 |

rework → escalate の間に strategist 段(→§9.1) を挿入可能(段階B、未実装)。

#### 3.5.5 再開方法と記録

rework の再開方法:
- **1回目**: 同一 implement セッション継続(findings のみ投入)
- **2回目以降**: `checkpoint_restore(baseSha)` → **新セッション**(新規コンテキストで再挑戦)。restore できない場合はその事実を resumeMethod に記録する(実際にやっていないことを記録しない)

どちらを使ったかは各ラウンドのメタデータに記録。state dir の `chains/<chain-id>/` にラウンドごとの JSON(`round-N.json`) + 集約 JSON(`chain.json`)で永続化。

escalate 時は残 findings + 経緯(各ラウンドの verdict/probes/disposition/resume方法) を最終出力に含める。publish は chain から一切呼ばれない(許可リストにない)。

### 3.6 sunaba-rpc(生JSON-RPCクライアント) — 実装済み

`plugins/kusabi/scripts/sunaba-rpc.mjs`。companion の非LLMパイプライン(決定論的プローブ等)が sunaba の MCP ツールを呼ぶための**生 HTTP+SSE クライアント**。MCP クライアントではない。

- **エンドポイント**: env `KUSABI_SUNABA_URL`、既定 `http://127.0.0.1:8750/mcp`。127.0.0.1(固定、localhost は IPv6 名前解決問題回避)
- **プロトコル**: Streamable HTTP。`initialize` POST → レスポンスヘッダ `mcp-session-id` を保持 → `notifications/initialized` → `tools/call`
- **レスポンス形式**: SSE(`data:` 行)。最終行の JSON を結果とする。MCP の `content[0].text` ラップを自動 unwrap(`unwrapResult`)
- **ツール許可リスト(ハードコード)** — 以下の5ツールのみ。リスト外は呼び出し前のバリデーションで `throw`:
  - `verify_in_container`
  - `sandbox_exec`
  - `checkpoint`
  - `checkpoint_list`
  - `checkpoint_restore`

publish / issue_write / sandbox_initialize 等は**構造的に呼べない**(設計不変条件: ネットワーク出口はオーケストレーター専有)。

`sandbox_exec` の `commands` は**必ず配列**で渡す(文字列は validation error)。

## 4. モデル運用

- **既定は Flash**: zen の deepseek-v4-flash-free(日次無料枠)→ go の deepseek v4 Flash。
- **品質昇格は自動化しない**: 検収(オーケストレーター)が指摘事項を brief にまとめて Pro に明示的に再委譲する。Flash 8割(無料)→検収→Pro 仕上げ(少額)のループが実測で成立済み。
- **自動フォールバックは quota エラー時のみ**。発動したら結果に明示する。
- **実際に使われた provider/model を必ず表示する**(issue #7)。zen 無料枠切れ→有料 go への無言フォールバックはコスト構造を無言で崩すため、可視化は必須要件。

## 5. 検収(オーケストレーターの責務)

- **二段 verify**: ワーカーの verify はサブセット/スコープ付きになりがち(実測: 「フルスイート」報告が単一ファイル21件だった)。publish 前の真のフル `verify_in_container` は必ずオーケストレーターが実行する。
- **publish はオーケストレーター専権**: ネットワーク出口(publish)はワーカーに渡さない。資格情報は sunaba がホスト側で解決し、コンテナ内にトークンは存在しない。
- ワーカーガードレール(issue #5): verify スコープはディレクトリ単位まで / 再現はモックのユニットテストで行う / ライブ環境構築・資格情報探索をしない(実測: Flash が `env | grep -i token` まで進んだ。sunaba の no-token 設計が実害を防止)。
  - **資産化済み**: `prompts/task-guardrails.md` を companion が全 task プロンプトに自動前置する(スコープ厳守 / verify 正直報告 / モック再現 / VCS 出口禁止 / 3部構成の報告形式)。オーケストレーターはタスク固有の内容(スコープ・前提・受入基準)だけ書けばよい。フェーズチェーン(§3)実装時は agent 定義側に吸収する。
- **レビューは前提文脈が必須**(2026-07-17 A/B 実測): 同一 diff でも、フォーカス文脈なしだと旧コードの意図を好意的に捏造した誤前提の指摘になり、リンク先イシューの前提を与えると上流ソース実引用の検証可能なレビューに変わった。レビュー委譲時はフォーカスに前提(イシュー・意図・既知の実測事実)を必ず入れる。

### 5.1 凍結オラクルと integrity check

dev-workflow-orchestrator(プロトタイプ)から「受け入れテスト=凍結・読み取り専用の唯一のオラクル / 開発テスト=可変の足場」の 2 層構造を移植する。FSM 等は持ち込まない。

- brief の `## 受入基準` は凍結された契約。`## 凍結テスト` に列挙されたファイルは implement/respond ワーカーの変更禁止対象
- 検収手順に 1 ステップ追加: publish 前に、凍結テストのパスに差分がないことを diff で機械的に確認する(差分があれば理由を問わず差し戻し)。受入基準の充足確認はその後に行う
- 出典: dev-workflow-orchestrator の設計思想。テストの二層構造(凍結 oracle と可変 scaffold)により、ワーカーの verify 正直さへの依存を減らす

## 6. 障害と復旧

ワーカーは固有状態を持たないため、opencode がサイレントに死んでも sunaba 側の痕跡から救出できる:

- どこまで進んだか = `checkpoint_list` + `diff_in_container`
- 何をやっていたか = ジャーナル(sandbox_attach で session_label が付け替わり、ワーカーの操作が記録される)
- 何を考えていたか = イシュー上の brief

復旧手順は品質不良時のリトライと**同一パス**(diff 検収 → 採用 or restore → 再委譲)。よって companion のウォッチドッグ(issue #6)は遠慮なく kill してよい — 失うのはフェーズ跨ぎでどうせ捨てる会話コンテキストのみ。

タイムアウトの層構造: sunaba exec < opencode `experimental.mcp_timeout`(600000 に引き上げ済み。フル verify の MCP 呼び出しが実測 110s で、既定 120s の崖の 10s 手前だった)< companion ウォッチドッグ。

## 7. 実測で判明した opencode の制約 (1.17.x → 1.18.3)

| 制約 | 影響 | 対処 |
|---|---|---|
| `format: json_schema` でセッション破損 | provider 400 + 以後 GET /message も 400 | スキーマをプロンプト埋め込み。上流起票 → issue #8 |
| MCP ツールは permission ask を発生させない(無音許可) | companion の permission 防波堤が MCP に無効 | `tools: {name: false}`(= `--deny`)で実行時ブロック |
| deny ツールはモデル送信リストから物理除外(1.18.3+) | コンテキスト削減になる、無駄呼び出しの危険も除去 | 全面deny、agent定義で実現済み(§3.3参照) |
| `mcp_timeout` 既定 120s | テスト増加でフル verify が時間切れ必至 | 600000 に引き上げ |

### レビュアー権限(PR#37/#40 で確定)

| ツール | 権限 | 理由 |
|---|---|---|
| `verify_in_container` / `lint_in_container` / `type_check_in_container` | **allow** | 実装者の「gate 緑」申告を独立に再実行するために必須 |
| `sandbox_exec` / `sandbox_exec_background` / `run_container_and_exec` | **deny** | 任意シェル実行は read-only 性を破壊する |
| 変更系全般(write_file/edit_file/checkpoint_restore/publish 等) | **deny** | レビュアーが直し始めたら独立性が消える |

`sandbox_initialize` / `sandbox_stop` 等のコンテナ管理系も deny。この設定は `plugins/kusabi/opencode-agents/kusabi-review.md` でハードコードされている。

## 8. 検証記録 (2026-07-16, VM / opencode 1.17.20)

1. **serve モード E2E**: flash-free ワーカーが attach → フル verify(1443 tests)→ 正確な報告まで 121s で完走。
2. **実イシュー委譲 (shiori#210)**: Flash が原因特定(rg が単一ファイル引数で FILE: prefix を省略)→修正+回帰テスト→checkpoint→verify→構造化報告まで 343s。検収で3件指摘(スコープ付き verify の過大報告 / ハッキーな修正 / rel_path のユーザー入力エコー)。
3. **Pro 仕上げ再委譲**: 指摘を brief 化して Pro に 173s で再委譲。`rg -H` 化・パス正規化・repo 全体 verify(422/422)を正確に実施。shiori PR #274 として publish。

## 9. 自動チェーンの拡張計画(未実装)

以下の内容は issue #36 の「着手にあたっての設計確定」コメント(2026-07-19)で合意された**計画**である。**現行 main には実装されていない。**

### 9.1 決定4: strategist段(停滞対策) — 段階B(計画)

`deriveDisposition` に `strategize` を追加: repeatedAreas 検知時、escalate の前に1回だけ strategist 段を許す(2回目の停滞で escalate)。kusabi-investigate 流用+専用テンプレートで根本原因診断(1〜3文) + 「WHAT(受入基準)は不変のままHOWを変える構造的変更を1つ」を出力。その勧告を次の rework ラウンドに findings と一緒に渡す。

参照: issue #36 コメント「決定4: escalateの中間形としてstrategist段を段階Bに追加」

### 9.2 決定5: accept-with-followup(経済的打ち切り) — 段階B(計画)

`deriveDisposition` に `accept-with-followup` を追加。条件:
- プローブ全緑
- かつ verdict が approve、または needs-attention でも残 findings がすべて minor(severity low/medium)かつ受入基準のいずれにも触れない

→ 残 findings を `followup_issue_draft`(タイトル+本文: 完了済み範囲と検証結果/残作業/既知 findings/元issue参照)に落として終了。

悪用ガード:
1. severity はレビュアー(実装者と別セッション)の出力。実装者は自己申告できない
2. 適用は**プローブ全緑が前提**(機械検査を通らない限り severity 分類は無関係)
3. 繰延された findings は**必ず orchestrator の目に入る**(publish 前の最終検分で内容を見る)

参照: issue #36 コメント「決定5: accept-with-followup(経済的打ち切り規則)」

### 9.3 段階B/C 概要

| 段階 | 内容 | 前提 |
|---|---|---|
| **B** | brief 宣言型プローブ: `kind: refactor` / `baseline_collected: N` 書式。テスト件数不変(P3)・移設バイト同一性(P5) | 段階A 安定稼働 |
| **B** | 決定4(strategist段)・決定5(accept-with-followup)の実装 | 段階A |
| **C** | サボタージュ検査(P4): patch/monkeypatch.setattr 対象を AST で機械分類。mock対象テストのみ判定に使い、被検体テストは除外 | 段階B |
| **D** | discard 経路の #33(best-of-N)接続 | 段階C、実摩擦待ち |

参照: issue #36 コメント「着手にあたっての設計確定 → 決定3: 段階分割(1PR=1段階)」

### 9.4 残タスク(現状)

issue で管理:
- #7-2(モデル可視化の残余)
- #8(上流起票: opencode format:json_schema バグの報告と修正)
- #33(best-of-n トーナメント)
- #35(脅威モデル: 決定論的プローブの設計不変条件に該当)
- #36(本issue)段階B以降の実装項目
