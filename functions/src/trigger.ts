// 確認チャットのトリガー判定（指示書STEP2-5）。
// 簡易な閾値判定でよい、との指示に従い「前回と比べた急変」を機械的に検出する。
//
// 仮決めのルール（TODO.md 参照）：
//   前回の回答と比べて、3軸のうち2軸以上が2ポイント以上変動した場合に
//   「引っかかり」ありとして、非刺激的な確認質問を1つ生成する。
//   （例：workload・mood のスコアが急に同時に大きく動いた等）
import type { Answers } from "./types";

const AXES: (keyof Answers)[] = ["workload", "mood", "support"];
const DELTA_THRESHOLD = 2; // 1軸あたりの変動幅のしきい値
const AXES_THRESHOLD = 2; // 何軸で急変したらトリガーするか

export type TriggerResult = {
  triggered: boolean;
  changedAxes: { axis: keyof Answers; before: number; after: number }[];
};

export function detectSuddenChange(
  previous: Answers | null,
  current: Answers
): TriggerResult {
  if (!previous) {
    return { triggered: false, changedAxes: [] };
  }
  const changedAxes = AXES.flatMap((axis) => {
    const before = previous[axis];
    const after = current[axis];
    return Math.abs(after - before) >= DELTA_THRESHOLD
      ? [{ axis, before, after }]
      : [];
  });
  return { triggered: changedAxes.length >= AXES_THRESHOLD, changedAxes };
}

// ===== 第二のトリガー：取込資料との食い違い（コア設計②の拡張・2026-07-07） =====
//
// 本人が取り込んだストレスチェック結果と今回の回答が大きくずれている場合、
// 「回答の裏に何かあるかもしれない」（例：資料ではサポート良好なのに、今は
// 『周囲のサポートがない』と回答＝孤立して話しにくくなった？）という気づきの種になる。
// 矛盾の指摘ではなく、そっと確かめる質問の起動条件として使う。

export type GapAxis = { axis: keyof Answers; docValue: number; nowValue: number };

// 資料と回答の食い違い（1軸でも2ポイント以上のずれ。良い方向・悪い方向の両方）
function gapAxes(doc: Answers | null, answers: Answers | null): GapAxis[] {
  if (!doc || !answers) return [];
  return AXES.flatMap((axis) => {
    const docValue = doc[axis];
    const nowValue = answers[axis];
    return Math.abs(nowValue - docValue) >= DELTA_THRESHOLD
      ? [{ axis, docValue, nowValue }]
      : [];
  });
}

// 「今回はじめて現れた食い違い」だけを返す。
// 前回のセルフチェックですでに同じ軸がずれていた場合は除外する
// （毎回同じことを聞かない＝そっと1回だけ、の思想）。
export function detectBackgroundGap(
  imported: Answers | null,
  previousDaily: Answers | null,
  current: Answers
): GapAxis[] {
  const now = gapAxes(imported, current);
  if (now.length === 0) return [];
  const beforeAxes = new Set(
    gapAxes(imported, previousDaily).map((g) => g.axis)
  );
  return now.filter((g) => !beforeAxes.has(g.axis));
}
