# そっと。

日々のセルフケアを支援するストレスチェック・健康管理アプリ（リメイク版）。

形骸化しがちな年1回のストレスチェックを「継続できる日常のセルフケア」に変えることを目指しています。
AIが過去との比較（縦断フィードバック)で一人ひとりに気づきを届け、確からしくないときは断定せずにそっと問い返します。

## 技術構成

- **フロントエンド**: Next.js (App Router) + React + TypeScript
- **バックエンド**: Firebase（Firestore / Cloud Functions / Authentication）
- **認証**: Firebase Auth + Google プロバイダ（招待制）
- **AI**: Claude API（Cloud Functions 側のみで使用。APIキーはクライアントに出ない）
- **デプロイ**: Vercel（フロント）+ Firebase（Rules / Functions）

## 特徴的な設計

- **招待ゲート**: 招待されたメールアドレスの Google アカウントだけが参加できる。
  ユーザー作成はサーバー側APIのみが行い、Security Rules でも二重に強制。
- **4段階ロール + 最小権限**: member / hr / admin / owner。管理者は実施状況の集計のみ閲覧でき、
  個別の回答内容は Security Rules レベルで見えない。
- **監査ログ**: ロール変更・招待発行などの権限操作はすべて `auditLogs` に記録。
  ガードレール（管理者ゼロ禁止・自己昇格禁止・確認ダイアログ）付き。
- **データの器と判断の物差しの分離**: ユーザーデータは Firestore、AIの判断基準は
  1つの Markdown ファイル（`functions/knowledge/care-policy.md`・リポジトリ追跡対象外）。
  ナレッジを推敲するだけでコードを触らずにフィードバックの方向性を変えられる。
- **縦断RAG**: 直近N回の回答推移を Claude に渡し、過去との比較で気づきを促す。
- **確認チャット**: 回答の急変を検知したときだけ、非刺激的な確認質問を1つ生成する。
- **健康管理の PII 分離**: 氏名・メールは `users` に、健康の機微データは氏名・uid を持たない
  仮名ID（`healthId`）で管理し、両者をつなぐマッピングもサーバー経由でのみ辿れる。
  機微データはクライアントから直接読めず（Rules で全面 deny）、本人が利用を停止すると
  ため込んだ健康データを即時に全削除する（データ最小化）。

## アーキテクチャ

「そっと。」は、本人が主体的に行うセルフケア（心のストレスチェックと体の健康管理）を主役に据え、
総務・管理者の運用機能がそれを支える構成です。機微なデータほど厳重に扱うプライバシー優先の設計で、
機微データはすべてサーバーAPI経由でのみ read/write します。

図の読み方・セキュリティ設計の詳細・ロール×機能の対応表は
**[docs/architecture.md](docs/architecture.md)** を参照してください。

```mermaid
flowchart TB
  subgraph Roles["利用者（4つのロール）"]
    direction LR
    member["担当者"]
    hr["総務"]
    admin["管理者"]
    owner["全権"]
  end

  subgraph Client["画面（Next.js・ブラウザ）"]
    direction TB
    subgraph Core["★ 本人のセルフケア（アプリの主役）"]
      direction LR
      scSelf["セルフチェック<br/>チェック→縦断フィードバック→確認チャット"]
      scMy["ストレスチェック取込<br/>過去の結果票を履歴に取り込む"]
      scHealth["健康管理<br/>健診書類の読取り・再検査の報告"]
    end
    subgraph Support["支える機能（管理・運用・通知）"]
      direction LR
      scHr["総務業務<br/>再検査の承認・差し戻し"]
      scAdmin["管理ダッシュボード<br/>実施率・再検査完了率"]
      scReport["期間レポート<br/>CSV・印刷"]
      scUsers["従業員・招待管理"]
      scAnn["一括案内<br/>送信・確認応答"]
    end
  end

  subgraph Server["サーバー（Next.js API・認証ゲート）"]
    direction LR
    apiGate["認証・招待ゲート"]
    apiCheck["チェック・取込API"]
    apiHealth["健康管理API"]
    apiHr["総務API"]
    apiAdmin["集計・レポートAPI"]
    apiAnn["一括案内API"]
  end

  subgraph Funcs["AI処理（Cloud Functions）"]
    direction LR
    fnFb["フィードバック・確認チャット生成"]
    fnReply["チャットの返し＋安全判定"]
    fnParse["書類読取り（onCall・非保存）"]
  end

  subgraph Data["データ（Firestore）"]
    direction LR
    dbGen["users（氏名・メール）<br/>invitations / orgSettings"]
    dbCheck["🔒 checkins"]
    dbAudit["auditLogs（証跡）"]
    dbAnn["🔒 announcements"]
    subgraph PII["健康管理（PII分離・直アクセス禁止・利用停止で全削除）"]
      direction LR
      dbLink["🔒 healthLinks<br/>uid→仮名ID（唯一の橋渡し）"]
      dbRec["🔒 healthRecords<br/>氏名・メールを持たない"]
      dbRcpt["🔒 receipts<br/>承認・差し戻しで即削除"]
    end
  end

  subgraph Ext["外部サービス"]
    direction LR
    auth["Firebase Auth<br/>招待制Googleログイン"]
    claude["Claude API"]
  end

  Roles ==>|ロールに応じて画面を出し分け| Client
  Client ==>|IDトークン付きで呼び出し（ロール確認）| Server
  Server ==>|読み書き（機微データはAPIのみ）| Data

  Client -. ログイン .-> auth
  Core -. 書類読取り（onCall・非保存） .-> Funcs
  Data -. checkins書込でトリガー .-> Funcs
  Funcs -. AIで生成→書き戻し .-> Data
  Funcs -. 抽出・生成 .-> claude

  classDef default fill:#ffffff,stroke:#9aa0a6,color:#202124;
  classDef core fill:#d5efe3,stroke:#1f7a44,stroke-width:2px,color:#14532d;
  classDef sensitive fill:#fdecea,stroke:#c0392b,color:#7b241c;
  classDef ai fill:#f5f2fc,stroke:#8a7bbf,color:#4a3f7a;
  classDef ext fill:#f2f6fb,stroke:#7fa3cc,color:#2c4a6b;
  class scSelf,scMy,scHealth core;
  class fnFb,fnReply,fnParse ai;
  class dbCheck,dbLink,dbRec,dbRcpt,dbAnn sensitive;
  class auth,claude ext;

  style Roles fill:#ffffff,stroke:#cccccc
  style Client fill:#ffffff,stroke:#cccccc
  style Core fill:#ffffff,stroke:#1f7a44,stroke-width:2px
  style Support fill:#ffffff,stroke:#dddddd
  style Server fill:#ffffff,stroke:#cccccc
  style Funcs fill:#ffffff,stroke:#cccccc
  style Data fill:#ffffff,stroke:#cccccc
  style PII fill:#ffffff,stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
  style Ext fill:#ffffff,stroke:#cccccc
```

## セットアップ

1. `.env.local.example` をコピーして `.env.local` を作成し、Firebase の値を設定
2. `functions/knowledge/care-policy.example.md` をコピーして `care-policy.md` を作成
3. 依存をインストール: `npm install` と `cd functions && npm install`
4. 最初の全権ユーザーを用意: `cd functions && npm run set-owner -- you@example.com`
5. 開発サーバー: `npm run dev`

Cloud Functions のデプロイには `ANTHROPIC_API_KEY` のシークレット登録が必要です:
`firebase functions:secrets:set ANTHROPIC_API_KEY`

## 免責

このアプリのチェックとフィードバックは医療的な診断ではありません。
