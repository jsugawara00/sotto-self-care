// Firebase クライアント SDK の初期化（ブラウザで使用）
// 認証（Auth＋Googleプロバイダ）と Firestore の onSnapshot 監視に使う。
//
// Auth / Firestore はブラウザでのみ初期化する。
// 理由：Next.js の SSR / ビルド時のプリレンダリングでは NEXT_PUBLIC_ の値が無いと
//       getAuth が auth/invalid-api-key で例外を投げるため。これらは "use client" の
//       コンポーネント内（useEffect やイベントハンドラ＝ブラウザ実行）でのみ使う。
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from "firebase/firestore";
import {
  getFunctions,
  connectFunctionsEmulator,
  type Functions,
} from "firebase/functions";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Next.js のホットリロードで多重初期化されないようにガードする
const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

// サーバー側（SSR/ビルド）では未初期化のまま。ブラウザ側でのみ実体を持つ。
let auth: Auth = undefined as unknown as Auth;
let db: Firestore = undefined as unknown as Firestore;
let fns: Functions = undefined as unknown as Functions;

if (typeof window !== "undefined") {
  auth = getAuth(app);
  db = getFirestore(app);
  // Cloud Functions（書類読取り parseHealthDocument）。デプロイ先リージョンと揃える
  fns = getFunctions(app, "asia-northeast1");

  // ローカルエミュレータ接続（任意）。ブラウザ側で一度だけ接続する。
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true") {
    // @ts-expect-error 多重接続防止のための独自フラグ
    if (!window.__FIREBASE_EMULATORS_CONNECTED__) {
      connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      connectFirestoreEmulator(db, "127.0.0.1", 8080);
      connectFunctionsEmulator(fns, "127.0.0.1", 5001);
      // @ts-expect-error 同上
      window.__FIREBASE_EMULATORS_CONNECTED__ = true;
    }
  }
}

export { app, auth, db, fns };
