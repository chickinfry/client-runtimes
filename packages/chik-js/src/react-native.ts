import * as Keychain from "react-native-keychain";
import { Linking } from "react-native";
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
export * from "./react-native-checkout.js";

export { ChikNativeAuthError as ChikReactNativeAuthError };
export type ChikReactNativeAuthUser = ChikNativeAuthUser;
export type ChikReactNativeAuthSession = ChikNativeAuthSession;
export type ChikReactNativeSessionStore = ChikNativeSessionStore;
/** @deprecated Use ChikReactNativeSessionStore. */
export type ChikReactNativeSessionTokenStore = ChikReactNativeSessionStore;
export type ChikReactNativeClientOptions = ChikNativeClientOptions;
export type ChikReactNativeGitHubOAuthTransaction = ChikNativeGitHubOAuthTransaction;
export interface ChikReactNativeKeychainOptions { service?: string | undefined; }
export interface ChikReactNativeAuthOptions extends Omit<ChikNativeAuthOptions, "sessionStore"> {
  sessionStore?: ChikReactNativeSessionStore | undefined;
  /** @deprecated Use sessionStore. */
  tokenStore?: ChikReactNativeSessionStore | undefined;
  keychain?: ChikReactNativeKeychainOptions | undefined;
}

export function createReactNativeKeychainSessionStore(options: ChikReactNativeKeychainOptions = {}): ChikReactNativeSessionStore {
  const service = options.service ?? "chik.session";
  return {
    coordinationKey: `react-native-keychain:${service}`,
    async getSession() {
      const credentials = await Keychain.getGenericPassword({ service });
      if (credentials === false) return undefined;
      try { return JSON.parse(credentials.password) as ChikNativeStoredSession; }
      catch {
        if (!await Keychain.resetGenericPassword({ service })) throw new ChikNativeAuthError(ChikErrorCode.storageError, "The stored session could not be cleared.", 0);
        return undefined;
      }
    },
    async setSession(session) {
      if (!await Keychain.setGenericPassword("chik", JSON.stringify(session), { service })) throw new ChikNativeAuthError(ChikErrorCode.storageError, "The customer session could not be stored.", 0);
    },
    async clearSession() {
      if (!await Keychain.resetGenericPassword({ service })) throw new ChikNativeAuthError(ChikErrorCode.storageError, "The customer session could not be cleared.", 0);
    },
    async clearSessionScope(sessionScope) {
      await Keychain.resetGenericPassword({ service: `chik.checkout.${sessionScope}` });
    },
  };
}

/** @deprecated Use createReactNativeKeychainSessionStore. */
export const createReactNativeKeychainTokenStore = createReactNativeKeychainSessionStore;

export type ChikReactNativeAuth = ReturnType<typeof createNativeAuth>;
export interface ChikReactNativeGitHubOAuthOptions { timeoutMs?: number | undefined; openAuthorizationUrl?(url: string): Promise<unknown> | unknown; }

export async function signInWithReactNativeGitHub(auth: ChikReactNativeAuth, options: ChikReactNativeGitHubOAuthOptions = {}): Promise<ChikNativeAuthSession> {
  const transaction = await auth.startGitHubNative();
  const redirect = waitForRedirect(transaction.matchesRedirect, options.timeoutMs);
  try { await (options.openAuthorizationUrl ?? Linking.openURL)(transaction.authorizationUrl); } catch (error) { redirect.cancel(); await redirect.promise.catch(() => undefined); throw error; }
  return transaction.complete(await redirect.promise);
}

export function createReactNativeAuth(options: ChikReactNativeAuthOptions) {
  const { sessionStore, tokenStore, keychain, ...nativeOptions } = options;
  return createNativeAuth({ ...nativeOptions, sessionStore: sessionStore ?? tokenStore ?? createReactNativeKeychainSessionStore(keychain) });
}

function waitForRedirect(matches: (url: string) => boolean, timeoutMs = 5 * 60 * 1_000): { promise: Promise<string>; cancel(): void } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60 * 1_000) throw new ChikNativeAuthError(ChikErrorCode.invalidArgument, "timeoutMs is invalid.", 400);
  let cancel = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { remove(): void } | undefined;
    const finish = (complete: () => void) => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); subscription?.remove(); complete(); };
    subscription = Linking.addEventListener("url", ({ url }) => { if (matches(url)) finish(() => resolve(url)); });
    timer = setTimeout(() => finish(() => reject(new ChikNativeAuthError(ChikErrorCode.deadlineExceeded, "The authorization redirect timed out.", 408))), timeoutMs);
    cancel = () => finish(() => reject(new ChikNativeAuthError(ChikErrorCode.canceled, "The authorization flow was canceled.", 499)));
    void Linking.getInitialURL().then((url) => { if (url && matches(url)) finish(() => resolve(url)); }).catch(() => undefined);
  });
  return { promise, cancel };
}
