import { ChikErrorCode, type ChikErrorCode as ChikErrorCodeValue } from "./error-contract.js";
import {
  TOSS_REVIEWED_APP_RETURN_HTTPS_HOSTS,
  TossCheckoutProfile,
  tossClientKeyProfile,
} from "./toss-key-profiles.generated.js";

const reviewedCheckoutScript = "https://js.tosspayments.com/v2/standard";
const supportedExtension = "payments/toss";
const checkoutStateParameter = "chikCheckoutState";
const approvalCapabilityPattern = /^[A-Za-z0-9_-]{43}$/u;
const reviewedCheckoutSchemes = new Set([
  "supertoss", "kb-acp", "liivbank", "newliiv", "kbbank", "nhappcardansimclick",
  "nhallonepayansimclick", "nonghyupcardansimclick", "lottesmartpay", "lotteappcard",
  "mpocket.online.ansimclick", "mpocket.ansimclick.cert", "vguardstart", "samsungpay",
  "monimopay", "monimopayauth", "shinhan-sr-ansimclick", "smshinhanansimclick",
  "com.wooricard.wcard", "newsmartpib", "citispay", "citicardappkr", "citimobileapp",
  "cloudpay", "hanawalletmembers", "hdcardappcardansimclick", "smhyundaiansimclick",
  "shinsegaeeasypayment", "payco", "lpayapp", "ispmobile", "kakaobank",
  "lmslpay", "wooripay", "naversearchthirdlogin", "kakaotalk", "kftc-bankpay",
  "v3mobileplusweb",
]);
const reservedMobileSchemes = new Set([
  ...reviewedCheckoutSchemes,
  "about", "blob", "data", "file", "http", "https", "intent", "javascript",
  "market", "ws", "wss",
]);

function reviewedAndroidPackages(...packages: string[]): readonly string[] {
  return Object.freeze(packages);
}

const reviewedAndroidCheckoutPackages: Readonly<Record<string, readonly string[]>> = Object.freeze({
  supertoss: reviewedAndroidPackages("viva.republica.toss"),
  "kb-acp": reviewedAndroidPackages("com.kbcard.cxh.appcard"),
  liivbank: reviewedAndroidPackages("com.kbstar.liivbank"),
  newliiv: reviewedAndroidPackages("com.kbstar.reboot"),
  kbbank: reviewedAndroidPackages("com.kbstar.kbbank"),
  nhappcardansimclick: reviewedAndroidPackages("nh.smart.nhallonepay"),
  nhallonepayansimclick: reviewedAndroidPackages("nh.smart.nhallonepay"),
  nonghyupcardansimclick: reviewedAndroidPackages("nh.smart.nhallonepay"),
  lottesmartpay: reviewedAndroidPackages("com.lcacApp"),
  lotteappcard: reviewedAndroidPackages("com.lcacApp"),
  "mpocket.online.ansimclick": reviewedAndroidPackages("kr.co.samsungcard.mpocket"),
  "mpocket.ansimclick.cert": reviewedAndroidPackages("kr.co.samsungcard.mpocket"),
  vguardstart: reviewedAndroidPackages("kr.co.shiftworks.vguardweb"),
  samsungpay: reviewedAndroidPackages("com.samsung.android.spay", "com.samsung.android.spaylite"),
  monimopay: reviewedAndroidPackages("net.ib.android.smcard"),
  monimopayauth: reviewedAndroidPackages("net.ib.android.smcard"),
  "shinhan-sr-ansimclick": reviewedAndroidPackages("com.shcard.smartpay"),
  smshinhanansimclick: reviewedAndroidPackages("com.shinhancard.smartshinhan"),
  "com.wooricard.wcard": reviewedAndroidPackages("com.wooricard.wcard", "com.wooricard.smartapp"),
  newsmartpib: reviewedAndroidPackages("com.wooribank.smart.npib"),
  citispay: reviewedAndroidPackages("kr.co.citibank.citimobile"),
  citicardappkr: reviewedAndroidPackages("kr.co.citibank.citimobile"),
  citimobileapp: reviewedAndroidPackages("kr.co.citibank.citimobile"),
  cloudpay: reviewedAndroidPackages("com.hanaskcard.paycla", "com.hanaskcard.rocomo.potal"),
  hanawalletmembers: reviewedAndroidPackages("kr.co.hanamembers.hmscustomer"),
  hdcardappcardansimclick: reviewedAndroidPackages("com.hyundaicard.appcard"),
  smhyundaiansimclick: reviewedAndroidPackages("com.lumensoft.touchenappfree"),
  shinsegaeeasypayment: reviewedAndroidPackages("com.ssg.serviceapp.android.egiftcertificate"),
  payco: reviewedAndroidPackages("com.nhnent.payapp"),
  lpayapp: reviewedAndroidPackages("com.lottemembers.android"),
  ispmobile: reviewedAndroidPackages("kvp.jjy.MispAndroid320"),
  kakaobank: reviewedAndroidPackages("com.kakaobank.channel"),
  kakaotalk: reviewedAndroidPackages("com.kakao.talk"),
  "kftc-bankpay": reviewedAndroidPackages("com.kftc.bankpay.android"),
  naversearchthirdlogin: reviewedAndroidPackages("com.nhn.android.search"),
  v3mobileplusweb: reviewedAndroidPackages("com.ahnlab.v3mobileplus"),
  wooripay: reviewedAndroidPackages("com.wooricard.wpay"),
});
const reviewedAppReturnHttpsHosts = new Set<string>(TOSS_REVIEWED_APP_RETURN_HTTPS_HOSTS);
const reviewedIOSCheckoutFallbacks: Readonly<Record<string, string>> = Object.freeze({
  supertoss: "https://apps.apple.com/app/id839333328",
  ispmobile: "https://apps.apple.com/app/id369125087",
  "kb-acp": "https://apps.apple.com/app/id695436326",
  newliiv: "https://apps.apple.com/app/id1573528126",
  kbbank: "https://apps.apple.com/app/id373742138",
  "mpocket.online.ansimclick": "https://apps.apple.com/app/id535125356",
  lottesmartpay: "https://apps.apple.com/app/id668497947",
  lotteappcard: "https://apps.apple.com/app/id688047200",
  lpayapp: "https://apps.apple.com/app/id1036098908",
  cloudpay: "https://apps.apple.com/app/id847268987",
  hanawalletmembers: "https://apps.apple.com/app/id1038288833",
  hdcardappcardansimclick: "https://apps.apple.com/app/id702653088",
  "shinhan-sr-ansimclick": "https://apps.apple.com/app/id572462317",
  "com.wooricard.wcard": "https://apps.apple.com/app/id1499598869",
  newsmartpib: "https://apps.apple.com/app/id1470181651",
  nhallonepayansimclick: "https://apps.apple.com/app/id1177889176",
  citimobileapp: "https://apps.apple.com/app/id1179759666",
  shinsegaeeasypayment: "https://apps.apple.com/app/id666237916",
  payco: "https://apps.apple.com/app/id924292102",
  lmslpay: "https://apps.apple.com/app/id473250588",
  wooripay: "https://apps.apple.com/app/id1201113419",
  naversearchthirdlogin: "https://apps.apple.com/app/id393499958",
  kakaotalk: "https://apps.apple.com/app/id362057947",
  "kftc-bankpay": "https://apps.apple.com/app/id398456030",
});

export type ChikCheckoutErrorCode = ChikErrorCodeValue;

export type ChikCheckoutFailureCode = "canceled" | "ui_unavailable" | "payment_failed";
export type ChikMobilePlatform = "android" | "ios";

export class ChikCheckoutError extends Error {
  constructor(readonly code: ChikCheckoutErrorCode, message: string, readonly status: number, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChikCheckoutError";
  }
}

export interface ChikCheckoutBridgeConfiguration {
  readonly extension: string;
  readonly clientKey: string;
  readonly successUrl: string;
  readonly failUrl: string;
  readonly appScheme?: string | undefined;
}

export interface ChikCheckoutPreparation {
  readonly requestId: string;
  readonly orderId: string;
  readonly orderName: string;
  readonly amount: number;
  readonly currency: "KRW";
  readonly customerKey: string;
  readonly approvalCapability: string;
}

export interface ChikMobileCheckoutRecovery {
  readonly preparation: ChikCheckoutPreparation;
  readonly redirectUrl?: string | undefined;
}

export type ChikCheckoutRedirect =
  | {
    readonly status: "success";
    readonly paymentKey: string;
    readonly orderId: string;
    readonly amount: number;
    readonly paymentType: "NORMAL";
    readonly approvalCapability: string;
  }
  | { readonly status: "failed"; readonly code: ChikCheckoutFailureCode; readonly message: string; readonly orderId?: string | undefined };

export type ChikCheckoutNavigation =
  | { readonly action: "allow" }
  | { readonly action: "restore" }
  | { readonly action: "resume"; readonly url: string }
  | { readonly action: "complete"; readonly redirect: ChikCheckoutRedirect }
  | {
    readonly action: "external";
    readonly url: string;
    readonly fallbackUrl?: string | undefined;
    readonly androidPackages?: readonly string[] | undefined;
  };

export interface ChikMobileCheckoutHost {
  readonly platform: ChikMobilePlatform;
  present(input: {
    readonly document: string;
    readonly returnScheme: string;
    readonly sessionScope: string;
    readonly sessionSignal: AbortSignal;
    readonly recovery: ChikMobileCheckoutRecovery;
    readonly navigate: (url: string) => ChikCheckoutNavigation;
  }): Promise<string>;
  restoreCheckout(sessionScope: string): Promise<ChikMobileCheckoutRecovery | undefined>;
  completeCheckout(approvalCapability: string, sessionScope: string): Promise<void>;
  openExternal?(url: string, androidPackages?: readonly string[]): Promise<unknown> | unknown;
}

interface ReviewedPaymentWindow {
  on(event: "paymentRequest", callback: () => void | Promise<void>): void;
  on(event: "cancel", callback: () => void): void;
  destroy(): void | Promise<void>;
}

interface ReviewedPaymentWidgets {
  setAmount(value: { readonly value: number; readonly currency: "KRW" }): Promise<void>;
  renderPaymentWindow(): Promise<ReviewedPaymentWindow>;
  requestPayment(value: Readonly<Record<string, unknown>>): Promise<void>;
}

interface ReviewedPayment {
  requestPayment(value: Readonly<Record<string, unknown>>): Promise<void>;
}

interface ReviewedPayments {
  widgets(value: { readonly customerKey: string }): ReviewedPaymentWidgets;
  payment(value: { readonly customerKey: string }): ReviewedPayment;
}

interface ReviewedPaymentsGlobal {
  (clientKey: string): ReviewedPayments;
}

type WebCheckoutState =
  | { readonly kind: "idle" }
  | { readonly kind: "opening"; readonly id: number; cancelled: boolean }
  | { readonly kind: "open"; readonly id: number; readonly window: ReviewedPaymentWindow }
  | {
    readonly kind: "closing";
    readonly id: number;
    readonly window: ReviewedPaymentWindow;
    close: Promise<void> | undefined;
  };

let scriptPromise: Promise<ReviewedPaymentsGlobal> | undefined;
let reviewedPayments: ReviewedPaymentsGlobal | undefined;

export function createChikWebCheckoutBridge(configuration: ChikCheckoutBridgeConfiguration) {
  const config = checkoutConfiguration(configuration, false);
  let nextID = 1;
  let state: WebCheckoutState = { kind: "idle" };
  return {
    async present(preparation: ChikCheckoutPreparation): Promise<void> {
      if (state.kind !== "idle") throw new ChikCheckoutError(ChikErrorCode.failedPrecondition, "A checkout window is already open.", 412);
      const value = checkoutPreparation(preparation);
      const opening: Extract<WebCheckoutState, { kind: "opening" }> = {
        kind: "opening",
        id: nextID++,
        cancelled: false,
      };
      state = opening;
      try {
        const createPayments = await loadReviewedCheckoutScript();
        const payments = createPayments(config.clientKey);
        if (checkoutProfile(config.clientKey) === TossCheckoutProfile.payment) {
          if (opening.cancelled) throw new ChikCheckoutError(ChikErrorCode.canceled, checkoutFailure("canceled").message, 499);
          const payment = payments.payment({ customerKey: value.customerKey });
          try {
            await payment.requestPayment(individualPaymentRequest(config, value));
          } catch {
            if (opening.cancelled) throw new ChikCheckoutError(ChikErrorCode.canceled, checkoutFailure("canceled").message, 499);
            if (state === opening) state = { kind: "idle" };
            replaceCheckoutLocation(checkoutFailureUrl(config, value, "payment_failed"));
            return;
          }
          if (opening.cancelled) throw new ChikCheckoutError(ChikErrorCode.canceled, checkoutFailure("canceled").message, 499);
          if (state === opening) state = { kind: "idle" };
          return;
        }
        const widgets = payments.widgets({ customerKey: value.customerKey });
        await widgets.setAmount({ value: value.amount, currency: value.currency });
        const window = await widgets.renderPaymentWindow();
        state = { kind: "open", id: opening.id, window };
        if (opening.cancelled) {
          await closeWindow(opening.id, window);
          throw new ChikCheckoutError(ChikErrorCode.canceled, "Checkout was canceled.", 499);
        }
        window.on("paymentRequest", async () => {
          if (!isOpen(opening.id, window)) return;
          try {
            await widgets.requestPayment(paymentRequest(config, value));
          } catch {
            await settleWindow(
              opening.id,
              window,
              checkoutFailureUrl(config, value, "payment_failed"),
            ).catch(() => undefined);
          }
        });
        window.on("cancel", () => {
          void settleWindow(
            opening.id,
            window,
            checkoutFailureUrl(config, value, "canceled"),
          ).catch(() => undefined);
        });
      } catch (cause) {
        const cancelled = opening.cancelled;
        let preserveCanonicalCause = cause instanceof ChikCheckoutError;
        if (state === opening) {
          state = { kind: "idle" };
        } else if (state.kind === "open" && state.id === opening.id) {
          try {
            await closeWindow(state.id, state.window);
          } catch {
            preserveCanonicalCause = false;
          }
        }
        if (cancelled && state.kind === "idle") {
          throw new ChikCheckoutError(ChikErrorCode.canceled, "Checkout was canceled.", 499);
        }
        if (preserveCanonicalCause) throw cause;
        throw new ChikCheckoutError(
          ChikErrorCode.unavailable,
          "The checkout UI could not be loaded.",
          503,
        );
      }
    },
    async destroy(): Promise<void> {
      if (state.kind === "opening") {
        state.cancelled = true;
        return;
      }
      if (state.kind === "idle") return;
      try {
        await closeWindow(state.id, state.window);
      } catch {
        throw new ChikCheckoutError(
          ChikErrorCode.unavailable,
          "The checkout UI could not be closed.",
          503,
        );
      }
    },
    redirect(url: string): ChikCheckoutRedirect {
      return requiredCheckoutRedirect(config, url);
    },
  };

  function isOpen(id: number, window: ReviewedPaymentWindow): boolean {
    return state.kind === "open" && state.id === id && state.window === window;
  }

  async function settleWindow(id: number, window: ReviewedPaymentWindow, redirect: string): Promise<void> {
    if (!isOpen(id, window)) return;
    await closeWindow(id, window, () => replaceCheckoutLocation(redirect));
  }

  async function closeWindow(
    id: number,
    window: ReviewedPaymentWindow,
    afterClose?: () => void,
  ): Promise<void> {
    let closing: Extract<WebCheckoutState, { kind: "closing" }>;
    if (isOpen(id, window)) {
      closing = { kind: "closing", id, window, close: undefined };
      state = closing;
    } else if (state.kind === "closing" && state.id === id && state.window === window) {
      closing = state;
    } else {
      return;
    }
    closing.close ??= Promise.resolve().then(() => window.destroy());
    try {
      await closing.close;
    } catch (cause) {
      if (state === closing) closing.close = undefined;
      throw cause;
    }
    if (state !== closing) return;
    try {
      afterClose?.();
    } finally {
      state = { kind: "idle" };
    }
  }
}

export function createChikMobileCheckoutDocument(
  configuration: ChikCheckoutBridgeConfiguration,
  preparation: ChikCheckoutPreparation,
): string {
  const config = checkoutConfiguration(configuration, true);
  const value = checkoutPreparation(preparation);
  const callbacks = checkoutCallbacks(config, value.approvalCapability);
  const encoded = escapeInlineJSON(JSON.stringify({
    config: { ...config, ...callbacks },
    value: {
      requestId: value.requestId,
      orderId: value.orderId,
      orderName: value.orderName,
      amount: value.amount,
      currency: value.currency,
      customerKey: value.customerKey,
    },
  }));
  const checkout = checkoutProfile(config.clientKey) === TossCheckoutProfile.widgets
    ? `const widgets=payments.widgets({customerKey:input.value.customerKey});await widgets.setAmount({value:input.value.amount,currency:input.value.currency});const window=await widgets.renderPaymentWindow();window.on("paymentRequest",async()=>{try{await widgets.requestPayment({orderId:input.value.orderId,orderName:input.value.orderName,successUrl:input.config.successUrl,failUrl:input.config.failUrl,card:{appScheme:input.config.appScheme+"://"}})}catch{fail("CHECKOUT_REQUEST_FAILED","The checkout request failed.")}});window.on("cancel",()=>fail("CHECKOUT_CANCELED","Checkout was canceled."))`
    : `const payment=payments.payment({customerKey:input.value.customerKey});try{await payment.requestPayment({method:"CARD",amount:{value:input.value.amount,currency:input.value.currency},orderId:input.value.orderId,orderName:input.value.orderName,successUrl:input.config.successUrl,failUrl:input.config.failUrl,windowTarget:"self",card:{useEscrow:false,flowMode:"DEFAULT",useCardPoint:false,useAppCardOnly:false,appScheme:input.config.appScheme+"://"}})}catch{fail("CHECKOUT_REQUEST_FAILED","The checkout request failed.")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="${reviewedCheckoutScript}"></script></head><body><main id="checkout"></main><script>const input=${encoded};const fail=(code,message)=>{const redirect=new URL(input.config.failUrl);redirect.searchParams.set("code",code);redirect.searchParams.set("message",message);redirect.searchParams.set("orderId",input.value.orderId);location.replace(redirect.href)};(async()=>{try{const payments=TossPayments(input.config.clientKey);${checkout}}catch{fail("CHECKOUT_UI_UNAVAILABLE","The checkout UI could not be loaded.")}})();</script></body></html>`;
}

export function classifyChikCheckoutNavigation(
  configuration: ChikCheckoutBridgeConfiguration,
  value: string,
  platform: ChikMobilePlatform,
): ChikCheckoutNavigation {
  if ((platform !== "android" && platform !== "ios") || !value || value.length > 16 * 1024) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout navigation URL is invalid.", 400);
  }
  const config = checkoutConfiguration(configuration, true);
  const redirect = checkoutRedirect(config, value);
  if (redirect) return { action: "complete", redirect };
  if (value.startsWith("intent:")) {
    if (platform !== "android") {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout navigation URL is invalid.", 400);
    }
    const parsed = intentNavigation(value);
    if (!parsed) throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout navigation URL is invalid.", 400);
    return { action: "external", ...parsed };
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout navigation URL is invalid.", 400); }
  if (safeCheckoutPageNavigation(url)) return { action: "allow" };
  const scheme = url.protocol.slice(0, -1);
  if (scheme === config.appScheme) {
    if (!value.startsWith(`${config.appScheme}://`)) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout return URL is invalid.", 400);
    }
    return checkoutReturnNavigation(config, url);
  }
  if (!reviewedCheckoutSchemes.has(scheme)) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout navigation URL is invalid.", 400);
  }
  if (platform === "android") {
    const packages = reviewedAndroidCheckoutPackages[scheme];
    if (packages === undefined || packages.length === 0) {
      throw new ChikCheckoutError(
        ChikErrorCode.invalidArgument,
        "The Android checkout application link is not bound to a reviewed package.",
        400,
      );
    }
    const androidPackages = [...packages];
    const androidPackage = androidPackages[0]!;
    return {
      action: "external",
      url: url.href,
      fallbackUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidPackage)}`,
      androidPackages,
    };
  }
  const fallbackUrl = reviewedIOSCheckoutFallbacks[scheme];
  if (fallbackUrl === undefined) {
    throw new ChikCheckoutError(
      ChikErrorCode.invalidArgument,
      "The checkout application does not have a reviewed store fallback.",
      400,
    );
  }
  return { action: "external", url: url.href, fallbackUrl };
}

export function parseChikCheckoutRedirect(
  configuration: ChikCheckoutBridgeConfiguration,
  value: string,
): ChikCheckoutRedirect {
  const config = checkoutConfiguration(configuration, configuration.appScheme !== undefined);
  return requiredCheckoutRedirect(config, value);
}

function requiredCheckoutRedirect(
  config: Required<ChikCheckoutBridgeConfiguration>,
  value: string,
): ChikCheckoutRedirect {
  if (!value || value.length > 16 * 1024) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout redirect URL is invalid.", 400);
  }
  const redirect = checkoutRedirect(config, value);
  if (!redirect) throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout redirect URL is invalid.", 400);
  return redirect;
}

function checkoutRedirect(config: Required<ChikCheckoutBridgeConfiguration>, value: string): ChikCheckoutRedirect | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const successful = sameRedirect(url, config.successUrl);
  const failed = sameRedirect(url, config.failUrl);
  if (successful) {
    const paymentKey = singleSearchParameter(url, "paymentKey");
    const orderId = singleSearchParameter(url, "orderId");
    const amountText = singleSearchParameter(url, "amount");
    const paymentType = optionalSingleSearchParameter(url, "paymentType");
    const paymentTypeInRedirect = tossClientKeyProfile(config.clientKey)!.paymentTypeInRedirect;
    const amount = amountText !== undefined && /^[0-9]+$/u.test(amountText) ? Number(amountText) : Number.NaN;
    const approvalCapability = singleSearchParameter(url, checkoutStateParameter);
    if (url.username || url.password || url.hash
      || !paymentKey || new TextEncoder().encode(paymentKey).byteLength > 200
    || !/^[A-Za-z0-9_-]{6,64}$/u.test(orderId ?? "") || !Number.isSafeInteger(amount) || amount <= 0
      || (paymentTypeInRedirect ? paymentType !== "NORMAL" : paymentType !== undefined)
      || !approvalCapabilityPattern.test(approvalCapability ?? "")) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The successful checkout redirect is invalid.", 400);
    }
    return {
      status: "success",
      paymentKey,
      orderId: orderId!,
      amount,
      paymentType: "NORMAL",
      approvalCapability: approvalCapability!,
    };
  }
  if (failed) {
    const code = singleSearchParameter(url, "code");
    const message = singleSearchParameter(url, "message");
    const orderId = optionalSingleSearchParameter(url, "orderId");
    const approvalCapability = singleSearchParameter(url, checkoutStateParameter);
    if (url.username || url.password || url.hash
      || !code || !message || code.length > 512 || message.length > 2_048
      || (orderId !== undefined && !/^[A-Za-z0-9_-]{6,64}$/u.test(orderId))
      || !approvalCapabilityPattern.test(approvalCapability ?? "")) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The failed checkout redirect is invalid.", 400);
    }
    return { status: "failed", ...checkoutFailure(code), ...(orderId === undefined ? {} : { orderId }) };
  }
  return undefined;
}

function singleSearchParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function optionalSingleSearchParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout redirect URL is invalid.", 400);
  }
  return values[0];
}

function sameRedirect(actual: URL, expected: string): boolean {
  const target = new URL(expected);
  if (actual.protocol !== target.protocol || actual.host !== target.host || actual.pathname !== target.pathname) return false;
  for (const name of new Set(target.searchParams.keys())) {
    const required = target.searchParams.getAll(name);
    const received = actual.searchParams.getAll(name);
    if (required.length !== received.length || required.some((value, index) => value !== received[index])) return false;
  }
  return true;
}

function paymentRequest(config: Required<ChikCheckoutBridgeConfiguration>, value: ChikCheckoutPreparation): Readonly<Record<string, unknown>> {
  const callbacks = checkoutCallbacks(config, value.approvalCapability);
  return {
    orderId: value.orderId,
    orderName: value.orderName,
    ...callbacks,
    ...(config.appScheme ? { card: { appScheme: `${config.appScheme}://` } } : {}),
  };
}

function individualPaymentRequest(
  config: Required<ChikCheckoutBridgeConfiguration>,
  value: ChikCheckoutPreparation,
): Readonly<Record<string, unknown>> {
  return {
    method: "CARD",
    amount: { value: value.amount, currency: value.currency },
    orderId: value.orderId,
    orderName: value.orderName,
    ...checkoutCallbacks(config, value.approvalCapability),
    windowTarget: "self",
    card: {
      useEscrow: false,
      flowMode: "DEFAULT",
      useCardPoint: false,
      useAppCardOnly: false,
      ...(config.appScheme ? { appScheme: `${config.appScheme}://` } : {}),
    },
  };
}

function checkoutProfile(clientKey: string): TossCheckoutProfile {
  return tossClientKeyProfile(clientKey)!.profile;
}

function checkoutConfiguration(value: ChikCheckoutBridgeConfiguration, mobile: boolean): Required<ChikCheckoutBridgeConfiguration> {
  if (!value || value.extension !== supportedExtension || typeof value.clientKey !== "string" || value.clientKey.length > 512
    || typeof value.successUrl !== "string" || typeof value.failUrl !== "string"
    || (value.appScheme !== undefined && typeof value.appScheme !== "string")
    || tossClientKeyProfile(value.clientKey) === undefined) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout bridge configuration is invalid.", 400);
  }
  const callbackURLs: URL[] = [];
  for (const [source, reserved] of [
    [value.successUrl, ["paymentKey", "orderId", "amount", "paymentType", checkoutStateParameter]],
    [value.failUrl, ["code", "message", "orderId", checkoutStateParameter]],
  ] as const) {
    let url: URL;
    if (source.length > 2_048) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout bridge configuration is invalid.", 400);
    }
    try { url = new URL(source); } catch {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout bridge configuration is invalid.", 400);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout bridge configuration is invalid.", 400);
    }
    if (reserved.some((name) => url.searchParams.has(name))) {
      throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout bridge configuration is invalid.", 400);
    }
    callbackURLs.push(url);
  }
  if (sameRedirect(callbackURLs[0]!, callbackURLs[1]!.href)
    || sameRedirect(callbackURLs[1]!, callbackURLs[0]!.href)) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout bridge callback URLs overlap.", 400);
  }
  const appScheme = value.appScheme ?? "";
  if (mobile && (!/^[a-z][a-z0-9+.-]{1,62}$/u.test(appScheme) || reservedMobileSchemes.has(appScheme))) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The mobile checkout return scheme is invalid.", 400);
  }
  return {
    extension: value.extension,
    clientKey: value.clientKey,
    successUrl: value.successUrl,
    failUrl: value.failUrl,
    appScheme,
  };
}

function checkoutPreparation(value: ChikCheckoutPreparation): ChikCheckoutPreparation {
  if (!value || typeof value.requestId !== "string" || !value.requestId.trim()
    || value.requestId.trim() !== value.requestId
    || new TextEncoder().encode(value.requestId).byteLength > 512
    || typeof value.orderId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/u.test(value.orderId)
    || typeof value.orderName !== "string" || !value.orderName.trim() || value.orderName.trim() !== value.orderName
    || [...value.orderName].length > 100
    || !Number.isSafeInteger(value.amount) || value.amount <= 0 || value.currency !== "KRW"
    || typeof value.customerKey !== "string" || (value.customerKey !== "ANONYMOUS"
      && !/^(?=.{2,50}$)(?=.*[-_=.@])[A-Za-z0-9_=.@-]+$/u.test(value.customerKey))
    || typeof value.approvalCapability !== "string" || !approvalCapabilityPattern.test(value.approvalCapability)) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout preparation is invalid.", 400);
  }
  return value;
}

function intentNavigation(value: string): {
  url: string;
  fallbackUrl: string;
  androidPackages: readonly [string];
} | undefined {
  const marker = "#Intent;";
  const index = value.indexOf(marker);
  if (index < 0 || !value.endsWith(";end")) return undefined;
  const base = value.slice(0, index);
  const fields = new Map<string, string>();
  for (const field of value.slice(index + marker.length, -4).split(";")) {
    const equal = field.indexOf("=");
    if (equal < 1) continue;
    const name = field.slice(0, equal);
    if ((name === "scheme" || name === "package" || name === "S.browser_fallback_url") && fields.has(name)) return undefined;
    fields.set(name, field.slice(equal + 1));
  }
  const scheme = fields.get("scheme");
  if (!scheme || !reviewedCheckoutSchemes.has(scheme)) return undefined;
  const packageName = fields.get("package");
  if (!packageName || !reviewedAndroidCheckoutPackages[scheme]?.includes(packageName)) return undefined;
  const url = base.startsWith("intent://") ? `${scheme}://${base.slice(9)}` : base.replace(/^intent:/u, `${scheme}:`);
  const fallback = fields.get("S.browser_fallback_url");
  let fallbackUrl: string;
  if (fallback) {
    try { fallbackUrl = decodeURIComponent(fallback); } catch { return undefined; }
    if (!reviewedFallback(fallbackUrl, packageName)) return undefined;
    if (new URL(fallbackUrl).protocol === "market:") {
      fallbackUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`;
    }
  } else {
    fallbackUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`;
  }
  return { url, fallbackUrl, androidPackages: [packageName] };
}

function checkoutReturnNavigation(
  config: Required<ChikCheckoutBridgeConfiguration>,
  wrapper: URL,
): ChikCheckoutNavigation {
  const rootPath = wrapper.pathname === "" || wrapper.pathname === "/";
  const nestedValues = wrapper.searchParams.getAll("url");
  if (nestedValues.length === 0) {
    if (!wrapper.username && !wrapper.password && !wrapper.host && rootPath && !wrapper.hash
      && [...wrapper.searchParams.keys()].length === 0) return { action: "restore" };
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout return URL is invalid.", 400);
  }
  if (wrapper.username || wrapper.password || wrapper.host || !rootPath || wrapper.hash
    || nestedValues.length !== 1 || [...wrapper.searchParams.keys()].some((name) => name !== "url")) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout return URL is invalid.", 400);
  }
  const nestedValue = nestedValues[0]!;
  if (!nestedValue || nestedValue.length > 16 * 1024) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout return URL is invalid.", 400);
  }
  let nested: URL;
  try { nested = new URL(nestedValue); } catch {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout return URL is invalid.", 400);
  }
  if (nested.protocol !== "https:" || nested.username || nested.password || nested.hash) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout return URL is invalid.", 400);
  }
  const redirect = checkoutRedirect(config, nested.href);
  if (redirect === undefined && !reviewedAppReturnHttpsNavigation(nested)) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout return URL is invalid.", 400);
  }
  return { action: "resume", url: nested.href };
}

function checkoutCallbacks(
  config: Required<ChikCheckoutBridgeConfiguration>,
  approvalCapability: string,
): { readonly successUrl: string; readonly failUrl: string } {
  if (!approvalCapabilityPattern.test(approvalCapability)) {
    throw new ChikCheckoutError(ChikErrorCode.invalidArgument, "The checkout approval capability is invalid.", 400);
  }
  return {
    successUrl: checkoutCallback(config.successUrl, approvalCapability),
    failUrl: checkoutCallback(config.failUrl, approvalCapability),
  };
}

function checkoutCallback(value: string, approvalCapability: string): string {
  const url = new URL(value);
  url.searchParams.set(checkoutStateParameter, approvalCapability);
  return url.href;
}

function checkoutFailure(code: string): Pick<Extract<ChikCheckoutRedirect, { status: "failed" }>, "code" | "message"> {
  if (code === "CHECKOUT_CANCELED" || code === "PAY_PROCESS_CANCELED" || code === "canceled") {
    return { code: "canceled", message: "Checkout was canceled." };
  }
  if (code === "CHECKOUT_UI_UNAVAILABLE" || code === "ui_unavailable") {
    return { code: "ui_unavailable", message: "The checkout UI could not be loaded." };
  }
  return { code: "payment_failed", message: "Checkout could not be completed." };
}

function checkoutFailureUrl(
  config: Required<ChikCheckoutBridgeConfiguration>,
  value: ChikCheckoutPreparation,
  code: ChikCheckoutFailureCode,
): string {
  const url = new URL(checkoutCallback(config.failUrl, value.approvalCapability));
  const failure = checkoutFailure(code);
  url.searchParams.set("code", failure.code);
  url.searchParams.set("message", failure.message);
  url.searchParams.set("orderId", value.orderId);
  return url.href;
}

function replaceCheckoutLocation(url: string): void {
  if (typeof location === "undefined") {
    throw new ChikCheckoutError(ChikErrorCode.failedPrecondition, "The web checkout bridge requires a browser location.", 412);
  }
  location.replace(url);
}

function safeCheckoutPageNavigation(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && url.port === "";
}

function reviewedAppReturnHttpsNavigation(url: URL): boolean {
  return safeCheckoutPageNavigation(url) && !url.hash
    && reviewedAppReturnHttpsHosts.has(url.hostname);
}

function reviewedFallback(value: string, packageName: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash || singleSearchParameter(url, "id") !== packageName
    || [...url.searchParams.keys()].some((name) => name !== "id")) return false;
  if (url.protocol === "market:") return url.hostname === "details" && (url.pathname === "" || url.pathname === "/");
  return url.protocol === "https:" && url.hostname === "play.google.com" && url.pathname === "/store/apps/details";
}

function loadReviewedCheckoutScript(): Promise<ReviewedPaymentsGlobal> {
  if (typeof document === "undefined") {
    return Promise.reject(new ChikCheckoutError(ChikErrorCode.failedPrecondition, "The web checkout bridge requires a browser document.", 412));
  }
  const existing = (globalThis as { TossPayments?: ReviewedPaymentsGlobal }).TossPayments;
  if (reviewedPayments !== undefined && existing === reviewedPayments) return Promise.resolve(existing);
  if (reviewedPayments !== undefined && existing !== reviewedPayments) {
    reviewedPayments = undefined;
    scriptPromise = undefined;
  }
  if (scriptPromise) return scriptPromise;
  const pending = document.querySelector<HTMLScriptElement>('script[data-chik-checkout-sdk="v1"]');
  if (pending) {
    if (pending.src !== reviewedCheckoutScript) {
      return Promise.reject(new ChikCheckoutError(
        ChikErrorCode.invalidResponse,
        "The checkout script response is invalid.",
        502,
      ));
    }
    if (pending.dataset.chikCheckoutSdkState === "loaded") {
      if (typeof existing !== "function") {
        return Promise.reject(new ChikCheckoutError(
          ChikErrorCode.invalidResponse,
          "The checkout script response is invalid.",
          502,
        ));
      }
      reviewedPayments = existing;
      return Promise.resolve(existing);
    }
    const result = checkoutScriptResult(pending).catch((error) => { scriptPromise = undefined; throw error; });
    scriptPromise = result;
    return result;
  }
  const result = new Promise<ReviewedPaymentsGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = reviewedCheckoutScript;
    script.async = true;
    script.dataset.chikCheckoutSdk = "v1";
    script.dataset.chikCheckoutSdkState = "loading";
    checkoutScriptResult(script).then(resolve, reject);
    document.head.append(script);
  }).catch((error) => { scriptPromise = undefined; throw error; });
  scriptPromise = result;
  return result;
}

function checkoutScriptResult(script: HTMLScriptElement): Promise<ReviewedPaymentsGlobal> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.removeEventListener("load", complete);
      script.removeEventListener("error", failed);
      callback();
    };
    const complete = () => {
      const loaded = (globalThis as { TossPayments?: ReviewedPaymentsGlobal }).TossPayments;
      finish(() => {
        if (typeof loaded === "function") {
          script.dataset.chikCheckoutSdkState = "loaded";
          reviewedPayments = loaded;
          resolve(loaded);
        }
        else reject(new ChikCheckoutError(
          ChikErrorCode.invalidResponse,
          "The checkout script response is invalid.",
          502,
        ));
      });
    };
    const failed = () => finish(() => {
      script.dataset.chikCheckoutSdkState = "failed";
      reject(new ChikCheckoutError(ChikErrorCode.unavailable, "The checkout UI could not be loaded.", 503));
    });
    const timer = setTimeout(failed, 15_000);
    script.addEventListener("load", complete, { once: true });
    script.addEventListener("error", failed, { once: true });
  });
}

function escapeInlineJSON(value: string): string {
  return value.replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e").replace(/&/gu, "\\u0026");
}
