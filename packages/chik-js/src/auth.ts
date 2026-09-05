import { createChikClientRuntime, type ChikClientOptions, type ChikCookieSessionSource, type ChikSessionTokenSource } from "./core.js";
import { ChikErrorCode, ChikErrorMessage, isChikProtocolErrorCode, type ChikErrorCode as ChikAuthErrorCode } from "./error-contract.js";
import {
  chikAbsentSessionScope,
  chikBrowserSessionLockName,
  chikGitHubOAuthFinalizePath,
  chikOAuthPendingStorageKey,
  chikSessionScopeHeader,
  chikSessionTransitionStorageKey,
  chikTabSessionStorageKey,
} from "./wire-contract.js";

export class ChikAuthError extends Error {
  constructor(
    readonly code: ChikAuthErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
    options: { cause?: unknown; rawCode?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChikAuthError";
    this.rawCode = options.rawCode;
  }

  readonly rawCode: string | undefined;
}

export interface AuthUser { userId: string; projectId: string; email: string; emailVerified: boolean; disabled: boolean; createdAt: string; }
export interface AuthSession { user: AuthUser; expiresAt: string; refreshExpiresAt?: string | undefined; }
export interface AuthActionAccepted { accepted: true; expiresAt?: string | undefined; }
export interface WebPushSubscriptionOptions { deviceLabel?: string | undefined; }
export interface ChikWebPushSubscription {
  readonly endpoint: string;
  toJSON(): { keys?: unknown };
  unsubscribe(): Promise<boolean>;
}

let activeWebPushSubscription: ChikWebPushSubscription | undefined;
const browserRefreshPath = "/api/auth/refresh";
const browserSignOutPath = "/api/auth/sign-out";
let browserSessionScope: string | undefined;
let browserSessionScopeController = new AbortController();
let browserSessionInitialized = false;
let browserRefreshInFlight: { scope: string | undefined; promise: Promise<AuthSession> } | undefined;
let browserSessionSuperseded = false;
let browserSessionCoordination: {
  readonly localStorage: Storage;
  readonly sessionStorage: Storage;
  marker: string | null;
} | undefined;

interface BrowserOAuthPending {
  readonly version: 1;
  readonly state: string;
  readonly transitionMarker: string | null;
  readonly expiresAt: number;
}

interface BrowserTabSession {
  readonly version: 1;
  readonly transitionMarker: string | null;
  readonly sessionScope: string | null;
}

interface BrowserSessionLease {
  readonly scope: string | undefined;
  readonly signal: AbortSignal;
}

function refreshBrowserSession(expectedSessionScope = browserSessionScope): Promise<AuthSession> {
  const current = browserRefreshInFlight;
  if (current !== undefined && current.scope === expectedSessionScope) return current.promise;
  const pending = withBrowserSessionLock(() => refreshBrowserSessionLocked(expectedSessionScope));
  const inFlight = { scope: expectedSessionScope, promise: pending };
  browserRefreshInFlight = inFlight;
  void pending.then(
    () => { if (browserRefreshInFlight === inFlight) browserRefreshInFlight = undefined; },
    () => { if (browserRefreshInFlight === inFlight) browserRefreshInFlight = undefined; },
  );
  return pending;
}

function refreshBrowserSessionLocked(expectedSessionScope: string | undefined): Promise<AuthSession> {
  assertBrowserSessionCurrent();
  if (expectedSessionScope !== undefined && browserSessionScope !== expectedSessionScope) {
    throw supersededBrowserSession();
  }
  return browserSessionCall<AuthSession>(browserRefreshPath, {
    method: "POST",
    ...(expectedSessionScope === undefined
      ? {}
      : { headers: { [chikSessionScopeHeader]: expectedSessionScope } }),
  }, true, "observe");
}

function withBrowserSessionLock<T>(operation: () => Promise<T>, allowSuperseded = false): Promise<T> {
  if (typeof navigator === "undefined") {
    return typeof document === "undefined"
      ? operation()
      : Promise.reject(browserSessionCoordinationError());
  }
  if (typeof document !== "undefined") requireBrowserSessionCoordination();
  const locks = (navigator as Navigator & {
    locks?: { request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T> };
  }).locks;
  if (locks) return locks.request(chikBrowserSessionLockName, { mode: "exclusive" }, async () => {
    if (!allowSuperseded) assertBrowserSessionCurrent();
    return operation();
  });
  if (typeof document !== "undefined") {
    return Promise.reject(new ChikAuthError(
      ChikErrorCode.unimplemented,
      ChikErrorMessage.browserSessionCoordinationRequired,
      501,
    ));
  }
  return operation();
}

function supersededBrowserSession(): ChikAuthError {
  return new ChikAuthError(
    ChikErrorCode.aborted,
    ChikErrorMessage.authenticationSessionChanged,
    409,
  );
}

function browserSessionCoordinationError(cause?: unknown): ChikAuthError {
  return new ChikAuthError(
    ChikErrorCode.unimplemented,
    ChikErrorMessage.browserSessionCoordinationRequired,
    501,
    undefined,
    cause === undefined ? {} : { cause },
  );
}

function requireBrowserSessionCoordination(): typeof browserSessionCoordination {
  if (typeof window === "undefined" || typeof document === "undefined") return undefined;
  if (!browserSessionCoordination) {
    try {
      const localStorage = window.localStorage;
      const sessionStorage = window.sessionStorage;
      const sharedMarker = localStorage.getItem(chikSessionTransitionStorageKey);
      const tabSession = parseBrowserTabSession(
        sessionStorage.getItem(chikTabSessionStorageKey),
      );
      const coordination = {
        localStorage,
        sessionStorage,
        marker: tabSession ? tabSession.transitionMarker : sharedMarker,
      };
      if (tabSession) {
        browserSessionScope = tabSession.sessionScope ?? undefined;
        browserSessionInitialized = true;
      }
      window.addEventListener("storage", (event) => {
        if (event.key !== null && event.key !== chikSessionTransitionStorageKey) return;
        if (event.storageArea !== null && event.storageArea !== coordination.localStorage) return;
        synchronizeBrowserSessionTransition(coordination);
      });
      browserSessionCoordination = coordination;
    } catch (cause) {
      throw browserSessionCoordinationError(cause);
    }
  }
  synchronizeBrowserSessionTransition(browserSessionCoordination, true);
  return browserSessionCoordination;
}

function synchronizeBrowserSessionTransition(
  coordination: NonNullable<typeof browserSessionCoordination>,
  strict = false,
): void {
  try {
    if (coordination.localStorage.getItem(chikSessionTransitionStorageKey) !== coordination.marker) {
      supersedeBrowserSession();
    }
  } catch (cause) {
    supersedeBrowserSession();
    if (strict) throw browserSessionCoordinationError(cause);
  }
}

function observeBrowserSessionTransition(): void {
  if (browserSessionCoordination) synchronizeBrowserSessionTransition(browserSessionCoordination);
}

function parseBrowserTabSession(raw: string | null): BrowserTabSession | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version === 1
      && (typeof value.transitionMarker === "string" || value.transitionMarker === null)
      && (typeof value.sessionScope === "string" || value.sessionScope === null)
    ) return value as unknown as BrowserTabSession;
  } catch {
    // 아래의 fail-closed 오류로 수렴합니다.
  }
  throw browserSessionCoordinationError();
}

function persistBrowserTabSession(
  coordination: NonNullable<typeof browserSessionCoordination>,
  scope: string | undefined,
): void {
  try {
    coordination.sessionStorage.setItem(chikTabSessionStorageKey, JSON.stringify({
      version: 1,
      transitionMarker: coordination.marker,
      sessionScope: scope ?? null,
    } satisfies BrowserTabSession));
  } catch (cause) {
    supersedeBrowserSession();
    throw browserSessionCoordinationError(cause);
  }
}

function clearBrowserOAuthPending(strict = false): void {
  try {
    browserSessionCoordination?.sessionStorage.removeItem(chikOAuthPendingStorageKey);
  } catch (cause) {
    if (strict) {
      browserSessionSuperseded = true;
      browserSessionScopeController.abort();
      throw browserSessionCoordinationError(cause);
    }
    // 남은 비밀 없는 표식은 다음 명시적 복구에서 보수적으로 세션을 다시 전환합니다.
  }
}

function supersedeBrowserSession(preserveOAuthPending = false): void {
  if (!preserveOAuthPending) clearBrowserOAuthPending();
  if (browserSessionSuperseded) return;
  browserSessionSuperseded = true;
  browserSessionScopeController.abort();
}

function assertBrowserSessionCurrent(): void {
  observeBrowserSessionTransition();
  if (browserSessionSuperseded) throw supersededBrowserSession();
}

function captureBrowserSessionLease(): BrowserSessionLease {
  assertBrowserSessionCurrent();
  return { scope: browserSessionScope, signal: browserSessionScopeController.signal };
}

function browserRequestSessionScope(): string | undefined {
  return browserSessionInitialized
    ? browserSessionScope ?? chikAbsentSessionScope
    : undefined;
}

function assertBrowserSessionLeaseCurrent(lease: BrowserSessionLease | undefined): void {
  if (!lease) return;
  assertBrowserSessionCurrent();
  if (
    lease.signal.aborted
    || browserSessionScope !== lease.scope
    || browserSessionScopeController.signal !== lease.signal
  ) throw supersededBrowserSession();
}

function adoptBrowserSessionScope(scope: string | undefined, allowSuperseded = false): void {
  const coordination = requireBrowserSessionCoordination();
  if (!allowSuperseded) assertBrowserSessionCurrent();
  if (coordination) {
    try {
      coordination.marker = coordination.localStorage.getItem(chikSessionTransitionStorageKey);
    } catch (cause) {
      supersedeBrowserSession();
      throw browserSessionCoordinationError(cause);
    }
  }
  if (browserSessionInitialized && scope === browserSessionScope && !browserSessionSuperseded) return;
  browserSessionScopeController.abort();
  browserSessionScopeController = new AbortController();
  browserSessionScope = scope;
  browserSessionInitialized = true;
  browserSessionSuperseded = false;
  if (coordination) persistBrowserTabSession(coordination, scope);
}

function browserSessionTransitionMarker(): string {
  try {
    return crypto.randomUUID();
  } catch (cause) {
    throw browserSessionCoordinationError(cause);
  }
}

function beginBrowserSessionTransition(oauthPending?: BrowserOAuthPending): void {
  const coordination = requireBrowserSessionCoordination();
  if (!coordination) {
    browserSessionScopeController.abort();
    browserSessionScopeController = new AbortController();
    return;
  }
  const marker = browserSessionTransitionMarker();
  try {
    coordination.localStorage.setItem(chikSessionTransitionStorageKey, marker);
    coordination.marker = marker;
    browserSessionScopeController.abort();
    browserSessionScopeController = new AbortController();
    browserSessionSuperseded = false;
    persistBrowserTabSession(coordination, browserSessionScope);
    if (oauthPending) {
      coordination.sessionStorage.setItem(chikOAuthPendingStorageKey, JSON.stringify({
        ...oauthPending,
        transitionMarker: marker,
      } satisfies BrowserOAuthPending));
    } else clearBrowserOAuthPending(true);
  } catch (cause) {
    supersedeBrowserSession();
    throw browserSessionCoordinationError(cause);
  }
}

function completeBrowserSessionTransition(scope: string | undefined): void {
  adoptBrowserSessionScope(scope, true);
}

function markBrowserOAuthPending(input: {
  state: string;
  expiresAt: string;
}): void {
  const coordination = requireBrowserSessionCoordination();
  if (!coordination) return;
  const state = input.state.trim();
  const serverExpiresAt = Date.parse(input.expiresAt);
  const expiresAt = Math.min(serverExpiresAt, Date.now() + 10 * 60 * 1_000);
  if (
    !/^[A-Za-z0-9_-]{1,512}$/u.test(state)
    || !Number.isFinite(serverExpiresAt)
    || expiresAt <= Date.now()
    || expiresAt > Date.now() + 10 * 60 * 1_000
  ) throw browserSessionCoordinationError();
  try {
    const pending: BrowserOAuthPending = {
      version: 1,
      state,
      transitionMarker: coordination.localStorage.getItem(chikSessionTransitionStorageKey),
      expiresAt,
    };
    coordination.sessionStorage.setItem(chikOAuthPendingStorageKey, JSON.stringify(pending));
  } catch (cause) {
    throw browserSessionCoordinationError(cause);
  }
}

function browserOAuthPending(): BrowserOAuthPending | undefined {
  const coordination = requireBrowserSessionCoordination();
  if (!coordination) return undefined;
  let raw: string | null;
  try {
    raw = coordination.sessionStorage.getItem(chikOAuthPendingStorageKey);
  } catch (cause) {
    throw browserSessionCoordinationError(cause);
  }
  if (raw === null) return undefined;
  let pending: BrowserOAuthPending | undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version === 1
      && typeof value.state === "string"
      && /^[A-Za-z0-9_-]{1,512}$/u.test(value.state)
      && (typeof value.transitionMarker === "string" || value.transitionMarker === null)
      && typeof value.expiresAt === "number"
      && Number.isSafeInteger(value.expiresAt)
    ) pending = value as unknown as BrowserOAuthPending;
  } catch {
    // 아래의 공통 무효화 경로가 잘못된 표식을 제거합니다.
  }
  if (
    !pending
    || pending.expiresAt <= Date.now()
    || pending.expiresAt > Date.now() + 10 * 60 * 1_000
  ) {
    clearBrowserOAuthPending(true);
    supersedeBrowserSession();
    throw supersededBrowserSession();
  }
  let currentMarker: string | null;
  try {
    currentMarker = coordination.localStorage.getItem(chikSessionTransitionStorageKey);
  } catch (cause) {
    supersedeBrowserSession();
    throw browserSessionCoordinationError(cause);
  }
  if (currentMarker !== pending.transitionMarker) {
    clearBrowserOAuthPending(true);
    supersedeBrowserSession();
    throw supersededBrowserSession();
  }
  return pending;
}

const cookieSessionSource: ChikCookieSessionSource = {
  getSessionScope() {
    observeBrowserSessionTransition();
    return browserRequestSessionScope();
  },
  getSessionScopeSignal() {
    observeBrowserSessionTransition();
    return browserSessionSuperseded || browserSessionInitialized
      ? browserSessionScopeController.signal
      : undefined;
  },
  async refreshSession(expectedSessionScope) {
    if (expectedSessionScope === chikAbsentSessionScope) return undefined;
    await refreshBrowserSession(expectedSessionScope);
    return browserSessionScope === expectedSessionScope
      ? expectedSessionScope
      : undefined;
  },
};

export const push = {
  getPublicKey: () => browserCall<{ publicKey: string }>("/api/push/public-key"),
  async subscribe(subscription: ChikWebPushSubscription, options: WebPushSubscriptionOptions = {}) {
    const registered = await browserCall<{ subscriptionId: string; platform: "web" }>("/api/push/subscribe", { method: "POST", body: JSON.stringify({ platform: "web", endpoint: subscription.endpoint, keys: subscription.toJSON().keys, ...(options.deviceLabel === undefined ? {} : { deviceLabel: options.deviceLabel }) }) });
    activeWebPushSubscription = subscription;
    return registered;
  },
  async unsubscribe(subscription?: ChikWebPushSubscription): Promise<void> {
    const active = subscription ?? activeWebPushSubscription;
    if (!active) return;
    await browserCall("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: active.endpoint }) });
    try { await active.unsubscribe(); } finally { if (active.endpoint === activeWebPushSubscription?.endpoint) activeWebPushSubscription = undefined; }
  },
};

export const auth = {
  signUp: (email: string, password: string) => browserCall<{ user: AuthUser }>("/api/auth/sign-up", { method: "POST", body: JSON.stringify({ email, password }) }),
  signIn: (email: string, password: string) => withBrowserSessionLock(() => {
    beginBrowserSessionTransition();
    return browserSessionCall<AuthSession>("/api/auth/sign-in", { method: "POST", body: JSON.stringify({ email, password }) }, true, "transition");
  }, true),
  requestEmailVerification: () => browserCall<AuthActionAccepted>("/api/auth/send-verification-email", { method: "POST", body: "{}" }),
  verifyEmail: (token: string) => browserCall<{ user: AuthUser }>("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) }),
  requestPasswordReset: (email: string) => browserCall<{ accepted: true }>("/api/auth/send-password-reset", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, password: string) => browserCall<{ user: AuthUser }>("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) }),
  async signOut(subscription?: ChikWebPushSubscription) {
    const active = subscription ?? activeWebPushSubscription;
    const result = await withBrowserSessionLock(async () => {
      const expectedSessionScope = browserSessionScope;
      beginBrowserSessionTransition();
      const init = {
        method: "POST",
        body: JSON.stringify(active ? { pushEndpoint: active.endpoint } : {}),
        ...(expectedSessionScope === undefined
          ? {}
          : { headers: { [chikSessionScopeHeader]: expectedSessionScope } }),
      } satisfies RequestInit;
      let signedOut: { signedOut: true };
      try {
        signedOut = await browserSessionCall<{ signedOut: true }>(browserSignOutPath, init, false, "sign-out");
      } catch (error) {
        if (expectedSessionScope === undefined || !isAuthenticationFailure(error)) throw error;
        await refreshBrowserSessionLocked(expectedSessionScope);
        signedOut = await browserSessionCall<{ signedOut: true }>(browserSignOutPath, init, false, "sign-out");
      }
      return signedOut;
    });
    if (active) { try { await active.unsubscribe(); } catch { /* server sign-out already succeeded */ } finally { if (active.endpoint === activeWebPushSubscription?.endpoint) activeWebPushSubscription = undefined; } }
    return result;
  },
  getSession: () => withBrowserSessionLock(() => browserSessionCall<AuthSession>("/api/auth/session", {}, true, "observe")),
  refreshSession: refreshBrowserSession,
  cookieSessionSource,
  async restoreSession(): Promise<AuthSession | undefined> {
    return withBrowserSessionLock(async () => {
      const oauthPending = browserOAuthPending();
      if (oauthPending) {
        try {
          beginBrowserSessionTransition(oauthPending);
          return await browserSessionCall<AuthSession>(
            chikGitHubOAuthFinalizePath,
            { method: "POST", body: JSON.stringify({ state: oauthPending.state }) },
            true,
            "oauth",
            oauthPending,
          );
        } catch (error) {
          if (error instanceof ChikAuthError && error.status !== 0) {
            clearBrowserOAuthPending(true);
            supersedeBrowserSession();
          }
          throw error;
        }
      }
      assertBrowserSessionCurrent();
      try {
        return await browserSessionCall<AuthSession>(
          "/api/auth/session",
          {},
          true,
          "restore",
        );
      } catch (error) {
        if (!isAuthenticationFailure(error)) throw error;
      }
      const failedScope = browserSessionSuperseded ? undefined : browserSessionScope;
      const failedSignal = cookieSessionSource.getSessionScopeSignal();
      try {
        return await browserSessionCall<AuthSession>(browserRefreshPath, {
          method: "POST",
          ...(failedScope === undefined
            ? {}
            : { headers: { [chikSessionScopeHeader]: failedScope } }),
        }, true, "restore");
      } catch (refreshError) {
        if (isAuthenticationFailure(refreshError)) {
          if (
            browserSessionScope === failedScope
            && cookieSessionSource.getSessionScopeSignal() === failedSignal
          ) {
            if (failedScope === undefined) adoptBrowserSessionScope(undefined, true);
            else supersedeBrowserSession();
          }
          return undefined;
        }
        throw refreshError;
      }
    }, true);
  },
  startGitHub: (returnTo: string) => withBrowserSessionLock(async () => {
    const response = await browserSessionCall<{ authorizationUrl: string; state: string; expiresAt: string }>(
      "/api/auth/github/start",
      { method: "POST", body: JSON.stringify({ returnTo }) },
      true,
      "oauth-start",
    );
    markBrowserOAuthPending(response);
    return response;
  }, true),
  signInCustom: (providerKey: string, credential: string) => withBrowserSessionLock(() => {
    beginBrowserSessionTransition();
    return browserSessionCall<AuthSession>(`/api/auth/custom/${encodeURIComponent(providerKey)}`, { method: "POST", body: JSON.stringify({ credential }) }, false, "transition");
  }, true),
};

export class ChikNativeAuthError extends ChikAuthError {
  constructor(code: ChikAuthErrorCode, message: string, status: number, retryAfterSeconds?: number, options: { cause?: unknown; rawCode?: string } = {}) {
    super(code, message, status, retryAfterSeconds, options);
    this.name = "ChikNativeAuthError";
  }
}
export type ChikNativeAuthUser = AuthUser;
export type ChikNativeAuthSession = AuthSession;
export type ChikNativeAuthActionAccepted = AuthActionAccepted;
export type ChikNativePushPlatform = "apns" | "fcm";
export interface ChikNativePushToken { platform: ChikNativePushPlatform; token: string; deviceLabel?: string | undefined; }
export type ChikNativeCustomIdentityResult = { kind: "challenge"; challenge: unknown } | { kind: "ok"; payload?: unknown | undefined } | { kind: "session"; session: ChikNativeAuthSession };
export interface ChikNativeGitHubOAuthTransaction { authorizationUrl: string; redirectUri: string; expiresAt: string; matchesRedirect(redirectUrl: string): boolean; complete(redirectUrl: string): Promise<ChikNativeAuthSession>; }
interface ChikNativeActiveStoredSession {
  readonly sessionToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly refreshExpiresAt: string;
  /** Opaque scope issued with native sign-in and used only to isolate local resumable state. */
  readonly sessionScope: string;
  readonly invalidated?: undefined;
}
interface ChikNativeCleanupStoredSession {
  /** Opaque scope that blocks credential restoration while local cleanup is pending. */
  readonly sessionScope: string;
  readonly invalidated: true;
}
/** An active native session or a credential-free record that can only resume cleanup. */
export type ChikNativeStoredSession = ChikNativeActiveStoredSession | ChikNativeCleanupStoredSession;
export interface ChikNativeSessionStore {
  /** Stable non-secret key shared by adapters for one physical record; reuse keys within the isolate's bounded registry. */
  readonly coordinationKey?: string | undefined;
  getSession(): Promise<ChikNativeStoredSession | undefined>;
  setSession(session: ChikNativeStoredSession): Promise<void>;
  clearSession(): Promise<void>;
  /** Removes resumable native state owned by one local sign-in session. */
  clearSessionScope(sessionScope: string): Promise<void>;
}
/** @deprecated Use ChikNativeSessionStore. */
export type ChikNativeSessionTokenStore = ChikNativeSessionStore;
export interface ChikNativeAuthOptions { baseUrl: string; sessionStore: ChikNativeSessionStore; fetch?: typeof globalThis.fetch | undefined; }
export type ChikNativeClientOptions = Omit<ChikClientOptions, "baseUrl" | "apiKey" | "sessionToken" | "sessionTokenSource" | "cookieSessionSource">;

const refreshBeforeExpiryMs = 60_000;
const maximumCoordinatedStores = 64;
const maximumPendingSessionCleanups = 64;
interface NativeSessionStoreCoordinator {
  epoch: number;
  operationController: AbortController;
  sessionLease?: Readonly<{ sessionScope: string; controller: AbortController }> | undefined;
  tail: Promise<void>;
  readonly pendingSessionCleanup: Set<string>;
  readonly sessionCleanupInFlight: Set<string>;
  refreshInFlight?: Readonly<{
    sourceEpoch: number;
    sourceController: AbortController;
    epoch: number;
    promise: Promise<AuthSession>;
  }> | undefined;
}
interface NativeSessionStoreCoordinatorReference {
  deref(): NativeSessionStoreCoordinator | undefined;
}
const nativeSessionStoreCoordinators = new Map<string, NativeSessionStoreCoordinatorReference>();
const nativeSessionStoreObjectCoordinators = new WeakMap<ChikNativeSessionStore, NativeSessionStoreCoordinator>();
let nativeSessionStoreCoordinatorFinalizer: FinalizationRegistry<Readonly<{
  coordinationKey: string;
  reference: NativeSessionStoreCoordinatorReference;
}>> | undefined;

function createNativeSessionStoreCoordinator(): NativeSessionStoreCoordinator {
  return {
    epoch: 0,
    operationController: new AbortController(),
    tail: Promise.resolve(),
    pendingSessionCleanup: new Set<string>(),
    sessionCleanupInFlight: new Set<string>(),
  };
}

function boundedNativeSessionStoreCoordinatorReference(
  coordinator: NativeSessionStoreCoordinator,
): NativeSessionStoreCoordinatorReference {
  if (typeof WeakRef === "function") return new WeakRef(coordinator);
  return { deref: () => coordinator };
}

function registerNativeSessionStoreCoordinator(
  coordinationKey: string,
  coordinator: NativeSessionStoreCoordinator,
): void {
  for (const [key, reference] of nativeSessionStoreCoordinators) {
    if (reference.deref() === undefined) nativeSessionStoreCoordinators.delete(key);
  }
  if (nativeSessionStoreCoordinators.size >= maximumCoordinatedStores) {
    throw new ChikNativeAuthError(
      ChikErrorCode.resourceExhausted,
      "Too many native session stores are active in this JavaScript isolate.",
      429,
    );
  }
  const reference = boundedNativeSessionStoreCoordinatorReference(coordinator);
  nativeSessionStoreCoordinators.set(coordinationKey, reference);
  if (typeof WeakRef === "function" && typeof FinalizationRegistry === "function") {
    nativeSessionStoreCoordinatorFinalizer ??= new FinalizationRegistry<Readonly<{
      coordinationKey: string;
      reference: NativeSessionStoreCoordinatorReference;
    }>>(({ coordinationKey: key, reference: finalized }) => {
      if (nativeSessionStoreCoordinators.get(key) === finalized) nativeSessionStoreCoordinators.delete(key);
    });
    nativeSessionStoreCoordinatorFinalizer.register(coordinator, { coordinationKey, reference });
  }
}

function nativeSessionStoreCoordinator(store: ChikNativeSessionStore): NativeSessionStoreCoordinator {
  const coordinationKey = store.coordinationKey?.trim();
  if (store.coordinationKey !== undefined && !coordinationKey) {
    throw new ChikNativeAuthError(ChikErrorCode.invalidArgument, "sessionStore.coordinationKey must not be empty.", 400);
  }
  if (coordinationKey !== undefined) {
    const existing = nativeSessionStoreCoordinators.get(coordinationKey)?.deref();
    if (existing) {
      const reference = nativeSessionStoreCoordinators.get(coordinationKey)!;
      nativeSessionStoreCoordinators.delete(coordinationKey);
      nativeSessionStoreCoordinators.set(coordinationKey, reference);
      return existing;
    }
    const created = createNativeSessionStoreCoordinator();
    registerNativeSessionStoreCoordinator(coordinationKey, created);
    return created;
  }
  const existing = nativeSessionStoreObjectCoordinators.get(store);
  if (existing) return existing;
  const created = createNativeSessionStoreCoordinator();
  nativeSessionStoreObjectCoordinators.set(store, created);
  return created;
}

export function createNativeAuth(options: ChikNativeAuthOptions) {
  type OperationStamp = Readonly<{
    epoch: number;
    sessionScope: string | undefined;
    controller: AbortController;
  }>;
  type SessionTransition = Readonly<{
    stamp: OperationStamp;
    previousSession: ChikNativeActiveStoredSession | undefined;
    preserveSessionScope: boolean;
  }>;
  type InFlight<T> = Readonly<{ stamp: OperationStamp; promise: Promise<T> }>;

  let storedSession: ChikNativeActiveStoredSession | undefined;
  let storedSessionValidated = false;
  let observedEpoch = -1;
  let hydrated = false;
  let hydrateInFlight: InFlight<ChikNativeActiveStoredSession | undefined> | undefined;
  let restoreInFlight: InFlight<AuthSession | undefined> | undefined;
  const sessionStoreCoordinator = nativeSessionStoreCoordinator(options.sessionStore);
  const pendingSessionCleanup = sessionStoreCoordinator.pendingSessionCleanup;
  const sessionCleanupInFlight = sessionStoreCoordinator.sessionCleanupInFlight;

  const call = <T>(path: string, init: RequestInit = {}) => nativeCall<T>(options, path, init);
  const captureStamp = (): OperationStamp => ({
    epoch: sessionStoreCoordinator.epoch,
    sessionScope: observedEpoch === sessionStoreCoordinator.epoch ? storedSession?.sessionScope : undefined,
    controller: sessionStoreCoordinator.operationController,
  });
  const sameCoordinatorStamp = (left: OperationStamp, right: OperationStamp) => left.epoch === right.epoch
    && left.controller === right.controller;
  const sameStamp = (left: OperationStamp, right: OperationStamp) => sameCoordinatorStamp(left, right)
    && left.sessionScope === right.sessionScope;
  const abortedOperation = () => new ChikNativeAuthError(
    ChikErrorCode.aborted,
    ChikErrorMessage.authenticationOperationSuperseded,
    409,
  );
  const assertCoordinatorStamp = (stamp: OperationStamp) => {
    if (stamp.epoch !== sessionStoreCoordinator.epoch || stamp.controller !== sessionStoreCoordinator.operationController) {
      throw abortedOperation();
    }
  };
  const assertStamp = (stamp: OperationStamp) => {
    if (!sameStamp(stamp, captureStamp())) {
      throw new ChikNativeAuthError(
        ChikErrorCode.aborted,
        ChikErrorMessage.authenticationOperationSuperseded,
        409,
      );
    }
  };
  const queueSessionStore = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = sessionStoreCoordinator.tail.then(operation);
    sessionStoreCoordinator.tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const invalidateSessionLease = (sessionScope?: string) => {
    const lease = sessionStoreCoordinator.sessionLease;
    if (!lease || (sessionScope !== undefined && lease.sessionScope !== sessionScope)) return;
    lease.controller.abort();
    sessionStoreCoordinator.sessionLease = undefined;
  };
  const ensureSessionLease = (sessionScope: string) => {
    const lease = sessionStoreCoordinator.sessionLease;
    if (lease?.sessionScope === sessionScope) return lease;
    lease?.controller.abort();
    const next = { sessionScope, controller: new AbortController() };
    sessionStoreCoordinator.sessionLease = next;
    return next;
  };
  const advanceCoordinator = (expectedStamp?: OperationStamp): OperationStamp => {
    if (expectedStamp !== undefined) assertStamp(expectedStamp);
    sessionStoreCoordinator.operationController.abort();
    sessionStoreCoordinator.epoch += 1;
    sessionStoreCoordinator.operationController = new AbortController();
    storedSessionValidated = false;
    return captureStamp();
  };
  const forgetLocalSession = (stamp: OperationStamp): OperationStamp => {
    assertCoordinatorStamp(stamp);
    storedSession = undefined;
    storedSessionValidated = false;
    observedEpoch = stamp.epoch;
    hydrated = true;
    return captureStamp();
  };
  const rememberPendingSessionCleanup = (sessionScope: string) => {
    if (pendingSessionCleanup.has(sessionScope)) return;
    while (pendingSessionCleanup.size >= maximumPendingSessionCleanups) {
      const oldestScope = pendingSessionCleanup.values().next().value as string | undefined;
      if (oldestScope === undefined) break;
      pendingSessionCleanup.delete(oldestScope);
    }
    pendingSessionCleanup.add(sessionScope);
  };
  const schedulePendingSessionCleanup = () => {
    for (const sessionScope of pendingSessionCleanup) {
      if (sessionCleanupInFlight.has(sessionScope)) continue;
      if (sessionCleanupInFlight.size >= maximumPendingSessionCleanups) break;
      sessionCleanupInFlight.add(sessionScope);
      const pending = Promise.resolve().then(() => options.sessionStore.clearSessionScope(sessionScope));
      void pending.then(
        () => { pendingSessionCleanup.delete(sessionScope); },
        () => { /* Retried opportunistically without blocking canonical session mutations. */ },
      ).then(() => { sessionCleanupInFlight.delete(sessionScope); });
    }
  };
  const markStoredSessionForCleanup = async (
    session: ChikNativeActiveStoredSession,
    failures: unknown[],
    trackSessionScope = true,
  ) => {
    if (trackSessionScope) rememberPendingSessionCleanup(session.sessionScope);
    try {
      await options.sessionStore.setSession({ sessionScope: session.sessionScope, invalidated: true });
    } catch (error) {
      failures.push(error);
    }
  };
  const forceClearStoredSession = async (sessionScope: string, failures: unknown[]) => {
    invalidateSessionLease(sessionScope);
    rememberPendingSessionCleanup(sessionScope);
    try {
      await options.sessionStore.clearSession();
    } catch (error) {
      failures.push(error);
    }
    schedulePendingSessionCleanup();
  };
  const revokeAndForceClearStoredSession = async (
    session: ChikNativeActiveStoredSession,
    failures: unknown[],
    pushToken?: string,
  ) => {
    try {
      await call<{ signedOut: true }>("/api/auth/sign-out", {
        method: "POST",
        body: JSON.stringify({ refreshToken: session.refreshToken, ...(pushToken ? { pushEndpoint: pushToken } : {}) }),
      });
    } catch (error) {
      if (!isAuthenticationFailure(error)) failures.push(error);
    }
    await forceClearStoredSession(session.sessionScope, failures);
  };
  const clearInvalidStoredSession = async (sessionScope: string | undefined) => {
    const failures: unknown[] = [];
    if (sessionScope !== undefined) {
      invalidateSessionLease(sessionScope);
      rememberPendingSessionCleanup(sessionScope);
      try {
        await options.sessionStore.setSession({ sessionScope, invalidated: true });
      } catch (error) {
        failures.push(error);
      }
      try { await options.sessionStore.clearSession(); } catch (error) { failures.push(error); }
      schedulePendingSessionCleanup();
    } else {
      invalidateSessionLease();
      try { await options.sessionStore.clearSession(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw nativeError(ChikErrorCode.storageError, new AggregateError(failures, "The invalid local session could not be cleared."), 0);
    }
  };
  const loadPersistedSession = async (stamp: OperationStamp): Promise<ChikNativeActiveStoredSession | undefined> => {
    assertCoordinatorStamp(stamp);
    let value: ChikNativeStoredSession | undefined;
    try { value = await options.sessionStore.getSession(); } catch (error) {
      assertCoordinatorStamp(stamp);
      throw nativeError(ChikErrorCode.storageError, error, 0);
    }
    assertCoordinatorStamp(stamp);
    if (value === undefined && pendingSessionCleanup.size > 0) {
      schedulePendingSessionCleanup();
      return undefined;
    }
    const normalized = normalizeStoredSession(value);
    if (normalized && pendingSessionCleanup.has(normalized.sessionScope)) {
      await clearInvalidStoredSession(normalized.sessionScope);
      assertCoordinatorStamp(stamp);
      return undefined;
    }
    if (value !== undefined && !normalized) {
      await clearInvalidStoredSession(storedSessionScope(value));
      assertCoordinatorStamp(stamp);
      return undefined;
    }
    return normalized;
  };
  const prepareSessionTransition = async (
    expectedStamp?: OperationStamp,
    pushToken?: string,
    preserveSessionScope = false,
  ): Promise<SessionTransition> => {
    const transitionStamp = advanceCoordinator(expectedStamp);
    return queueSessionStore(async () => {
      const previousSession = await loadPersistedSession(transitionStamp);
      if (!previousSession) {
        if (!preserveSessionScope) invalidateSessionLease();
        return { stamp: forgetLocalSession(transitionStamp), previousSession: undefined, preserveSessionScope };
      }
      if (!preserveSessionScope) invalidateSessionLease(previousSession.sessionScope);
      const failures: unknown[] = [];
      await markStoredSessionForCleanup(previousSession, failures, !preserveSessionScope);
      if (failures.length > 0) {
        invalidateSessionLease(previousSession.sessionScope);
        await revokeAndForceClearStoredSession(previousSession, failures, pushToken);
        if (transitionStamp.epoch === sessionStoreCoordinator.epoch) forgetLocalSession(transitionStamp);
        throw nativeError(ChikErrorCode.storageError, new AggregateError(failures, "The local session could not be invalidated."), 0);
      }
      if (!preserveSessionScope) schedulePendingSessionCleanup();
      assertCoordinatorStamp(transitionStamp);
      return { stamp: forgetLocalSession(transitionStamp), previousSession, preserveSessionScope };
    });
  };
  const cleanupSessionTransition = async (transition: SessionTransition): Promise<void> => queueSessionStore(async () => {
    if (transition.stamp.epoch !== sessionStoreCoordinator.epoch
      || transition.stamp.controller !== sessionStoreCoordinator.operationController) return;
    const failures: unknown[] = [];
    if (transition.preserveSessionScope && transition.previousSession) {
      invalidateSessionLease(transition.previousSession.sessionScope);
      rememberPendingSessionCleanup(transition.previousSession.sessionScope);
    }
    try { await options.sessionStore.clearSession(); } catch (error) { failures.push(error); }
    schedulePendingSessionCleanup();
    assertStamp(transition.stamp);
    if (failures.length > 0) {
      throw nativeError(ChikErrorCode.storageError, new AggregateError(failures, "The local session could not be cleared."), 0);
    }
  });
  const hydrate = async (stamp: OperationStamp = captureStamp()): Promise<ChikNativeActiveStoredSession | undefined> => {
    let currentStamp = stamp;
    const sharedRefresh = sessionStoreCoordinator.refreshInFlight;
    if (sharedRefresh && sharedRefresh.epoch === currentStamp.epoch
      && (observedEpoch !== currentStamp.epoch || storedSession === undefined)) {
      await sharedRefresh.promise;
      assertCoordinatorStamp(currentStamp);
      currentStamp = captureStamp();
    }
    if (hydrated && observedEpoch === currentStamp.epoch) {
      assertStamp(currentStamp);
      return storedSession;
    }
    if (!hydrateInFlight || !sameCoordinatorStamp(hydrateInFlight.stamp, currentStamp)) {
      const pending = queueSessionStore(async () => {
        const normalized = await loadPersistedSession(currentStamp);
        assertCoordinatorStamp(currentStamp);
        storedSession = normalized;
        storedSessionValidated = false;
        observedEpoch = currentStamp.epoch;
        hydrated = true;
        return storedSession;
      });
      const inFlight = { stamp: currentStamp, promise: pending };
      hydrateInFlight = inFlight;
      void pending.then(
        () => { if (hydrateInFlight === inFlight) hydrateInFlight = undefined; },
        () => { if (hydrateInFlight === inFlight) hydrateInFlight = undefined; },
      );
    }
    return hydrateInFlight!.promise;
  };
  const operationRequest = (stamp: OperationStamp, init: RequestInit): Readonly<{
    init: RequestInit;
    release(): void;
  }> => {
    const operationSignal = stamp.controller.signal;
    const callerSignal = init.signal ?? undefined;
    if (!callerSignal || callerSignal === operationSignal) {
      return { init: { ...init, signal: operationSignal }, release: () => {} };
    }
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    if (operationSignal.aborted || callerSignal.aborted) abort();
    else {
      operationSignal.addEventListener("abort", abort, { once: true });
      callerSignal.addEventListener("abort", abort, { once: true });
    }
    return {
      init: { ...init, signal: controller.signal },
      release() {
        operationSignal.removeEventListener("abort", abort);
        callerSignal.removeEventListener("abort", abort);
      },
    };
  };
  const callForStamp = async <T>(stamp: OperationStamp, path: string, init: RequestInit = {}): Promise<T> => {
    assertStamp(stamp);
    const request = operationRequest(stamp, init);
    let value: T;
    try { value = await call<T>(path, request.init); } catch (error) {
      assertStamp(stamp);
      throw error;
    } finally {
      request.release();
    }
    assertStamp(stamp);
    return value;
  };
  const commitSession = async (response: NativeSignInResponse, transition: SessionTransition, sessionScope?: string): Promise<AuthSession> => {
    assertStamp(transition.stamp);
    if (!response || typeof response !== "object") {
      await cleanupSessionTransition(transition);
      throw new ChikNativeAuthError(ChikErrorCode.invalidResponse, "The sign-in response does not contain a complete session.", 502);
    }
    const issuedSessionScope = nonEmptyString(response.sessionScope);
    if (response.sessionScope !== undefined && (!issuedSessionScope || !/^[a-f0-9]{64}$/u.test(issuedSessionScope))) {
      await cleanupSessionTransition(transition);
      throw new ChikNativeAuthError(ChikErrorCode.invalidResponse, "The sign-in response does not contain a valid session scope.", 502);
    }
    if (sessionScope !== undefined && issuedSessionScope !== undefined && issuedSessionScope !== sessionScope) {
      await cleanupSessionTransition(transition);
      throw new ChikNativeAuthError(ChikErrorCode.invalidResponse, "The refreshed session scope does not match the current session.", 502);
    }
    const credentials = normalizeStoredSession({
      ...response,
      sessionScope: sessionScope ?? issuedSessionScope,
    });
    if (!sessionScope && !issuedSessionScope) {
      await cleanupSessionTransition(transition);
      throw new ChikNativeAuthError(ChikErrorCode.invalidResponse, "The sign-in response does not contain a valid session scope.", 502);
    }
    if (!credentials) {
      await cleanupSessionTransition(transition);
      throw new ChikNativeAuthError(ChikErrorCode.invalidResponse, "The sign-in response does not contain a complete session.", 502);
    }
    return queueSessionStore(async () => {
      assertStamp(transition.stamp);
      try { await options.sessionStore.setSession(credentials); } catch (error) {
        if (transition.stamp.epoch !== sessionStoreCoordinator.epoch
          || transition.stamp.controller !== sessionStoreCoordinator.operationController) throw abortedOperation();
        const failures: unknown[] = [error];
        invalidateSessionLease(credentials.sessionScope);
        rememberPendingSessionCleanup(credentials.sessionScope);
        forgetLocalSession(transition.stamp);
        let invalidatedDurably = false;
        try {
          await options.sessionStore.clearSession();
          invalidatedDurably = true;
        } catch (clearError) {
          failures.push(clearError);
        }
        if (!invalidatedDurably) {
          try {
            await options.sessionStore.setSession({ sessionScope: credentials.sessionScope, invalidated: true });
            invalidatedDurably = true;
          } catch (tombstoneError) {
            failures.push(tombstoneError);
          }
        }
        if (!invalidatedDurably) {
          try {
            await call<{ signedOut: true }>("/api/auth/sign-out", {
              method: "POST",
              body: JSON.stringify({ refreshToken: credentials.refreshToken }),
            });
          } catch (revokeError) {
            if (!isAuthenticationFailure(revokeError)) failures.push(revokeError);
          }
        }
        schedulePendingSessionCleanup();
        throw nativeError(ChikErrorCode.storageError, new AggregateError(failures, "The local session could not be persisted safely."), 0);
      }
      assertStamp(transition.stamp);
      storedSession = credentials;
      storedSessionValidated = true;
      observedEpoch = transition.stamp.epoch;
      hydrated = true;
      ensureSessionLease(credentials.sessionScope);
      schedulePendingSessionCleanup();
      return { user: response.user, expiresAt: credentials.expiresAt, refreshExpiresAt: credentials.refreshExpiresAt };
    });
  };
  const rememberCurrentSession = (value: AuthSession): AuthSession => ({ ...value, ...(storedSession ? { refreshExpiresAt: storedSession.refreshExpiresAt } : {}) });
  const synchronizeSharedRefresh = async (result: AuthSession, refreshEpoch: number): Promise<AuthSession> => {
    if (sessionStoreCoordinator.epoch !== refreshEpoch) throw abortedOperation();
    if (observedEpoch !== refreshEpoch || !storedSessionValidated) {
      hydrated = false;
      const stamp = captureStamp();
      const credentials = await hydrate(stamp);
      assertCoordinatorStamp(stamp);
      if (!credentials) throw new ChikNativeAuthError(ChikErrorCode.unauthenticated, ChikErrorMessage.customerSessionRequired, 401);
      storedSessionValidated = true;
      ensureSessionLease(credentials.sessionScope);
    }
    return rememberCurrentSession(result);
  };
  async function refreshSessionForStamp(expectedStamp?: OperationStamp): Promise<AuthSession> {
    const shared = sessionStoreCoordinator.refreshInFlight;
    if (shared && shared.epoch === sessionStoreCoordinator.epoch) {
      if (expectedStamp !== undefined
        && (expectedStamp.epoch !== shared.sourceEpoch || expectedStamp.controller !== shared.sourceController)) {
        throw abortedOperation();
      }
      return shared.promise.then((result) => synchronizeSharedRefresh(result, shared.epoch));
    }
    if (expectedStamp !== undefined) assertStamp(expectedStamp);
    const sourceEpoch = sessionStoreCoordinator.epoch;
    const sourceController = sessionStoreCoordinator.operationController;
    const refreshEpoch = sourceEpoch + 1;
    const pending = (async (): Promise<AuthSession> => {
      const transition = await prepareSessionTransition(expectedStamp, undefined, true);
      const credentials = transition.previousSession;
      if (!credentials || !isFutureTimestamp(credentials.refreshExpiresAt)) {
        await cleanupSessionTransition(transition);
        throw new ChikNativeAuthError(ChikErrorCode.unauthenticated, "The customer session has expired.", 401);
      }
      let response: NativeSignInResponse;
      try {
        response = await callForStamp<NativeSignInResponse>(transition.stamp, "/api/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: credentials.refreshToken }) });
      } catch (error) {
        await cleanupSessionTransition(transition);
        throw error;
      }
      return commitSession(response, transition, credentials.sessionScope);
    })();
    const inFlight = { sourceEpoch, sourceController, epoch: refreshEpoch, promise: pending };
    sessionStoreCoordinator.refreshInFlight = inFlight;
    void pending.then(
      () => { if (sessionStoreCoordinator.refreshInFlight === inFlight) sessionStoreCoordinator.refreshInFlight = undefined; },
      () => { if (sessionStoreCoordinator.refreshInFlight === inFlight) sessionStoreCoordinator.refreshInFlight = undefined; },
    );
    return pending.then((result) => synchronizeSharedRefresh(result, refreshEpoch));
  }
  const currentTokenState = async (expectedStamp?: OperationStamp): Promise<{ token: string | undefined; stamp: OperationStamp }> => {
    const credentials = await hydrate(expectedStamp);
    let stamp = captureStamp();
    if (expectedStamp !== undefined) assertStamp(expectedStamp);
    if (!credentials) return { token: undefined, stamp };
    if (!isFutureTimestamp(credentials.refreshExpiresAt)) {
      const transition = await prepareSessionTransition(stamp);
      await cleanupSessionTransition(transition);
      return { token: undefined, stamp: captureStamp() };
    }
    if (!isFutureTimestamp(credentials.expiresAt, refreshBeforeExpiryMs)) {
      await refreshSessionForStamp(stamp);
      stamp = captureStamp();
    }
    return { token: storedSession?.sessionToken, stamp };
  };
  const currentToken = async (): Promise<string | undefined> => (await currentTokenState()).token;
  const requireTokenState = async (expectedStamp?: OperationStamp) => {
    const state = await currentTokenState(expectedStamp);
    assertStamp(state.stamp);
    if (!state.token) throw new ChikNativeAuthError(ChikErrorCode.unauthenticated, ChikErrorMessage.customerSessionRequired, 401);
    return { token: state.token, stamp: state.stamp };
  };
  const getSessionForStamp = async (expectedStamp?: OperationStamp): Promise<AuthSession> => {
    const request = async (state: { token: string; stamp: OperationStamp }) => {
      const value = await callForStamp<AuthSession>(state.stamp, "/api/auth/session", { headers: { authorization: `Bearer ${state.token}` } });
      if (!storedSessionValidated) {
        assertStamp(state.stamp);
        storedSessionValidated = true;
        if (storedSession) ensureSessionLease(storedSession.sessionScope);
      }
      return rememberCurrentSession(value);
    };
    let state = await requireTokenState(expectedStamp);
    try { return await request(state); }
    catch (error) {
      if (!isAuthenticationFailure(error)) throw error;
      await refreshSessionForStamp(state.stamp);
      state = await requireTokenState();
      return request(state);
    }
  };
  const getSession = (): Promise<AuthSession> => getSessionForStamp();
  const refreshSession = (): Promise<AuthSession> => refreshSessionForStamp();
  const restoreSession = async (): Promise<AuthSession | undefined> => {
    await hydrate();
    const stamp = captureStamp();
    if (restoreInFlight && sameStamp(restoreInFlight.stamp, stamp)) return restoreInFlight.promise;
    const pending = (async () => {
      if (!storedSession) return undefined;
      try { return await getSessionForStamp(stamp); }
      catch (error) { if (isAuthenticationFailure(error)) return undefined; throw error; }
    })();
    const inFlight = { stamp, promise: pending };
    restoreInFlight = inFlight;
    try { return await pending; } finally { if (restoreInFlight === inFlight) restoreInFlight = undefined; }
  };
  const tokenSource: ChikSessionTokenSource = {
    getSessionToken: () => storedSessionValidated && observedEpoch === sessionStoreCoordinator.epoch ? storedSession?.sessionToken : undefined,
    getSessionScope: () => {
      const lease = sessionStoreCoordinator.sessionLease;
      return lease && !lease.controller.signal.aborted ? lease.sessionScope : undefined;
    },
    getSessionScopeSignal: () => {
      const lease = sessionStoreCoordinator.sessionLease;
      return lease && !lease.controller.signal.aborted ? lease.controller.signal : undefined;
    },
    async refreshSession(expectedSessionScope) {
      const lease = sessionStoreCoordinator.sessionLease;
      if (
        !lease
        || lease.controller.signal.aborted
        || lease.sessionScope !== expectedSessionScope
      ) throw abortedOperation();
      const stamp = captureStamp();
      await refreshSessionForStamp(stamp);
      if (
        lease.controller.signal.aborted
        || sessionStoreCoordinator.sessionLease !== lease
      ) throw abortedOperation();
      return tokenSource.getSessionToken();
    },
  };
  const waitForRequest = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) throw signal.reason ?? Object.assign(new Error(), { name: "AbortError" });
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const onAbort = () => rejectAbort?.(signal.reason ?? Object.assign(new Error(), { name: "AbortError" }));
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  };
  const clientFetch = (fetchImplementation: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("authorization")) {
      const expectedSessionScope = tokenSource.getSessionScope?.();
      const expectedSessionSignal = tokenSource.getSessionScopeSignal?.();
      const sharedRefresh = sessionStoreCoordinator.refreshInFlight;
      if (
        sharedRefresh
        && sharedRefresh.epoch === sessionStoreCoordinator.epoch
        && expectedSessionScope !== undefined
      ) {
        const refreshed = await waitForRequest(sharedRefresh.promise, init.signal ?? undefined);
        await synchronizeSharedRefresh(refreshed, sharedRefresh.epoch);
      }
      if (
        expectedSessionScope !== undefined
        && (
          expectedSessionSignal?.aborted
          || tokenSource.getSessionScope?.() !== expectedSessionScope
          || tokenSource.getSessionScopeSignal?.() !== expectedSessionSignal
        )
      ) throw abortedOperation();
      const token = tokenSource.getSessionToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    return fetchImplementation(input, { ...init, headers });
  };
  const clientOptions = async (input: ChikNativeClientOptions = {}): Promise<ChikClientOptions> => {
    await hydrate();
    if (storedSession && !storedSessionValidated) await restoreSession();
    await currentToken();
    return {
      ...input,
      baseUrl: options.baseUrl,
      sessionTokenSource: tokenSource,
      fetch: clientFetch(input.fetch ?? globalThis.fetch),
    };
  };
  const startGitHubNative = async (): Promise<ChikNativeGitHubOAuthTransaction> => {
    const transactionStamp = captureStamp();
    const start = await callForStamp<NativeOAuthStart>(transactionStamp, "/api/auth/native/github/start", { method: "POST", body: "{}" });
    if (!start.authorizationUrl || !start.state || !start.browserNonce || !start.expiresAt || !start.redirectUri) throw new ChikNativeAuthError(ChikErrorCode.invalidResponse, "The authorization response is invalid.", 502);
    const pkceVerifier = nonEmptyString(start.pkceVerifier);
    let completed = false;
    return { authorizationUrl: start.authorizationUrl, redirectUri: start.redirectUri, expiresAt: start.expiresAt, matchesRedirect: (redirect) => validRedirect(redirect, start.redirectUri, start.state), async complete(redirect) {
      if (completed) throw new ChikNativeAuthError(ChikErrorCode.failedPrecondition, "The authorization flow is already complete.", 412);
      assertStamp(transactionStamp);
      const value = redirectValues(redirect, start.redirectUri, start.state);
      completed = true;
      const transition = await prepareSessionTransition(transactionStamp);
      let response: NativeSignInResponse;
      try {
        response = await callForStamp<NativeSignInResponse>(transition.stamp, "/api/auth/native/github/complete", { method: "POST", body: JSON.stringify({ code: value.code, state: value.state, browserNonce: start.browserNonce, ...(pkceVerifier ? { pkceVerifier } : {}) }) });
      } catch (error) {
        await cleanupSessionTransition(transition);
        throw error;
      }
      return commitSession(response, transition);
    } };
  };
  return {
    signUp: (email: string, password: string) => call<{ user: AuthUser }>("/api/auth/sign-up", { method: "POST", body: JSON.stringify({ email, password }) }),
    async signIn(email: string, password: string): Promise<AuthSession> {
      const transition = await prepareSessionTransition();
      let response: NativeSignInResponse;
      try {
        response = await callForStamp<NativeSignInResponse>(transition.stamp, "/api/auth/native/sign-in", { method: "POST", body: JSON.stringify({ email, password }) });
      } catch (error) {
        await cleanupSessionTransition(transition);
        throw error;
      }
      return commitSession(response, transition);
    },
    getSession,
    restoreSession,
    refreshSession,
    onAppForeground: restoreSession,
    /** Retained for lifecycle symmetry; native refresh is request- and foreground-driven. */
    dispose: () => {},
    async signOut(pushToken?: string): Promise<{ signedOut: true }> {
      const transition = await prepareSessionTransition(undefined, pushToken);
      const credentials = transition.previousSession;
      if (!credentials) {
        return { signedOut: true };
      }
      let result: { signedOut: true };
      try {
        result = await callForStamp<{ signedOut: true }>(transition.stamp, "/api/auth/sign-out", {
          method: "POST",
          body: JSON.stringify({ refreshToken: credentials.refreshToken, ...(pushToken ? { pushEndpoint: pushToken } : {}) }),
        });
      } catch (error) {
        await cleanupSessionTransition(transition);
        if (isAuthenticationFailure(error)) return { signedOut: true };
        throw error;
      }
      await cleanupSessionTransition(transition);
      return result;
    },
    async requestEmailVerification(): Promise<AuthActionAccepted> {
      const { token, stamp } = await requireTokenState();
      return callForStamp<AuthActionAccepted>(stamp, "/api/auth/send-verification-email", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    },
    verifyEmail: (token: string) => call<{ user: AuthUser }>("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) }),
    requestPasswordReset: (email: string) => call<{ accepted: true }>("/api/auth/send-password-reset", { method: "POST", body: JSON.stringify({ email }) }),
    resetPassword: (token: string, password: string) => call<{ user: AuthUser }>("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) }),
    async signInCustom(providerKey: string, credential: string): Promise<ChikNativeCustomIdentityResult> {
      const { token, stamp } = await currentTokenState();
      const transition = await prepareSessionTransition(stamp);
      let value: unknown;
      try {
        value = await callForStamp<unknown>(transition.stamp, `/api/auth/native/custom/${encodeURIComponent(providerKey)}`, { method: "POST", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), body: JSON.stringify({ credential }) });
      } catch (error) {
        await cleanupSessionTransition(transition);
        throw error;
      }
      if (value && typeof value === "object" && "challenge" in value) {
        await cleanupSessionTransition(transition);
        return { kind: "challenge", challenge: (value as { challenge: unknown }).challenge };
      }
      if (value && typeof value === "object" && (value as { ok?: unknown }).ok === true) {
        await cleanupSessionTransition(transition);
        return { kind: "ok", ...("payload" in value ? { payload: (value as { payload: unknown }).payload } : {}) };
      }
      return { kind: "session", session: await commitSession(value as NativeSignInResponse, transition) };
    },
    startGitHub: startGitHubNative,
    startGitHubNative,
    async registerPushToken(input: ChikNativePushToken): Promise<{ subscriptionId: string; platform: ChikNativePushPlatform }> {
      const { token, stamp } = await requireTokenState();
      return callForStamp<{ subscriptionId: string; platform: ChikNativePushPlatform }>(stamp, "/api/push/subscribe", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ platform: validPushPlatform(input.platform), endpoint: validPushToken(input.token), ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }) }) });
    },
    async unregisterPushToken(pushToken: string): Promise<{ unsubscribed: true }> {
      const { token, stamp } = await requireTokenState();
      return callForStamp<{ unsubscribed: true }>(stamp, "/api/push/unsubscribe", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ endpoint: validPushToken(pushToken) }) });
    },
    clientOptions,
    async createClient(input: ChikNativeClientOptions = {}) {
      await restoreSession();
      return createChikClientRuntime(await clientOptions(input));
    },
  };
}

interface NativeSignInResponse {
  user: AuthUser;
  sessionToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  sessionScope?: string;
}
interface NativeOAuthStart { authorizationUrl: string; state: string; browserNonce: string; expiresAt: string; redirectUri: string; pkceVerifier?: string | undefined; }

function normalizeStoredSession(value: unknown): ChikNativeActiveStoredSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.invalidated !== undefined) return undefined;
  const sessionToken = nonEmptyString(record.sessionToken);
  const refreshToken = nonEmptyString(record.refreshToken);
  const expiresAt = nonEmptyString(record.expiresAt);
  const refreshExpiresAt = nonEmptyString(record.refreshExpiresAt);
  const sessionScope = nonEmptyString(record.sessionScope);
  if (!sessionToken || !refreshToken || !expiresAt || !refreshExpiresAt
    || !sessionScope || !/^[a-f0-9]{64}$/u.test(sessionScope)
    || timestampMilliseconds(expiresAt) === undefined || timestampMilliseconds(refreshExpiresAt) === undefined) return undefined;
  return { sessionToken, refreshToken, expiresAt, refreshExpiresAt, sessionScope };
}

function storedSessionScope(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionScope = nonEmptyString((value as Record<string, unknown>).sessionScope);
  return sessionScope !== undefined && /^[a-f0-9]{64}$/u.test(sessionScope) ? sessionScope : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampMilliseconds(value: string): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function isFutureTimestamp(value: string, leadTimeMs = 0): boolean {
  const milliseconds = timestampMilliseconds(value);
  return milliseconds !== undefined && milliseconds > Date.now() + leadTimeMs;
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof ChikAuthError && (error.status === 401 || error.status === 403);
}

async function browserCall<T>(path: string, init: RequestInit = {}, allowSuperseded = false): Promise<T> {
  const headers = new Headers(init.headers);
  let lease: BrowserSessionLease | undefined;
  if (allowSuperseded) requireBrowserSessionCoordination();
  else {
    lease = captureBrowserSessionLease();
    const expectedScope = browserRequestSessionScope();
    if (expectedScope !== undefined) headers.set(chikSessionScopeHeader, expectedScope);
  }
  return authRequest<T>(path, { ...init, headers }, { credentials: "include", lease });
}

async function browserSessionCall<T>(
  path: string,
  init: RequestInit = {},
  scopeRequired = true,
  scopeMode: "observe" | "restore" | "transition" | "sign-out" | "oauth-start" | "oauth" = "observe",
  oauthPending?: BrowserOAuthPending,
): Promise<T> {
  const headers = new Headers(init.headers);
  let lease: BrowserSessionLease | undefined;
  if (scopeMode === "transition" || scopeMode === "sign-out" || scopeMode === "oauth-start" || scopeMode === "oauth") requireBrowserSessionCoordination();
  else lease = captureBrowserSessionLease();
  const expectedScope = browserRequestSessionScope();
  if (scopeMode !== "transition" && scopeMode !== "oauth" && expectedScope !== undefined && !headers.has(chikSessionScopeHeader)) {
    headers.set(chikSessionScopeHeader, expectedScope);
  }
  return authRequest<T>(path, { ...init, headers }, {
    credentials: "include",
    onResponse(response) {
      if (!response.ok) return;
      const scope = response.headers.get(chikSessionScopeHeader)?.trim();
      if (!scope && scopeRequired) {
        supersedeBrowserSession();
        throw supersededBrowserSession();
      }
      if (scopeMode === "transition") {
        if (scope === chikAbsentSessionScope) {
          supersedeBrowserSession();
          throw browserSessionCoordinationError();
        }
        if (scope) completeBrowserSessionTransition(scope);
        return;
      }
      if (scopeMode === "sign-out") {
        completeBrowserSessionTransition(undefined);
        return;
      }
      if (scopeMode === "oauth-start") {
        const nextScope = scope === chikAbsentSessionScope ? undefined : scope;
        if (browserSessionInitialized) {
          if (nextScope !== browserSessionScope) {
            supersedeBrowserSession();
            throw supersededBrowserSession();
          }
          adoptBrowserSessionScope(nextScope, true);
        }
        return;
      }
      if (scopeMode === "oauth") {
        if (!oauthPending) throw browserSessionCoordinationError();
        if (scope === chikAbsentSessionScope) {
          supersedeBrowserSession();
          throw browserSessionCoordinationError();
        }
        clearBrowserOAuthPending(true);
        completeBrowserSessionTransition(scope || undefined);
        return;
      }
      if (scopeMode === "restore") {
        if (scope) adoptBrowserSessionScope(scope, true);
        return;
      }
      assertBrowserSessionCurrent();
      if (scope && browserSessionScope !== undefined && scope !== browserSessionScope) {
        supersedeBrowserSession();
        throw supersededBrowserSession();
      }
      if (scope) adoptBrowserSessionScope(scope);
    },
    lease,
  });
}
async function nativeCall<T>(options: ChikNativeAuthOptions, path: string, init: RequestInit = {}): Promise<T> { return authRequest<T>(new URL(path, nativeOrigin(options.baseUrl)).toString(), init, { fetch: options.fetch ?? globalThis.fetch, redirect: "error" }); }
async function authRequest<T>(path: string, init: RequestInit, extra: RequestInit & {
  fetch?: typeof globalThis.fetch;
  onResponse?: ((response: Response) => void) | undefined;
  lease?: BrowserSessionLease | undefined;
}): Promise<T> {
	const headers = new Headers(init.headers); if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
	let response: Response;
	const { fetch: fetchImplementation = globalThis.fetch, onResponse, lease, ...requestExtra } = extra;
	const signal = combinedBrowserSessionSignal(init.signal, lease?.signal);
	try { response = await fetchImplementation(path, { ...requestExtra, ...init, headers, ...(signal ? { signal } : {}) }); } catch (error) {
		if (lease?.signal.aborted) throw supersededBrowserSession();
		throw nativeError(ChikErrorCode.networkFailure, error, 0);
	}
	if (!lease) onResponse?.(response);
	const text = await response.text().catch((error) => {
		if (lease?.signal.aborted) throw supersededBrowserSession();
		throw nativeError(ChikErrorCode.networkFailure, error, 0);
	});
  let value: unknown = {};
  try { value = text ? JSON.parse(text) as unknown : {}; } catch { if (response.ok) throw new ChikAuthError(ChikErrorCode.invalidResponse, "The response is not valid JSON.", response.status); }
	assertBrowserSessionLeaseCurrent(lease);
	if (lease) onResponse?.(response);
  if (!response.ok) { const body = value && typeof value === "object" ? value as { code?: unknown; message?: unknown } : {}; const code = isChikProtocolErrorCode(body.code) ? body.code : ChikErrorCode.unknown; const rawCode = typeof body.code === "string" && !isChikProtocolErrorCode(body.code) && body.code !== ChikErrorCode.unknown ? body.code : undefined; throw new ChikAuthError(code, typeof body.message === "string" ? body.message : `HTTP ${response.status}`, response.status, retryAfter(response.headers.get("retry-after")), { rawCode }); }
  return value as T;
}
function combinedBrowserSessionSignal(caller: AbortSignal | null | undefined, session: AbortSignal | undefined): AbortSignal | undefined { if (!caller) return session; if (!session) return caller; return AbortSignal.any([caller, session]); }
function nativeOrigin(baseUrl: string): string { const url = new URL(baseUrl); if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) throw new ChikNativeAuthError(ChikErrorCode.invalidArgument, "baseUrl must be an absolute HTTP deployment origin.", 400); return url.origin; }
function nativeError(code: ChikErrorCode, error: unknown, status: number): ChikNativeAuthError { return new ChikNativeAuthError(code, error instanceof Error ? error.message : "The request failed.", status, undefined, { cause: error }); }
function retryAfter(value: string | null): number | undefined { const seconds = value && /^\d{1,5}$/u.test(value) ? Number(value) : NaN; return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400 ? seconds : undefined; }
function redirectValues(redirect: string, expected: string, state: string): { code: string; state: string } { const received = new URL(redirect); const target = new URL(expected); if (received.origin !== target.origin || received.pathname !== target.pathname || received.username || received.password || received.hash) throw new ChikNativeAuthError(ChikErrorCode.permissionDenied, "The redirect URL does not match this transaction.", 403); const codes = received.searchParams.getAll("code"); const states = received.searchParams.getAll("state"); const code = codes.length === 1 ? codes[0]?.trim() : undefined; const actual = states.length === 1 ? states[0]?.trim() : undefined; if (!code || !actual || actual !== state) throw new ChikNativeAuthError(ChikErrorCode.unauthenticated, "The authorization state is invalid.", 401); return { code, state: actual }; }
function validRedirect(redirect: string, expected: string, state: string): boolean { try { redirectValues(redirect, expected, state); return true; } catch { return false; } }
function validPushToken(token: string): string { const value = token.trim(); if (!value || value.length > 2048 || /\p{Cc}/u.test(value)) throw new ChikNativeAuthError(ChikErrorCode.invalidArgument, "The push token is invalid.", 400); return value; }
function validPushPlatform(value: ChikNativePushPlatform): ChikNativePushPlatform { if (value !== "apns" && value !== "fcm") throw new ChikNativeAuthError(ChikErrorCode.invalidArgument, "The push platform is invalid.", 400); return value; }
