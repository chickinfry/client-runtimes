import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import {
  ChikNativeAuthError,
  createNativeAuth,
  type ChikNativeAuthOptions,
  type ChikNativeAuthSession,
  type ChikNativeAuthUser,
  type ChikNativeClientOptions,
  type ChikNativeGitHubOAuthTransaction,
  type ChikNativeSessionStore,
  type ChikNativeStoredSession,
} from "./auth.js";
import { ChikErrorCode } from "./error-contract.js";

export { ChikNativeAuthError as ChikExpoAuthError };
export type ChikExpoAuthUser = ChikNativeAuthUser;
export type ChikExpoAuthSession = ChikNativeAuthSession;
export type ChikExpoSessionStore = ChikNativeSessionStore;
/** @deprecated Use ChikExpoSessionStore. */
export type ChikExpoSessionTokenStore = ChikExpoSessionStore;
export type ChikExpoClientOptions = ChikNativeClientOptions;
export type ChikExpoGitHubOAuthTransaction = ChikNativeGitHubOAuthTransaction;
export interface ChikExpoAuthOptions extends Omit<ChikNativeAuthOptions, "sessionStore"> {
  sessionStore?: ChikExpoSessionStore | undefined;
  /** @deprecated Use sessionStore. */
  tokenStore?: ChikExpoSessionStore | undefined;
  secureStoreKey?: string | undefined;
}

export function createExpoSecureStoreSessionStore(key = "chik.session"): ChikExpoSessionStore {
  return {
    coordinationKey: `expo-secure-store:${key}`,
    async getSession() {
      const value = await SecureStore.getItemAsync(key);
      if (value === null) return undefined;
      try { return JSON.parse(value) as ChikNativeStoredSession; }
      catch {
        await SecureStore.deleteItemAsync(key);
        return undefined;
      }
    },
    setSession: (session) => SecureStore.setItemAsync(key, JSON.stringify(session)),
    clearSession: () => SecureStore.deleteItemAsync(key),
    async clearSessionScope() {},
  };
}

/** @deprecated Use createExpoSecureStoreSessionStore. */
export const createExpoSecureStoreTokenStore = createExpoSecureStoreSessionStore;

export type ChikExpoAuth = ReturnType<typeof createNativeAuth>;

export async function signInWithExpoGitHub(auth: ChikExpoAuth): Promise<ChikNativeAuthSession> {
  const transaction = await auth.startGitHubNative();
  const result = await WebBrowser.openAuthSessionAsync(transaction.authorizationUrl, transaction.redirectUri, { preferUniversalLinks: true });
  if (result.type !== "success" || typeof result.url !== "string") throw new ChikNativeAuthError(ChikErrorCode.canceled, "The authorization flow did not complete.", 499);
  return transaction.complete(result.url);
}

export function createExpoAuth(options: ChikExpoAuthOptions) {
  const { sessionStore, tokenStore, secureStoreKey, ...nativeOptions } = options;
  return createNativeAuth({ ...nativeOptions, sessionStore: sessionStore ?? tokenStore ?? createExpoSecureStoreSessionStore(secureStoreKey) });
}
