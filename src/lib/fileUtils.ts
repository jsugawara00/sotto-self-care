// ファイル取り扱いのクライアントユーティリティ（STEP3）。
//  - 健診書類：PDFはそのまま base64（8MBまで）、画像は読取り精度を保つ軽い圧縮。
//  - 領収書：Firestoreドキュメント(1MiB)に収めるため強めに圧縮（base64で約900K文字まで）。
"use client";

// File → base64（データURLのヘッダを除いた本体のみ）
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
    reader.readAsDataURL(file);
  });
}

// 画像を canvas で JPEG に圧縮して base64 を返す。
// maxDim：長辺の上限px／quality：JPEG品質／maxBase64Chars：超えたら品質を段階的に下げる
export async function compressImageToBase64(
  file: File,
  options: { maxDim: number; quality: number; maxBase64Chars: number }
): Promise<{ base64: string; mimeType: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    throw new Error(
      "画像を読み込めませんでした（HEIC等の形式はJPEG/PNGに変換してからお試しください）。"
    );
  }

  const scale = Math.min(1, options.maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像の変換に失敗しました。");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // 品質を下げながら上限に収まるまで試す
  for (let quality = options.quality; quality >= 0.4; quality -= 0.1) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (base64.length <= options.maxBase64Chars) {
      return { base64, mimeType: "image/jpeg" };
    }
  }
  throw new Error("画像のサイズを十分に小さくできませんでした。別の画像でお試しください。");
}
