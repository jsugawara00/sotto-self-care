// Cloud Functions 側で共有する型定義

export type Answers = {
  workload: number; // 1〜4（高いほど仕事量の負担が大きい）
  mood: number; // 1〜4（高いほど心身が好調）
  support: number; // 1〜4（高いほどサポートが得られている）
};

// 縦断RAGに渡す過去回答（answeredAt は表示用に整形済みの文字列）。
// note はストレスチェック結果の取込時に本人が同意した「特徴の要約」（あれば）。
// chatAnswer は確認チャットでそのとき本人が話した内容（あれば）。
// どちらも「回答の裏」をそっと読むための背景情報（蒸し返さない・出どころを明示しない）。
export type HistoryEntry = {
  answeredAt: string;
  answers: Answers;
  note?: string;
  chatAnswer?: string;
};
