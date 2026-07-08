// 簡易セルフチェックの3問（試作から継承：3領域から1問ずつ・4択）
//
// スコアの向き（重要）：
//   workload高=負担大 / mood高=好調 / support高=サポート有。
//   縦断RAG・確認チャットの閾値判定もこの向きを前提にしている。

export type QuestionKey = "workload" | "mood" | "support";

export type Question = {
  key: QuestionKey;
  domain: string; // 領域名（画面表示用）
  text: string;
  options: { value: number; label: string }[]; // value は 1〜4
};

export const QUESTIONS: Question[] = [
  {
    key: "workload",
    domain: "仕事のストレス要因",
    text: "ここ最近、仕事の量や責任の重さに負担を感じることが多いですか？",
    options: [
      { value: 1, label: "ほとんど感じない" },
      { value: 2, label: "あまり感じない" },
      { value: 3, label: "やや感じる" },
      { value: 4, label: "とても感じる" },
    ],
  },
  {
    key: "mood",
    domain: "心身のストレス反応",
    text: "ここ最近、心身の調子（睡眠・気力・集中力など）は良好だと感じますか？",
    options: [
      { value: 1, label: "あまり良くない" },
      { value: 2, label: "どちらかといえば良くない" },
      { value: 3, label: "どちらかといえば良い" },
      { value: 4, label: "とても良い" },
    ],
  },
  {
    key: "support",
    domain: "周囲のサポート",
    text: "困ったとき、職場で相談したり助けを求められる相手がいますか？",
    options: [
      { value: 1, label: "ほとんどいない" },
      { value: 2, label: "あまりいない" },
      { value: 3, label: "ある程度いる" },
      { value: 4, label: "十分にいる" },
    ],
  },
];
