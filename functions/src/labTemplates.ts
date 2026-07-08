// 検査機関テンプレ（書類読取りの抽出定義）の読み込み。
// care-policy.md と同じく「設定はファイル・コードはそれを見るだけ」の構え
// （config-driven・ハードコード禁止＝企画書6章）。
// テンプレは knowledge/lab-templates/{templateId}.md に置き、追加はファイルを増やすだけ。
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// コンパイル後の実行位置は functions/lib/ のため、1つ上の knowledge/ を見る
const KNOWLEDGE_DIR = resolve(__dirname, "..", "knowledge");

type TemplateDir = "lab-templates" | "stress-templates";

// 利用可能なテンプレIDの一覧（＝ファイル名から拡張子を除いたもの）
export function listTemplateIds(dir: TemplateDir): string[] {
  return readdirSync(resolve(KNOWLEDGE_DIR, dir))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
}

// テンプレ本文の読み込み。IDは英小文字・数字・ハイフンのみ許可
// （パストラバーサル防止）。見つからなければ null。
function loadTemplate(dir: TemplateDir, templateId: string): string | null {
  if (!/^[a-z0-9-]+$/.test(templateId)) return null;
  try {
    const text = readFileSync(
      resolve(KNOWLEDGE_DIR, dir, `${templateId}.md`),
      "utf8"
    ).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// 健診結果テンプレ（STEP3）
export function loadLabTemplate(templateId: string): string | null {
  return loadTemplate("lab-templates", templateId);
}

// ストレスチェック結果テンプレ（取込機能）
export function loadStressTemplate(templateId: string): string | null {
  return loadTemplate("stress-templates", templateId);
}
