// Code generated from apps/chickinfry/internal/extensions/payments/toss/key-profiles.json; DO NOT EDIT.

export const TossKeyEnvironment = {
  test: "test",
  live: "live",
} as const;

export const TossCheckoutProfile = {
  widgets: "widgets",
  payment: "payment",
} as const;

export const TOSS_PENDING_URL_UNSUPPORTED_MESSAGE = "extension payments/toss supports domestic KRW synchronous checkout only; foreign asynchronous pendingUrl and CANCEL_STATUS_CHANGED are unsupported and fail closed";

export const TOSS_REVIEWED_APP_RETURN_HTTPS_HOSTS = [
  "connect.tosspayments.com",
  "pages.tosspayments.com",
  "payment-gateway.tosspayments.com",
  "payment-gateway-sandbox.tosspayments.com",
  "payment-gateway-stable.tosspayments.com",
  "payment-gateway-stable-sandbox.tosspayments.com",
  "payment-widget.tosspayments.com",
  "online-pay.kakao.com",
  "online-payment.kakaopay.com",
] as const;

export type TossKeyEnvironment = typeof TossKeyEnvironment[keyof typeof TossKeyEnvironment];
export type TossCheckoutProfile = typeof TossCheckoutProfile[keyof typeof TossCheckoutProfile];
export interface TossKeyProfile { readonly environment: TossKeyEnvironment; readonly profile: TossCheckoutProfile; readonly paymentTypeInRedirect: boolean }

const environments = new Set<TossKeyEnvironment>(Object.values(TossKeyEnvironment));
const clientMarkers = new Map<string, TossCheckoutProfile>([
  ["gck", TossCheckoutProfile.widgets],
  ["ck", TossCheckoutProfile.payment],
]);
const serverMarkers = new Map<string, TossCheckoutProfile>([
  ["gsk", TossCheckoutProfile.widgets],
  ["sk", TossCheckoutProfile.payment],
]);
const paymentTypeInRedirect = new Map<TossCheckoutProfile, boolean>([
  [TossCheckoutProfile.widgets, true],
  [TossCheckoutProfile.payment, false],
]);
const keyPattern = /^([a-z]+)_([a-z]+)_([A-Za-z0-9_-]+)$/u;

export function tossClientKeyProfile(value: unknown): TossKeyProfile | undefined {
  return tossKeyProfile(value, clientMarkers);
}

export function tossServerKeyProfile(value: unknown): TossKeyProfile | undefined {
  return tossKeyProfile(value, serverMarkers);
}

function tossKeyProfile(value: unknown, markers: ReadonlyMap<string, TossCheckoutProfile>): TossKeyProfile | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const match = keyPattern.exec(value);
  if (!match?.[1] || !match[2] || !environments.has(match[1] as TossKeyEnvironment)) return undefined;
  const profile = markers.get(match[2]);
  return profile === undefined ? undefined : { environment: match[1] as TossKeyEnvironment, profile, paymentTypeInRedirect: paymentTypeInRedirect.get(profile)! };
}
