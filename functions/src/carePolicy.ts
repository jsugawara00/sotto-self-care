// 「判断の物差し」＝ care-policy.md の読み込み（企画書5章／指示書STEP2-3）。
//
// 設計方針：
//  - データの器（Firestore）と判断の物差し（この1つのmdファイル）を分離する。
//  - ファイルはコードに埋め込まず、Cloud Functions 実行時にファイルとして読む。
//    → mdファイルを推敲すれば、コードを触らずにフィードバックの方向性が変わる。
//  - リポジトリの追跡対象外（.gitignore済み）。デプロイには含まれる
//    （firebase.json の functions.ignore は node_modules 等のみで、knowledge/ は含まれる）。
import { readFileSync } from "fs";
import { resolve } from "path";

// コンパイル後の実行位置は functions/lib/ のため、1つ上の knowledge/ を見る
const POLICY_PATH = resolve(__dirname, "..", "knowledge", "care-policy.md");

export function loadCarePolicy(): string {
  const text = readFileSync(POLICY_PATH, "utf8").trim();
  if (!text) {
    throw new Error(`care-policy.md が空です: ${POLICY_PATH}`);
  }
  return text;
}
