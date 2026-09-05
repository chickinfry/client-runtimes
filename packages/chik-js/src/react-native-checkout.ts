import {
  ChikCheckoutError,
  classifyChikCheckoutNavigation,
  createChikMobileCheckoutDocument,
  parseChikCheckoutRedirect,
  type ChikCheckoutBridgeConfiguration,
  type ChikCheckoutPreparation,
  type ChikCheckoutRedirect,
  type ChikMobileCheckoutRecovery,
  type ChikMobileCheckoutHost,
} from "./checkout.js";
import { ChikErrorCode } from "./error-contract.js";

export type {
  ChikCheckoutBridgeConfiguration,
  ChikCheckoutErrorCode,
  ChikCheckoutFailureCode,
  ChikCheckoutPreparation,
  ChikCheckoutRedirect,
  ChikMobileCheckoutRecovery,
  ChikMobileCheckoutHost,
} from "./checkout.js";
export { ChikCheckoutError } from "./checkout.js";

export interface ChikRestoredMobileCheckout {
  readonly preparation: ChikCheckoutPreparation;
  readonly redirect?: ChikCheckoutRedirect | undefined;
}

export async function restoreChikReactNativeCheckout(
  configuration: ChikCheckoutBridgeConfiguration,
  host: ChikMobileCheckoutHost,
  sessionScope: string | undefined,
): Promise<ChikRestoredMobileCheckout | undefined> {
  let recovery: ChikMobileCheckoutRecovery | undefined;
  try {
    recovery = await host.restoreCheckout(checkoutSessionScope(sessionScope));
  } catch (cause) {
    if (cause instanceof ChikCheckoutError) throw cause;
    throw new ChikCheckoutError(
      ChikErrorCode.storageError,
      "The pending checkout could not be restored.",
      0,
      { cause },
    );
  }
  if (recovery === undefined) return undefined;
  let preparationValidated = false;
  try {
    createChikMobileCheckoutDocument(configuration, recovery.preparation);
    preparationValidated = true;
    return {
      preparation: recovery.preparation,
      ...(recovery.redirectUrl === undefined ? {} : {
        redirect: parseCheckoutResponse(
          configuration,
          recovery.preparation,
          recovery.redirectUrl,
        ),
      }),
    };
  } catch (cause) {
    if (preparationValidated && cause instanceof ChikCheckoutError && cause.code === ChikErrorCode.invalidResponse) {
      try {
        await host.completeCheckout(recovery.preparation.approvalCapability, checkoutSessionScope(sessionScope));
      } catch (cleanupCause) {
        throw new ChikCheckoutError(
          ChikErrorCode.invalidResponse,
          "The pending checkout record is invalid and could not be cleared.",
          502,
          { cause: new AggregateError([cause, cleanupCause], "Checkout recovery validation and cleanup failed.") },
        );
      }
      throw cause;
    }
    throw new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The pending checkout record is invalid.",
      502,
      { cause },
    );
  }
}

export async function completeChikReactNativeCheckout(
  preparation: ChikCheckoutPreparation,
  host: ChikMobileCheckoutHost,
  sessionScope: string | undefined,
): Promise<void> {
  try {
    await host.completeCheckout(preparation.approvalCapability, checkoutSessionScope(sessionScope));
  } catch (cause) {
    if (cause instanceof ChikCheckoutError) throw cause;
    throw new ChikCheckoutError(
      ChikErrorCode.storageError,
      "The pending checkout could not be cleared.",
      0,
      { cause },
    );
  }
}

export async function recoverChikReactNativeCheckout(
  restored: ChikRestoredMobileCheckout | undefined,
  host: ChikMobileCheckoutHost,
  sessionScope: string | undefined,
  prepare: () => Promise<ChikCheckoutPreparation>,
): Promise<ChikRestoredMobileCheckout> {
  checkoutSessionScope(sessionScope);
  if (restored?.redirect !== undefined) return restored;
  if (restored !== undefined) {
    await completeChikReactNativeCheckout(restored.preparation, host, sessionScope);
  }
  return { preparation: await prepare() };
}

export async function presentChikReactNativeCheckout(
  configuration: ChikCheckoutBridgeConfiguration,
  preparation: ChikCheckoutPreparation,
  host: ChikMobileCheckoutHost,
  sessionScope: string | undefined,
  sessionSignal: AbortSignal | undefined,
): Promise<ChikCheckoutRedirect> {
  const document = createChikMobileCheckoutDocument(configuration, preparation);
  const scope = checkoutSessionScope(sessionScope);
  if (sessionSignal === undefined || sessionSignal.aborted) {
    throw new ChikCheckoutError(ChikErrorCode.unauthenticated, "The customer session changed during checkout.", 401);
  }
  let redirectUrl: string;
  try {
    redirectUrl = await host.present({
      document,
      returnScheme: `${configuration.appScheme ?? ""}://`,
      sessionScope: scope,
      sessionSignal,
      recovery: { preparation },
      navigate: (url) => {
        const decision = classifyChikCheckoutNavigation(configuration, url, host.platform);
        if (decision.action === "complete") parseCheckoutResponse(configuration, preparation, url);
        return decision;
      },
    });
  } catch (cause) {
    if (cause instanceof ChikCheckoutError) throw cause;
    throw new ChikCheckoutError(
      ChikErrorCode.unavailable,
      "The checkout UI could not be displayed.",
      503,
      { cause },
    );
  }
  try {
    return parseCheckoutResponse(configuration, preparation, redirectUrl);
  } catch (cause) {
    if (cause instanceof ChikCheckoutError && cause.code === ChikErrorCode.invalidResponse && cause.status === 502) throw cause;
    throw new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The checkout host response is invalid.",
      502,
      { cause },
    );
  }
}

function checkoutSessionScope(value: string | undefined): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ChikCheckoutError(
      ChikErrorCode.unauthenticated,
      "Checkout requires an authenticated customer session.",
      401,
    );
  }
  return value;
}

function parseCheckoutResponse(
  configuration: ChikCheckoutBridgeConfiguration,
  preparation: ChikCheckoutPreparation,
  redirectUrl: string,
): ChikCheckoutRedirect {
  let redirect: ChikCheckoutRedirect | undefined;
  let cause: unknown;
  try {
    redirect = parseChikCheckoutRedirect(configuration, redirectUrl);
  } catch (error) {
    cause = error;
  }
  const capabilities = redirect === undefined
    ? undefined
    : new URL(redirectUrl).searchParams.getAll("chikCheckoutState");
  if (redirect === undefined || capabilities?.length !== 1 || capabilities[0] !== preparation.approvalCapability
    || (redirect.status === "success" && (redirect.orderId !== preparation.orderId || redirect.amount !== preparation.amount))
    || (redirect.status === "failed" && redirect.orderId !== undefined && redirect.orderId !== preparation.orderId)) {
    throw new ChikCheckoutError(
      ChikErrorCode.invalidResponse,
      "The checkout host response does not match the active checkout.",
      502,
      cause === undefined ? undefined : { cause },
    );
  }
  return redirect;
}
