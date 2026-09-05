import { createElement, useSyncExternalStore, type ReactElement } from "react";
import { ActivityIndicator, Button, Linking, Modal, NativeModules, Platform, View } from "react-native";
import * as Keychain from "react-native-keychain";
import { WebView } from "react-native-webview";
import {
  ChikCheckoutError,
  type ChikCheckoutNavigation,
  type ChikMobileCheckoutRecovery,
  type ChikMobileCheckoutHost,
} from "./checkout.js";
import { ChikErrorCode } from "./error-contract.js";

const defaultTimeoutMs = 10 * 60 * 1_000;
const defaultRecoveryService = "chik.checkout";
const checkoutRecoveryLifetimeMs = 40 * 60 * 1_000;
const checkoutRecoveryRecordVersion = 1;

type CheckoutPresentation = Parameters<ChikMobileCheckoutHost["present"]>[0];

interface ActiveCheckout {
  readonly id: number;
  readonly presentation: CheckoutPresentation;
  view: ChikReactNativeCheckoutPresentation;
  readonly resolve: (url: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly returnSubscription: { remove(): void };
  readonly abortListener: () => void;
  readonly recoveryExpiresAt: number;
  settling: boolean;
}

interface StoredCheckoutRecovery {
  readonly expiresAt: number;
  readonly sessionScope: string;
  readonly recovery: ChikMobileCheckoutRecovery;
}

export interface ChikReactNativeCheckoutPresentation {
  readonly id: number;
  readonly document: string;
  readonly resumeUrl?: string | undefined;
  readonly revision: number;
}

export interface ChikReactNativeMobileCheckoutHostOptions {
  readonly timeoutMs?: number | undefined;
  readonly openExternal?: ((url: string) => Promise<unknown> | unknown) | undefined;
  /** Opens ACTION_VIEW against the ordered Android package candidates, one explicitly bound package at a time. */
  readonly openAndroidPackages?: ((url: string, packageNames: readonly string[]) => Promise<boolean> | boolean) | undefined;
}

/**
 * React Native checkout lifecycle. Mount ChikReactNativeCheckoutHostView once
 * and reuse this instance for generated mobile checkout clients.
 */
export class ChikReactNativeMobileCheckoutHost implements ChikMobileCheckoutHost {
  readonly platform: "android" | "ios";
  readonly #listeners = new Set<() => void>();
  readonly #timeoutMs: number;
  readonly #openExternal: (url: string) => Promise<unknown> | unknown;
  readonly #openAndroidPackages: (url: string, packageNames: readonly string[]) => Promise<boolean> | boolean;
  readonly #recoveryService: string;
  #active: ActiveCheckout | undefined;
  #opening = false;
  #initialReturnConsumed = false;
  #nextID = 1;

  constructor(options: ChikReactNativeMobileCheckoutHostOptions = {}) {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > defaultTimeoutMs) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout timeout is invalid.", 400);
    }
    this.#timeoutMs = timeoutMs;
    const platform = Platform.OS;
    if (platform !== "android" && platform !== "ios") {
      throw new ChikCheckoutError(ChikErrorCode.failedPrecondition, "The mobile checkout host is unavailable on this platform.", 412);
    }
    this.platform = platform;
    this.#openExternal = options.openExternal ?? ((url) => Linking.openURL(url));
    this.#openAndroidPackages = options.openAndroidPackages ?? openAndroidPackages;
    this.#recoveryService = defaultRecoveryService;
  }

  get hasActiveSession(): boolean {
    return this.#active !== undefined;
  }

  async present(presentation: CheckoutPresentation): Promise<string> {
    if (this.#active || this.#opening) {
      throw new ChikCheckoutError(ChikErrorCode.failedPrecondition, "A checkout window is already open.", 412);
    }
    if (!presentation || typeof presentation.document !== "string" || presentation.document.length === 0
      || new TextEncoder().encode(presentation.document).byteLength > 4 * 1024 * 1024
      || typeof presentation.navigate !== "function"
      || !validSessionScope(presentation.sessionScope)
      || typeof presentation.sessionSignal?.aborted !== "boolean"
      || typeof presentation.sessionSignal.addEventListener !== "function"
      || typeof presentation.sessionSignal.removeEventListener !== "function"
      || recoveryCapability(presentation.recovery) === undefined
      || !validReturnScheme(presentation.returnScheme)) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout presentation is invalid.", 400);
    }
    if (presentation.sessionSignal.aborted) throw sessionChangedError();
    this.#opening = true;
    let recoveryExpiresAt: number;
    try {
      const previous = await this.#readRecovery(presentation.sessionScope);
      if (previous !== undefined && recoveryCapability(previous.recovery) !== recoveryCapability(presentation.recovery)) {
        throw new ChikCheckoutError(ChikErrorCode.failedPrecondition, "Another checkout is awaiting completion.", 412);
      }
      recoveryExpiresAt = previous?.expiresAt ?? Date.now() + checkoutRecoveryLifetimeMs;
      await this.#writeRecovery(
        presentation.sessionScope,
        presentation.recovery,
        recoveryExpiresAt,
        presentation.sessionSignal,
      );
    } finally {
      this.#opening = false;
    }
    const id = this.#nextID++;
    let returnSubscription: { remove(): void };
    try {
      returnSubscription = Linking.addEventListener("url", ({ url }) => {
        if (this.#active?.id === id) this.#handleReturnUrl(url, false);
      });
    } catch (cause) {
      await this.#clearRecovery(presentation.sessionScope, recoveryCapability(presentation.recovery)!);
      throw checkoutError(cause);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(id, undefined, new ChikCheckoutError(ChikErrorCode.deadlineExceeded, "Checkout timed out.", 504));
      }, this.#timeoutMs);
      const abortListener = () => this.#settle(id, undefined, sessionChangedError());
      this.#active = {
        id,
        presentation,
        view: Object.freeze({ id, document: presentation.document, revision: 0 }),
        resolve,
        reject,
        timer,
        returnSubscription,
        abortListener,
        recoveryExpiresAt,
        settling: false,
      };
      presentation.sessionSignal.addEventListener("abort", abortListener, { once: true });
      if (presentation.sessionSignal.aborted) {
        abortListener();
        return;
      }
      this.#notify();
      if (this.#initialReturnConsumed) return;
      this.#initialReturnConsumed = true;
      try {
        void Linking.getInitialURL().then(
          (url) => {
            if (url !== null && this.#active?.id === id) this.#handleReturnUrl(url, true);
          },
          (cause) => this.#failNativeLifecycle(id, cause),
        );
      } catch (cause) {
        this.#failNativeLifecycle(id, cause);
      }
    });
  }

  async openExternal(url: string, androidPackages?: readonly string[]): Promise<unknown> {
    const target = checkoutURL(url);
    if (androidPackages !== undefined) {
      if (this.platform !== "android" || !validAndroidPackages(androidPackages)
        || !checkoutPackageTarget(target)) {
        throw new ChikCheckoutError(
          ChikErrorCode.invalidArgument,
          "The package-bound Android checkout target is invalid.",
          400,
        );
      }
      if (!await this.#openAndroidPackages(target, androidPackages)) {
        throw new ChikCheckoutError(
          ChikErrorCode.unavailable,
          "The payment application could not be opened.",
          503,
        );
      }
      return;
    }
    if (this.platform === "android" && !checkoutUnboundAndroidTarget(target)) {
      throw new ChikCheckoutError(
        ChikErrorCode.invalidArgument,
        "Android checkout application links require a reviewed package.",
        400,
      );
    }
    return this.#openExternal(target);
  }

  async restoreCheckout(sessionScope: string): Promise<ChikMobileCheckoutRecovery | undefined> {
    if (!validSessionScope(sessionScope)) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout session scope is invalid.", 400);
    }
    return (await this.#readRecovery(sessionScope))?.recovery;
  }

  async #readRecovery(sessionScope: string): Promise<StoredCheckoutRecovery | undefined> {
    const service = recoveryService(this.#recoveryService, sessionScope);
    let credentials: false | { password: string };
    try {
      credentials = await Keychain.getGenericPassword({ service });
    } catch (cause) {
      throw checkoutStorageError("The pending checkout could not be restored.", cause);
    }
    if (credentials === false) return undefined;
    try {
      const value: unknown = JSON.parse(credentials.password);
      const stored = checkoutRecoveryRecord(value);
      if (stored === undefined || stored.sessionScope !== sessionScope) throw new Error("invalid secure checkout record");
      if (stored.expiresAt <= Date.now()) {
        await this.#deleteRecovery(sessionScope);
        return undefined;
      }
      return stored;
    } catch (cause) {
      try {
        await Keychain.resetGenericPassword({ service });
      } catch {
        // The parse failure remains the canonical public cause.
      }
      throw checkoutStorageError("The pending checkout record is invalid.", cause);
    }
  }

  async completeCheckout(approvalCapability: string, sessionScope: string): Promise<void> {
    if (!validSessionScope(sessionScope)) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout session scope is invalid.", 400);
    }
    const stored = await this.#readRecovery(sessionScope);
    if (stored === undefined) return;
    if (stored.recovery.preparation.approvalCapability !== approvalCapability) {
      throw new ChikCheckoutError(ChikErrorCode.failedPrecondition, "The pending checkout does not match this completion.", 412);
    }
    await this.#deleteRecovery(sessionScope);
  }

  async #deleteRecovery(sessionScope: string): Promise<void> {
    try {
      await Keychain.resetGenericPassword({ service: recoveryService(this.#recoveryService, sessionScope) });
    } catch (cause) {
      throw checkoutStorageError("The pending checkout could not be cleared.", cause);
    }
  }

  async #clearRecovery(sessionScope: string, approvalCapability: string): Promise<void> {
    const stored = await this.#readRecovery(sessionScope);
    if (stored === undefined || stored.recovery.preparation.approvalCapability !== approvalCapability) return;
    await this.#deleteRecovery(sessionScope);
  }

  #handleReturnUrl(url: string, coldStart: boolean): boolean {
    let value: string;
    try {
      value = checkoutURL(url);
    } catch {
      return false;
    }
    const active = this.#active;
    if (!active) return false;
    let decision: ChikCheckoutNavigation;
    try {
      decision = active.presentation.navigate(value);
    } catch (error) {
      if (error instanceof ChikCheckoutError && error.code === ChikErrorCode.invalidArgument) {
        if (coldStart && value.startsWith(active.presentation.returnScheme)) {
          this.#settle(active.id, undefined, new ChikCheckoutError(
            ChikErrorCode.failedPrecondition,
            "The checkout return cannot be resumed.",
            412,
            { cause: error },
          ));
          return true;
        }
        return false;
      }
      this.#settle(active.id, undefined, checkoutNavigationError(error));
      return true;
    }
    if (decision.action === "allow") {
      if (!value.startsWith("https://")) {
        this.#settle(active.id, undefined, new ChikCheckoutError(
          ChikErrorCode.failedPrecondition,
          "The checkout return cannot be resumed.",
          412,
        ));
        return true;
      }
      this.#resume(active, value);
      return true;
    }
    if (decision.action === "restore") {
      if (coldStart) {
        this.#settle(active.id, undefined, new ChikCheckoutError(
          ChikErrorCode.failedPrecondition,
          "The checkout return cannot be resumed.",
          412,
        ));
      } else {
        this.#notify();
      }
      return true;
    }
    this.#handleDecision(active, value, decision);
    return true;
  }

  dismiss(): void {
    const active = this.#active;
    if (active) this.#settle(active.id, undefined, new ChikCheckoutError(ChikErrorCode.canceled, "Checkout was canceled.", 499));
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): ChikReactNativeCheckoutPresentation | undefined {
    return this.#active?.view;
  }

  shouldStartNavigation(id: number, url: string): boolean {
    const active = this.#active;
    if (!active || active.id !== id) return false;
    if (url === "about:blank") return true;
    let value: string;
    let decision: ChikCheckoutNavigation;
    try {
      value = checkoutURL(url);
      decision = active.presentation.navigate(value);
    } catch (error) {
      this.#settle(active.id, undefined, checkoutNavigationError(error));
      return false;
    }
    if (decision.action === "allow") return !value.startsWith(active.presentation.returnScheme);
    this.#handleDecision(active, value, decision);
    return false;
  }

  openWindow(id: number, url: string): void {
    const active = this.#active;
    if (!active || active.id !== id) return;
    let value: string;
    let decision: ChikCheckoutNavigation;
    try {
      value = checkoutURL(url);
      decision = active.presentation.navigate(value);
    } catch (error) {
      this.#settle(active.id, undefined, checkoutNavigationError(error));
      return;
    }
    if (decision.action === "allow") {
      if (!value.startsWith(active.presentation.returnScheme)) {
        void this.#openExternalDecision(active.id, value);
      }
      return;
    }
    this.#handleDecision(active, value, decision);
  }

  failPresentation(id: number, cause?: unknown): void {
    this.#settle(id, undefined, new ChikCheckoutError(
      ChikErrorCode.unavailable,
      "The checkout UI could not be displayed.",
      503,
      { cause },
    ));
  }

  #handleDecision(active: ActiveCheckout, url: string, decision: Exclude<ChikCheckoutNavigation, { action: "allow" }>): void {
    if (decision.action === "complete") {
      void this.#settleRedirect(active, url);
      return;
    }
    if (decision.action === "resume") {
      this.#resume(active, decision.url);
      return;
    }
    if (decision.action === "restore") {
      if (!url.startsWith(active.presentation.returnScheme)) {
        this.#settle(active.id, undefined, new ChikCheckoutError(
          ChikErrorCode.invalidResponse,
          "The checkout navigation result is invalid.",
          502,
        ));
        return;
      }
      this.#notify();
      return;
    }
    void this.#openExternalDecision(
      active.id,
      decision.url,
      decision.fallbackUrl,
      decision.androidPackages,
    );
  }

  async #settleRedirect(active: ActiveCheckout, url: string): Promise<void> {
    if (active.settling) return;
    active.settling = true;
    try {
      await this.#writeRecovery(
        active.presentation.sessionScope,
        { ...active.presentation.recovery, redirectUrl: url },
        active.recoveryExpiresAt,
        active.presentation.sessionSignal,
      );
      active.settling = false;
      this.#settle(active.id, url);
    } catch (cause) {
      active.settling = false;
      this.#settle(
        active.id,
        undefined,
        cause instanceof ChikCheckoutError
          ? cause
          : checkoutStorageError("The checkout result could not be stored.", cause),
      );
    }
  }

  async #writeRecovery(
    sessionScope: string,
    recovery: ChikMobileCheckoutRecovery,
    expiresAt: number,
    sessionSignal: AbortSignal,
  ): Promise<void> {
    try {
      if (sessionSignal.aborted) throw sessionChangedError();
      const record = { version: checkoutRecoveryRecordVersion, expiresAt, sessionScope, recovery };
      if (!await Keychain.setGenericPassword("chik", JSON.stringify(record), {
        service: recoveryService(this.#recoveryService, sessionScope),
      })) {
        throw new Error("secure checkout record was not stored");
      }
      if (sessionSignal.aborted) {
        await this.#deleteRecovery(sessionScope);
        throw sessionChangedError();
      }
    } catch (cause) {
      if (cause instanceof ChikCheckoutError) throw cause;
      throw checkoutStorageError("The pending checkout could not be stored.", cause);
    }
  }

  #resume(active: ActiveCheckout, url: string): void {
    let resumeUrl: string;
    try {
      resumeUrl = checkoutResumeURL(url);
    } catch (error) {
      this.#settle(active.id, undefined, checkoutInvalidResponse(error));
      return;
    }
    active.view = Object.freeze({
      id: active.id,
      document: active.presentation.document,
      resumeUrl,
      revision: active.view.revision + 1,
    });
    this.#notify();
  }

  #failNativeLifecycle(id: number, cause: unknown): void {
    this.#settle(id, undefined, checkoutError(cause));
  }

  async #openExternalDecision(
    id: number,
    url: string,
    fallbackUrl?: string,
    androidPackages?: readonly string[],
  ): Promise<void> {
    let primaryCause: unknown;
    try {
      await this.openExternal(url, androidPackages);
      return;
    } catch (cause) {
      primaryCause = cause;
      if (fallbackUrl !== undefined) {
        try {
          await this.openExternal(fallbackUrl);
          return;
        } catch (fallbackCause) {
          primaryCause = new AggregateError(
            [primaryCause, fallbackCause],
            "Checkout external navigation failed.",
          );
        }
      }
    }
    this.#settle(id, undefined, new ChikCheckoutError(
      ChikErrorCode.unavailable,
      fallbackUrl === undefined
        ? "The payment application could not be opened."
        : "The payment application fallback could not be opened.",
      503,
      { cause: primaryCause },
    ));
  }

  #settle(id: number, url?: string, error?: Error): void {
    const active = this.#active;
    if (!active || active.id !== id || active.settling) return;
    this.#active = undefined;
    clearTimeout(active.timer);
    try {
      active.returnSubscription.remove();
    } catch {
      // Session settlement must not expose native subscription details.
    }
    active.presentation.sessionSignal.removeEventListener("abort", active.abortListener);
    this.#notify();
    if (!error) {
      active.resolve(url!);
      return;
    }
    this.#opening = true;
    void this.#clearRecovery(active.presentation.sessionScope, recoveryCapability(active.presentation.recovery)!).then(
      () => {
        this.#opening = false;
        active.reject(error);
      },
      (cleanupCause) => {
        this.#opening = false;
        active.reject(checkoutStorageError(
          "The pending checkout could not be cleared.",
          new AggregateError([error, cleanupCause], "Checkout failure cleanup failed."),
        ));
      },
    );
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // One view listener cannot corrupt the checkout session lifecycle.
      }
    }
  }
}

function sessionChangedError(): ChikCheckoutError {
  return new ChikCheckoutError(ChikErrorCode.unauthenticated, "The customer session changed during checkout.", 401);
}

export function ChikReactNativeCheckoutHostView(
  { host }: { readonly host: ChikReactNativeMobileCheckoutHost },
): ReactElement | null {
  const presentation = useSyncExternalStore(
    (listener) => host.subscribe(listener),
    () => host.snapshot(),
    () => undefined,
  );
  if (!presentation) return null;
  return createElement(
    Modal,
    {
      visible: true,
      animationType: "slide",
      onRequestClose: () => host.dismiss(),
      onDismiss: () => host.dismiss(),
    },
    createElement(
      View,
      { style: { flex: 1 } },
      createElement(
        View,
        { style: { alignItems: "flex-end", paddingHorizontal: 12, paddingVertical: 8 } },
        createElement(Button, {
          title: "Close checkout",
          accessibilityLabel: "Close checkout",
          onPress: () => host.dismiss(),
        }),
      ),
      createElement(WebView, {
        key: presentation.revision,
        source: presentation.resumeUrl === undefined
          ? { html: presentation.document }
          : { uri: presentation.resumeUrl },
        originWhitelist: ["*"],
        javaScriptEnabled: true,
        javaScriptCanOpenWindowsAutomatically: true,
        mixedContentMode: "never",
        setSupportMultipleWindows: true,
        startInLoadingState: true,
        renderLoading: () => createElement(ActivityIndicator, { style: { flex: 1 } }),
        onShouldStartLoadWithRequest: ({ url }: { readonly url: string }) => host.shouldStartNavigation(presentation.id, url),
        onOpenWindow: ({ nativeEvent }: { readonly nativeEvent: { readonly targetUrl: string } }) => {
          host.openWindow(presentation.id, nativeEvent.targetUrl);
        },
        onError: (cause: unknown) => host.failPresentation(presentation.id, cause),
        onHttpError: ({ nativeEvent }: { readonly nativeEvent: { readonly url: string } }) => {
          if (presentation.resumeUrl !== undefined && nativeEvent.url === presentation.resumeUrl) {
            host.failPresentation(presentation.id, nativeEvent);
          }
        },
        onContentProcessDidTerminate: (cause: unknown) => host.failPresentation(presentation.id, cause),
        onRenderProcessGone: (cause: unknown) => host.failPresentation(presentation.id, cause),
      }),
    ),
  );
}

function checkoutURL(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout navigation URL is invalid.", 400);
  }
  try {
    return new URL(value).href;
  } catch {
    if (value.startsWith("intent:")) return value;
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout navigation URL is invalid.", 400);
  }
}

function validAndroidPackage(value: string): boolean {
  return value.length <= 255
    && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(value);
}

function validAndroidPackages(values: readonly string[]): boolean {
  return Array.isArray(values) && values.length > 0 && values.length <= 32
    && values.every((value) => typeof value === "string" && validAndroidPackage(value))
    && new Set(values).size === values.length;
}

function checkoutPackageTarget(value: string): boolean {
  const protocol = new URL(value).protocol;
  return protocol !== "http:" && protocol !== "https:" && protocol !== "intent:"
    && protocol !== "javascript:" && protocol !== "market:";
}

function checkoutUnboundAndroidTarget(value: string): boolean {
  const protocol = new URL(value).protocol;
  return protocol === "https:";
}

async function openAndroidPackages(url: string, packageNames: readonly string[]): Promise<boolean> {
  const launcher = NativeModules.ChikCheckoutLauncher as {
    openPackages?: ((target: string, targetPackages: readonly string[]) => Promise<boolean>) | undefined;
  } | undefined;
  if (typeof launcher?.openPackages !== "function") {
    throw new ChikCheckoutError(
      ChikErrorCode.failedPrecondition,
      "A package-bound Android checkout launcher is required.",
      412,
    );
  }
  return await launcher.openPackages(url, packageNames) === true;
}

function validReturnScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]{1,62}:\/\/$/u.test(value) && value !== "http://" && value !== "https://";
}

function validSessionScope(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function recoveryService(base: string, sessionScope: string): string {
  return `${base}.${sessionScope}`;
}

function recoveryCapability(value: unknown): string | undefined {
  return checkoutRecovery(value)?.preparation.approvalCapability;
}

function checkoutRecovery(value: unknown): ChikMobileCheckoutRecovery | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const hasRedirectURL = Object.hasOwn(record, "redirectUrl");
  if (!exactKeys(record, hasRedirectURL ? ["preparation", "redirectUrl"] : ["preparation"])) return undefined;
  const preparation = record.preparation;
  if (typeof preparation !== "object" || preparation === null || Array.isArray(preparation)) return undefined;
  const candidate = preparation as Record<string, unknown>;
  if (!exactKeys(candidate, [
    "requestId", "orderId", "orderName", "amount", "currency", "customerKey", "approvalCapability",
  ])) return undefined;
  const redirectUrl = hasRedirectURL ? record.redirectUrl : undefined;
  if (typeof candidate.requestId !== "string" || !candidate.requestId.trim()
    || candidate.requestId.trim() !== candidate.requestId
    || new TextEncoder().encode(candidate.requestId).byteLength > 512
    || typeof candidate.orderId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/u.test(candidate.orderId)
    || typeof candidate.orderName !== "string" || !candidate.orderName.trim()
    || candidate.orderName.trim() !== candidate.orderName
    || [...candidate.orderName].length > 100
    || typeof candidate.amount !== "number" || !Number.isSafeInteger(candidate.amount) || candidate.amount <= 0
    || candidate.currency !== "KRW"
    || typeof candidate.customerKey !== "string" || (candidate.customerKey !== "ANONYMOUS"
      && !/^(?=.{2,50}$)(?=.*[-_=.@])[A-Za-z0-9_=.@-]+$/u.test(candidate.customerKey))
    || typeof candidate.approvalCapability !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.approvalCapability)) {
    return undefined;
  }
  if (redirectUrl !== undefined) {
    if (typeof redirectUrl !== "string") return undefined;
    try { checkoutResumeURL(redirectUrl); } catch { return undefined; }
  }
  return value as ChikMobileCheckoutRecovery;
}

function checkoutRecoveryRecord(value: unknown): StoredCheckoutRecovery | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["version", "expiresAt", "sessionScope", "recovery"])
    || record.version !== checkoutRecoveryRecordVersion
    || typeof record.expiresAt !== "number" || !Number.isSafeInteger(record.expiresAt)
    || record.expiresAt <= 0 || record.expiresAt > Date.now() + checkoutRecoveryLifetimeMs
    || !validSessionScope(record.sessionScope)) return undefined;
  const recovery = checkoutRecovery(record.recovery);
  return recovery === undefined ? undefined : {
    expiresAt: record.expiresAt,
    sessionScope: record.sessionScope,
    recovery,
  };
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function checkoutResumeURL(value: string): string {
  if (value.length === 0 || value.length > 16 * 1024) {
    throw new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The checkout navigation result is invalid.",
      502,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The checkout navigation result is invalid.",
      502,
      { cause },
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The checkout navigation result is invalid.",
      502,
    );
  }
  return url.href;
}

function checkoutInvalidResponse(error: unknown): ChikCheckoutError {
  return error instanceof ChikCheckoutError && error.code === ChikErrorCode.invalidResponse
    ? error
    : new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The checkout navigation result is invalid.",
      502,
      { cause: error },
    );
}

function checkoutNavigationError(error: unknown): ChikCheckoutError {
  return error instanceof ChikCheckoutError && error.code === ChikErrorCode.invalidResponse
    ? error
    : new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The checkout navigation result is invalid.",
      502,
      { cause: error },
    );
}

function checkoutError(error: unknown): ChikCheckoutError {
  return error instanceof ChikCheckoutError
    ? error
    : new ChikCheckoutError(
      ChikErrorCode.unavailable,
      "The checkout UI could not be displayed.",
      503,
      { cause: error },
    );
}

function checkoutStorageError(message: string, cause: unknown): ChikCheckoutError {
  return cause instanceof ChikCheckoutError && cause.code === ChikErrorCode.storageError
    ? cause
    : new ChikCheckoutError(ChikErrorCode.storageError, message, 0, { cause });
}
