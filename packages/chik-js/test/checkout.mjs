import assert from "node:assert/strict";
import test from "node:test";

import {
  ChikCheckoutError,
  classifyChikCheckoutNavigation,
  createChikMobileCheckoutDocument,
  createChikWebCheckoutBridge,
  parseChikCheckoutRedirect,
} from "../dist/index.js";
import {
  completeChikReactNativeCheckout,
  presentChikReactNativeCheckout,
  recoverChikReactNativeCheckout,
  restoreChikReactNativeCheckout,
} from "../dist/react-native-checkout.js";
import { TOSS_REVIEWED_APP_RETURN_HTTPS_HOSTS } from "../dist/toss-key-profiles.generated.js";

const approvalCapability = "a".repeat(43);
const sessionScope = "c".repeat(64);
const reviewedCheckoutScript = "https://js.tosspayments.com/v2/standard";
const activeSessionSignal = () => new AbortController().signal;

const webConfiguration = {
  extension: "payments/toss",
  clientKey: "test_gck_checkout_test",
  successUrl: "https://example.test/payments/success",
  failUrl: "https://example.test/payments/fail",
};

const mobileConfiguration = {
  ...webConfiguration,
  appScheme: "exampleapp",
};

const individualWebConfiguration = {
  ...webConfiguration,
  clientKey: "test_ck_checkout_test",
};

const individualMobileConfiguration = {
  ...individualWebConfiguration,
  appScheme: "exampleapp",
};

const preparation = {
  requestId: "request-1",
  orderId: "order-1",
  orderName: "Order one",
  amount: 15_000,
  currency: "KRW",
  customerKey: "customer-1",
  approvalCapability,
};

function successUrl(overrides = {}) {
  const url = new URL(webConfiguration.successUrl);
  const values = {
    paymentKey: "payment-key-1",
    orderId: preparation.orderId,
    amount: String(preparation.amount),
    paymentType: "NORMAL",
    chikCheckoutState: approvalCapability,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function returnUrl(nested) {
  const url = new URL(`${mobileConfiguration.appScheme}://`);
  url.searchParams.set("url", nested);
  return url.toString();
}

function failureUrl(overrides = {}) {
  const url = new URL(webConfiguration.failUrl);
  const values = {
    code: "PAY_PROCESS_CANCELED",
    message: "provider detail that must not escape",
    orderId: preparation.orderId,
    chikCheckoutState: approvalCapability,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function expectInvalidRedirect(url, configuration = mobileConfiguration) {
  assert.throws(
    () => parseChikCheckoutRedirect(configuration, url),
    (error) =>
      error instanceof ChikCheckoutError && error.code === "invalid_argument",
  );
}

function expectInvalidNavigation(url, platform = "ios") {
  assert.throws(
    () => classifyChikCheckoutNavigation(mobileConfiguration, url, platform),
    (error) =>
      error instanceof ChikCheckoutError && error.code === "invalid_argument",
  );
}

async function withGlobal(name, value, callback) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, previous);
  }
}

async function withReviewedPayments(value, callback) {
  const marker = {
    src: reviewedCheckoutScript,
    dataset: {
      chikCheckoutSdk: "v1",
      chikCheckoutSdkState: "loaded",
    },
  };
  return withGlobal("TossPayments", value, () => withGlobal(
    "document",
    { querySelector: () => marker },
    callback,
  ));
}

test("checkout redirects accept success and normalize provider failures", () => {
  const expectedSuccess = {
    status: "success",
    paymentKey: "payment-key-1",
    orderId: preparation.orderId,
    amount: preparation.amount,
    paymentType: "NORMAL",
    approvalCapability,
  };
  assert.deepEqual(
    parseChikCheckoutRedirect(mobileConfiguration, successUrl()),
    expectedSuccess,
  );
  assert.deepEqual(
    parseChikCheckoutRedirect(individualMobileConfiguration, successUrl({ paymentType: undefined })),
    expectedSuccess,
  );
  assert.deepEqual(
    createChikWebCheckoutBridge(individualWebConfiguration).redirect(successUrl({ paymentType: undefined })),
    expectedSuccess,
  );

  const canceled = parseChikCheckoutRedirect(
    mobileConfiguration,
    failureUrl(),
  );
  assert.deepEqual(canceled, {
    status: "failed",
    code: "canceled",
    message: "Checkout was canceled.",
    orderId: preparation.orderId,
  });
  assert.doesNotMatch(
    JSON.stringify(canceled),
    /PAY_PROCESS_CANCELED|provider detail/,
  );

  const unavailable = parseChikCheckoutRedirect(
    mobileConfiguration,
    failureUrl({
      code: "CHECKOUT_UI_UNAVAILABLE",
      message: "provider SDK boot detail",
    }),
  );
  assert.equal(unavailable.code, "ui_unavailable");
  assert.equal(unavailable.message, "The checkout UI could not be loaded.");
  assert.doesNotMatch(
    JSON.stringify(unavailable),
    /CHECKOUT_UI_UNAVAILABLE|provider SDK/,
  );

  const failed = parseChikCheckoutRedirect(
    mobileConfiguration,
    failureUrl({
      code: "SOME_PROVIDER_CODE",
      message: "provider stack detail",
    }),
  );
  assert.equal(failed.code, "payment_failed");
  assert.equal(failed.message, "Checkout could not be completed.");
  assert.doesNotMatch(
    JSON.stringify(failed),
    /SOME_PROVIDER_CODE|provider stack/,
  );
});

test("success amount is an ASCII decimal integer only", () => {
  for (const amount of [
    "1e3",
    "+15000",
    "15000.0",
    " 15000",
    "15000 ",
    "1500\u0660",
  ]) {
    expectInvalidRedirect(successUrl({ amount }));
  }
});

test("checkout supports KRW and NORMAL payment callbacks only", () => {
  assert.throws(
    () => createChikMobileCheckoutDocument(mobileConfiguration, { ...preparation, currency: "USD" }),
    (error) => error instanceof ChikCheckoutError
      && error.code === "invalid_argument"
      && error.status === 400,
  );
  expectInvalidRedirect(successUrl({ paymentType: "BRANDPAY" }));
  expectInvalidRedirect(successUrl({ paymentType: undefined }));
  expectInvalidRedirect(successUrl(), individualMobileConfiguration);
  const duplicatePaymentType = new URL(successUrl({ paymentType: undefined }));
  duplicatePaymentType.searchParams.append("paymentType", "NORMAL");
  duplicatePaymentType.searchParams.append("paymentType", "NORMAL");
  expectInvalidRedirect(duplicatePaymentType.href, individualMobileConfiguration);

  assert.throws(
    () => createChikMobileCheckoutDocument(
      { ...mobileConfiguration, successUrl: `${mobileConfiguration.successUrl}?paymentType=NORMAL` },
      preparation,
    ),
    (error) => error instanceof ChikCheckoutError && error.code === "invalid_argument",
  );
});

test("mobile checkout rejects ambiguous callbacks and reserved schemes", () => {
  for (const configuration of [
    { ...mobileConfiguration, failUrl: mobileConfiguration.successUrl },
    {
      ...mobileConfiguration,
      successUrl: "https://example.test/payments/return",
      failUrl: "https://example.test/payments/return?outcome=failed",
    },
    { ...mobileConfiguration, appScheme: "supertoss" },
    { ...mobileConfiguration, appScheme: "intent" },
    { ...mobileConfiguration, appScheme: "javascript" },
  ]) {
    assert.throws(
      () => createChikMobileCheckoutDocument(configuration, preparation),
      (error) => error instanceof ChikCheckoutError
        && error.code === "invalid_argument",
    );
  }
  assert.throws(
    () => createChikMobileCheckoutDocument(
      mobileConfiguration,
      { ...preparation, orderId: "order=1" },
    ),
    (error) => error instanceof ChikCheckoutError
      && error.code === "invalid_argument",
  );
});

test("redirect validation rejects forged, duplicate, and oversized URLs", () => {
  expectInvalidRedirect(
    successUrl({ chikCheckoutState: "too-short" }),
  );

  const duplicatePaymentKey = new URL(successUrl());
  duplicatePaymentKey.searchParams.append("paymentKey", "forged-key");
  expectInvalidRedirect(duplicatePaymentKey.toString());

  const duplicateCapability = new URL(successUrl());
  duplicateCapability.searchParams.append(
    "chikCheckoutState",
    approvalCapability,
  );
  expectInvalidRedirect(duplicateCapability.toString());

  const wrongOrigin = new URL(successUrl());
  wrongOrigin.hostname = "attacker.test";
  expectInvalidRedirect(wrongOrigin.toString());

  const wrongPath = new URL(successUrl());
  wrongPath.pathname = "/payments/other";
  expectInvalidRedirect(wrongPath.toString());

  const credentialed = new URL(successUrl());
  credentialed.username = "attacker";
  expectInvalidRedirect(credentialed.toString());

  const fragmented = new URL(successUrl());
  fragmented.hash = "forged";
  expectInvalidRedirect(fragmented.toString());

  expectInvalidRedirect(
    `${webConfiguration.successUrl}?payload=${"x".repeat(17_000)}`,
  );
});

test("React Native checkout classifies an invalid host response as upstream failure", async () => {
  const cause = "not-a-checkout-return";
  await assert.rejects(
    presentChikReactNativeCheckout(
      mobileConfiguration,
      preparation,
      { present: async () => cause },
      sessionScope,
      activeSessionSignal(),
    ),
    (error) => error instanceof ChikCheckoutError
      && error.code === "invalid_response"
      && error.status === 502
      && error.cause instanceof ChikCheckoutError
      && error.cause.code === "invalid_argument",
  );
});

test("React Native checkout binds callbacks to the active preparation", async () => {
  for (const redirectUrl of [
    successUrl({ chikCheckoutState: "b".repeat(43) }),
    successUrl({ orderId: "order-2" }),
    successUrl({ amount: "15001" }),
    failureUrl({ chikCheckoutState: "b".repeat(43) }),
    failureUrl({ orderId: "order-2" }),
  ]) {
    await assert.rejects(
      presentChikReactNativeCheckout(
        mobileConfiguration,
        preparation,
        { present: async () => redirectUrl },
        sessionScope,
        activeSessionSignal(),
      ),
      (error) => error instanceof ChikCheckoutError
        && error.code === "invalid_response"
        && error.status === 502,
    );
  }
});

test("React Native checkout rejects a forged completion before the host can persist it", async () => {
  const forged = successUrl({ chikCheckoutState: "b".repeat(43) });
  const result = await presentChikReactNativeCheckout(
    mobileConfiguration,
    preparation,
    {
      platform: "ios",
      async present(presentation) {
        assert.throws(
          () => presentation.navigate(forged),
          (error) => error instanceof ChikCheckoutError
            && error.code === "invalid_response"
            && error.status === 502,
        );
        return successUrl();
      },
    },
    sessionScope,
    activeSessionSignal(),
  );
  assert.equal(result.status, "success");
});

test("React Native checkout normalizes custom host failures", async () => {
  const cause = new Error("raw custom host detail");
  await assert.rejects(
    presentChikReactNativeCheckout(
      mobileConfiguration,
      preparation,
      { present: async () => { throw cause; } },
      sessionScope,
      activeSessionSignal(),
    ),
    (error) => error instanceof ChikCheckoutError
      && error.code === "unavailable"
      && error.status === 503
      && error.cause === cause
      && !String(error).includes(cause.message),
  );
});

test("React Native checkout requires the current native session scope", async () => {
  await assert.rejects(
    presentChikReactNativeCheckout(
      mobileConfiguration,
      preparation,
      { present: async () => successUrl() },
      undefined,
      activeSessionSignal(),
    ),
    (error) => error instanceof ChikCheckoutError
      && error.code === "unauthenticated"
      && error.status === 401,
  );
});

test("React Native checkout restores and clears the exact pending session", async () => {
  const completed = [];
  const host = {
    platform: "ios",
    async present() { throw new Error("a restored redirect must not open a new UI"); },
    async restoreCheckout(scope) {
      assert.equal(scope, sessionScope);
      return { preparation, redirectUrl: successUrl() };
    },
    async completeCheckout(capability, scope) {
      assert.equal(scope, sessionScope);
      completed.push(capability);
    },
  };
  const restored = await restoreChikReactNativeCheckout(mobileConfiguration, host, sessionScope);
  assert.deepEqual(restored, {
    preparation,
    redirect: parseChikCheckoutRedirect(mobileConfiguration, successUrl()),
  });
  await completeChikReactNativeCheckout(restored.preparation, host, sessionScope);
  assert.deepEqual(completed, [approvalCapability]);
});

test("React Native pending recovery clears before reprepare and preserves completed redirects", async () => {
  const nextPreparation = {
    ...preparation,
    requestId: "request-2",
    orderId: "order-2",
    approvalCapability: "b".repeat(43),
  };
  const events = [];
  let pending = { preparation };
  const host = {
    async present() { throw new Error("must not present"); },
    async completeCheckout(capability, scope) {
      assert.equal(capability, pending.preparation.approvalCapability);
      assert.equal(scope, sessionScope);
      events.push("clear");
      pending = undefined;
    },
  };
  const recovered = await recoverChikReactNativeCheckout(
    pending,
    host,
    sessionScope,
    async () => {
      assert.equal(pending, undefined);
      events.push("prepare");
      return nextPreparation;
    },
  );
  assert.deepEqual(recovered, { preparation: nextPreparation });
  assert.deepEqual(events, ["clear", "prepare"]);

  const completed = {
    preparation,
    redirect: parseChikCheckoutRedirect(mobileConfiguration, successUrl()),
  };
  assert.equal(
    await recoverChikReactNativeCheckout(completed, host, sessionScope, async () => {
      throw new Error("a completed redirect must not be prepared again");
    }),
    completed,
  );
  assert.deepEqual(events, ["clear", "prepare"]);
});

test("React Native credential conflicts leave recovery empty for the next request", async () => {
  let pending = { preparation };
  const host = {
    async present() { throw new Error("must not present"); },
    async completeCheckout() { pending = undefined; },
  };
  await assert.rejects(
    recoverChikReactNativeCheckout(pending, host, sessionScope, async () => {
      assert.equal(pending, undefined);
      throw new ChikCheckoutError("aborted", "The checkout request conflicts with an existing order.", 409);
    }),
    (error) => error instanceof ChikCheckoutError && error.code === "aborted" && error.status === 409,
  );
  const next = await recoverChikReactNativeCheckout(undefined, host, sessionScope, async () => ({
    ...preparation,
    requestId: "request-2",
    orderId: "order-2",
    approvalCapability: "b".repeat(43),
  }));
  assert.equal(next.preparation.requestId, "request-2");
});

test("React Native recovery does not prepare when pending cleanup fails", async () => {
  const pending = { preparation };
  let prepareCalls = 0;
  const host = {
    async present() { throw new Error("must not present"); },
    async completeCheckout() { throw new Error("secure storage unavailable"); },
  };
  await assert.rejects(
    recoverChikReactNativeCheckout(pending, host, sessionScope, async () => {
      prepareCalls += 1;
      return preparation;
    }),
    (error) => error instanceof ChikCheckoutError && error.code === "storage_error",
  );
  assert.equal(prepareCalls, 0);
  assert.deepEqual(pending, { preparation });
});

test("React Native recovery rechecks the session after pending cleanup", async () => {
  let active = true;
  let prepareCalls = 0;
  const host = {
    async present() { throw new Error("must not present"); },
    async completeCheckout() { active = false; },
  };
  await assert.rejects(
    recoverChikReactNativeCheckout(
      { preparation },
      host,
      sessionScope,
      async () => {
        if (!active) throw new ChikCheckoutError("unauthenticated", "The customer session changed during checkout.", 401);
        prepareCalls += 1;
        return preparation;
      },
    ),
    (error) => error instanceof ChikCheckoutError && error.code === "unauthenticated",
  );
  assert.equal(prepareCalls, 0);
});

test("invalid restored redirects clear only the matching pending checkout", async () => {
  for (const redirectUrl of [
    "https://attacker.example/complete",
    successUrl({ chikCheckoutState: "b".repeat(43) }),
  ]) {
    let pending = { preparation, redirectUrl };
    const completed = [];
    const host = {
      platform: "ios",
      async restoreCheckout(scope) {
        assert.equal(scope, sessionScope);
        return pending;
      },
      async completeCheckout(capability, scope) {
        assert.equal(scope, sessionScope);
        assert.equal(capability, approvalCapability);
        completed.push(capability);
        pending = undefined;
      },
    };
    await assert.rejects(
      restoreChikReactNativeCheckout(mobileConfiguration, host, sessionScope),
      (error) => error instanceof ChikCheckoutError
        && error.code === "invalid_response"
        && error.status === 502,
    );
    assert.deepEqual(completed, [approvalCapability]);
    assert.equal(await restoreChikReactNativeCheckout(mobileConfiguration, host, sessionScope), undefined);
  }
});

test("shared mobile contract allows pages, opens apps, falls back, and completes", async () => {
  const document = createChikMobileCheckoutDocument(
    mobileConfiguration,
    {
      ...preparation,
      orderName: "Order </script><script>globalThis.pwned=true</script>",
    },
  );
  assert.doesNotMatch(
    document,
    /Order <\/script><script>globalThis\.pwned=true<\/script>/,
  );
  assert.match(document, /\\u003c\/script\\u003e/);
  assert.match(document, /chikCheckoutState/);
  assert.match(document, /exampleapp/);
  assert.match(document, /payments\.widgets/);

  for (const host of TOSS_REVIEWED_APP_RETURN_HTTPS_HOSTS) {
    assert.deepEqual(
      classifyChikCheckoutNavigation(
        mobileConfiguration,
        `https://${host}/widget`,
        "ios",
      ),
      { action: "allow" },
    );
  }
  assert.deepEqual(
    classifyChikCheckoutNavigation(
      mobileConfiguration,
      "https://mobile.vpay.co.kr/jsp/MISP/bcAppPay.jsp#state",
      "ios",
    ),
    { action: "allow" },
  );

  const resumed = "https://payment-widget.tosspayments.com/resume";
  assert.deepEqual(
    classifyChikCheckoutNavigation(
      mobileConfiguration,
      returnUrl(resumed),
      "ios",
    ),
    { action: "resume", url: resumed },
  );
  assert.deepEqual(
    classifyChikCheckoutNavigation(
      mobileConfiguration,
      returnUrl(resumed).replace("://?", ":///?"),
      "ios",
    ),
    { action: "resume", url: resumed },
  );

  assert.deepEqual(
    classifyChikCheckoutNavigation(
      mobileConfiguration,
      "supertoss://payments/open",
      "ios",
    ),
    {
      action: "external",
      url: "supertoss://payments/open",
      fallbackUrl: "https://apps.apple.com/app/id839333328",
    },
  );

  const intentUrl =
    "intent://payments/open#Intent;scheme=supertoss;package=viva.republica.toss;end";
  assert.deepEqual(
    classifyChikCheckoutNavigation(mobileConfiguration, intentUrl, "android"),
    {
      action: "external",
      url: "supertoss://payments/open",
      fallbackUrl: "https://play.google.com/store/apps/details?id=viva.republica.toss",
      androidPackages: ["viva.republica.toss"],
    },
  );

  assert.deepEqual(
    classifyChikCheckoutNavigation(
      mobileConfiguration,
      "supertoss://payments/open",
      "android",
    ),
    {
      action: "external",
      url: "supertoss://payments/open",
      fallbackUrl: "https://play.google.com/store/apps/details?id=viva.republica.toss",
      androidPackages: ["viva.republica.toss"],
    },
  );

  for (const [scheme, androidPackage] of [
    ["v3mobileplusweb", "com.ahnlab.v3mobileplus"],
    ["kakaotalk", "com.kakao.talk"],
    ["kftc-bankpay", "com.kftc.bankpay.android"],
    ["naversearchthirdlogin", "com.nhn.android.search"],
    ["wooripay", "com.wooricard.wpay"],
  ]) {
    const decision = classifyChikCheckoutNavigation(
      mobileConfiguration,
      `intent://payments/open#Intent;scheme=${scheme};package=${androidPackage};end`,
      "android",
    );
    assert.equal(decision.action, "external");
    assert.deepEqual(decision.androidPackages, [androidPackage]);
  }

  for (const [scheme, androidPackages] of [
    ["samsungpay", ["com.samsung.android.spay", "com.samsung.android.spaylite"]],
    ["com.wooricard.wcard", ["com.wooricard.wcard", "com.wooricard.smartapp"]],
    ["cloudpay", ["com.hanaskcard.paycla", "com.hanaskcard.rocomo.potal"]],
  ]) {
    const decision = classifyChikCheckoutNavigation(
      mobileConfiguration,
      `${scheme}://payments/open`,
      "android",
    );
    assert.equal(decision.action, "external");
    assert.deepEqual(decision.androidPackages, androidPackages);
    assert.equal(
      decision.fallbackUrl,
      `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidPackages[0])}`,
    );
  }

  const opened = [];
  let failPrimary = true;
  async function fakeHostNavigate(url) {
    const decision = classifyChikCheckoutNavigation(
      mobileConfiguration,
      url,
      "android",
    );
    if (decision.action !== "external") return decision;
    try {
      opened.push([decision.url, decision.androidPackages]);
      if (failPrimary) {
        failPrimary = false;
        throw new Error("primary app unavailable");
      }
    } catch (error) {
      if (decision.fallbackUrl === undefined) throw error;
      opened.push([decision.fallbackUrl]);
    }
    return { action: "cancel" };
  }

  assert.deepEqual(await fakeHostNavigate(intentUrl), { action: "cancel" });
  assert.deepEqual(opened, [
    ["supertoss://payments/open", ["viva.republica.toss"]],
    ["https://play.google.com/store/apps/details?id=viva.republica.toss"],
  ]);

  const completed = await fakeHostNavigate(successUrl());
  assert.equal(completed.action, "complete");
  assert.equal(completed.redirect.status, "success");
});

test("individual payment keys use the reviewed redirect payment window", async () => {
  const document = createChikMobileCheckoutDocument(individualMobileConfiguration, preparation);
  assert.match(document, /payments\.payment/);
  assert.match(document, /method:\"CARD\"/);
  assert.match(document, /windowTarget:\"self\"/);
  assert.doesNotMatch(document, /payments\.widgets/);

  const requests = [];
  await withReviewedPayments(
    () => ({
      payment({ customerKey }) {
        assert.equal(customerKey, preparation.customerKey);
        return { async requestPayment(value) { requests.push(value); } };
      },
    }),
    async () => {
      const bridge = createChikWebCheckoutBridge(individualWebConfiguration);
      await bridge.present(preparation);
      await bridge.present(preparation);
      await bridge.destroy();
    },
  );

  const success = new URL(individualWebConfiguration.successUrl);
  success.searchParams.set("chikCheckoutState", approvalCapability);
  const failure = new URL(individualWebConfiguration.failUrl);
  failure.searchParams.set("chikCheckoutState", approvalCapability);
  assert.deepEqual(requests, [
    {
      method: "CARD",
      amount: { value: preparation.amount, currency: preparation.currency },
      orderId: preparation.orderId,
      orderName: preparation.orderName,
      successUrl: success.href,
      failUrl: failure.href,
      windowTarget: "self",
      card: { useEscrow: false, flowMode: "DEFAULT", useCardPoint: false, useAppCardOnly: false },
    },
    {
      method: "CARD",
      amount: { value: preparation.amount, currency: preparation.currency },
      orderId: preparation.orderId,
      orderName: preparation.orderName,
      successUrl: success.href,
      failUrl: failure.href,
      windowTarget: "self",
      card: { useEscrow: false, flowMode: "DEFAULT", useCardPoint: false, useAppCardOnly: false },
    },
  ]);
});

test("individual payment setup failures remain UI availability errors", async () => {
  const providerCause = new Error("raw individual payment setup detail");
  await withReviewedPayments(
    () => ({
      payment() { throw providerCause; },
    }),
    async () => {
      const bridge = createChikWebCheckoutBridge(individualWebConfiguration);
      await assert.rejects(bridge.present(preparation), (error) => {
        assert.ok(error instanceof ChikCheckoutError);
        assert.equal(error.code, "unavailable");
        assert.equal(error.status, 503);
        assert.equal(error.message, "The checkout UI could not be loaded.");
        assert.doesNotMatch(String(error), /raw individual payment setup detail/);
        return true;
      });
    },
  );
});

test("mobile navigation rejects forged, duplicate, and oversized URLs", () => {
  for (const url of [
    "https://payment-widget.tosspayments.com:444/widget",
    "evilapp://payments/open",
    "https://attacker@payment-widget.tosspayments.com/widget",
  ]) {
    expectInvalidNavigation(url);
  }
  expectInvalidNavigation(
    "intent://payments/open#Intent;scheme=evilapp;package=evil.package;end",
    "android",
  );
  expectInvalidNavigation(
    "intent://payments/open#Intent;scheme=supertoss;package=com.kakao.talk;end",
    "android",
  );
  expectInvalidNavigation("lmslpay://payments/open", "android");
  expectInvalidNavigation(
    "intent://payments/open#Intent;scheme=supertoss;end",
    "android",
  );
  expectInvalidNavigation(
    "intent://payments/open#Intent;scheme=supertoss;package=viva.republica.toss;end",
    "ios",
  );
  expectInvalidNavigation("kakaobank://payments/open", "ios");

  const duplicate = new URL(successUrl());
  duplicate.searchParams.append("chikCheckoutState", approvalCapability);
  expectInvalidNavigation(duplicate.toString());

  const fragmentedCallback = new URL(successUrl());
  fragmentedCallback.hash = "forged";
  expectInvalidNavigation(fragmentedCallback.toString());

  expectInvalidNavigation(
    `${webConfiguration.successUrl}?payload=${"x".repeat(17_000)}`,
  );

  for (const nested of [
    "http://payment-widget.tosspayments.com/widget",
    "https://attacker.test/widget",
    "https://attacker@payment-widget.tosspayments.com/widget",
    "https://payment-widget.tosspayments.com/widget#fragment",
  ]) {
    expectInvalidNavigation(returnUrl(nested));
  }

  const duplicateNested = new URL(returnUrl("https://payment-widget.tosspayments.com/widget"));
  duplicateNested.searchParams.append("url", "https://payment-widget.tosspayments.com/other");
  expectInvalidNavigation(duplicateNested.toString());
  expectInvalidNavigation(
    `${mobileConfiguration.appScheme}:///unexpected?url=${encodeURIComponent("https://payment-widget.tosspayments.com/widget")}`,
  );

  assert.throws(
    () => classifyChikCheckoutNavigation(
      mobileConfiguration,
      `${mobileConfiguration.appScheme}://return-without-reviewed-shape`,
      "ios",
    ),
    (error) => error instanceof ChikCheckoutError && error.code === "invalid_argument",
  );
  assert.deepEqual(
    classifyChikCheckoutNavigation(mobileConfiguration, `${mobileConfiguration.appScheme}://`, "ios"),
    { action: "restore" },
  );
  assert.deepEqual(
    classifyChikCheckoutNavigation(mobileConfiguration, `${mobileConfiguration.appScheme}:///`, "ios"),
    { action: "restore" },
  );
});

test("web checkout normalizes provider setup failures", async () => {
  const providerCause = new Error("raw provider setup detail");
  await withReviewedPayments(
    () => {
      throw providerCause;
    },
    async () => {
      const bridge = createChikWebCheckoutBridge(webConfiguration);
      await assert.rejects(bridge.present(preparation), (error) => {
        assert.ok(error instanceof ChikCheckoutError);
        assert.equal(error.code, "unavailable");
        assert.equal(error.status, 503);
        assert.equal(error.message, "The checkout UI could not be loaded.");
        assert.doesNotMatch(String(error), /raw provider setup detail/);
        assert.equal(error.cause, undefined);
        return true;
      });
    },
  );
});

test("web checkout normalizes reviewed script loading failure", async () => {
  let unreviewedGlobalCalled = false;
  const listeners = new Map();
  const script = {
    src: "",
    async: false,
    dataset: {},
    addEventListener(event, listener) {
      listeners.set(event, listener);
    },
    removeEventListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
  };
  const document = {
    querySelector() {
      return null;
    },
    createElement() {
      return script;
    },
    head: {
      append() {
        queueMicrotask(() => listeners.get("error")?.());
      },
    },
  };

  await withGlobal("TossPayments", () => {
    unreviewedGlobalCalled = true;
    throw new Error("unreviewed global");
  }, async () => {
    await withGlobal("document", document, async () => {
      const bridge = createChikWebCheckoutBridge(webConfiguration);
      await assert.rejects(bridge.present(preparation), (error) => {
        assert.ok(error instanceof ChikCheckoutError);
        assert.equal(error.code, "unavailable");
        assert.equal(error.status, 503);
        assert.equal(error.message, "The checkout UI could not be loaded.");
        return true;
      });
    });
  });
  assert.equal(unreviewedGlobalCalled, false);
});

test("web checkout reserves opening sessions and destroys a canceled late window", async () => {
  let resolveWindow;
  let destroyCount = 0;
  const rendered = new Promise((resolve) => {
    resolveWindow = resolve;
  });
  const paymentWindow = {
    on() {},
    destroy() { destroyCount += 1; },
  };
  const widgets = {
    async setAmount() {},
    renderPaymentWindow() { return rendered; },
    async requestPayment() {},
  };

  await withReviewedPayments(
    () => ({ widgets: () => widgets }),
    async () => {
      const bridge = createChikWebCheckoutBridge(webConfiguration);
      const opening = bridge.present(preparation);
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(
        bridge.present(preparation),
        (error) => error instanceof ChikCheckoutError
          && error.code === "failed_precondition",
      );
      await bridge.destroy();
      resolveWindow(paymentWindow);
      await assert.rejects(
        opening,
        (error) => error instanceof ChikCheckoutError
          && error.code === "canceled",
      );
    },
  );

  assert.equal(destroyCount, 1);
});

test("web checkout ignores stale window callbacks", async () => {
  const listeners = [new Map(), new Map()];
  const destroyCounts = [0, 0];
  let index = 0;
  const windows = listeners.map((windowListeners, windowIndex) => ({
    on(event, listener) { windowListeners.set(event, listener); },
    destroy() { destroyCounts[windowIndex] += 1; },
  }));
  const widgets = {
    async setAmount() {},
    async renderPaymentWindow() { return windows[index++]; },
    async requestPayment() {},
  };
  const replaced = [];

  await withReviewedPayments(
    () => ({ widgets: () => widgets }),
    async () => {
      await withGlobal("location", { replace: (url) => replaced.push(url) }, async () => {
        const bridge = createChikWebCheckoutBridge(webConfiguration);
        await bridge.present(preparation);
        await bridge.destroy();
        await bridge.present({ ...preparation, requestId: "request-2", orderId: "order-2" });
        listeners[0].get("cancel")();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(destroyCounts, [1, 0]);
        assert.equal(replaced.length, 0);
        listeners[1].get("cancel")();
        await new Promise((resolve) => setImmediate(resolve));
      });
    },
  );

  assert.deepEqual(destroyCounts, [1, 1]);
  assert.equal(replaced.length, 1);
});

test("web checkout keeps a failed close retryable", async () => {
  const closeCause = new Error("close failed");
  let destroyCount = 0;
  const paymentWindow = {
    on() {},
    destroy() {
      destroyCount += 1;
      if (destroyCount === 1) throw closeCause;
    },
  };
  const widgets = {
    async setAmount() {},
    async renderPaymentWindow() { return paymentWindow; },
    async requestPayment() {},
  };

  await withReviewedPayments(
    () => ({ widgets: () => widgets }),
    async () => {
      const bridge = createChikWebCheckoutBridge(webConfiguration);
      await bridge.present(preparation);
      await assert.rejects(bridge.destroy(), (error) => {
        assert.ok(error instanceof ChikCheckoutError);
        assert.equal(error.code, "unavailable");
        assert.equal(error.cause, undefined);
        return true;
      });
      await assert.rejects(
        bridge.present(preparation),
        (error) => error instanceof ChikCheckoutError
          && error.code === "failed_precondition",
      );
      await bridge.destroy();
    },
  );

  assert.equal(destroyCount, 2);
});

test("web checkout cancel emits the canonical failure redirect", async () => {
  const listeners = new Map();
  const replaced = [];
  const paymentWindow = {
    on(event, listener) {
      listeners.set(event, listener);
    },
    destroy() {},
  };
  const widgets = {
    async setAmount() {},
    async renderPaymentWindow() {
      return paymentWindow;
    },
    async requestPayment() {},
  };

  await withReviewedPayments(
    () => ({ widgets: () => widgets }),
    async () => {
      await withGlobal(
        "location",
        { replace: (url) => replaced.push(url) },
        async () => {
          const bridge = createChikWebCheckoutBridge(webConfiguration);
          await bridge.present(preparation);
          assert.equal(typeof listeners.get("cancel"), "function");
          listeners.get("cancel")();
          await new Promise((resolve) => setImmediate(resolve));
        },
      );
    },
  );

  assert.equal(replaced.length, 1);
  assert.deepEqual(
    parseChikCheckoutRedirect(webConfiguration, replaced[0]),
    {
      status: "failed",
      code: "canceled",
      message: "Checkout was canceled.",
      orderId: preparation.orderId,
    },
  );
});
