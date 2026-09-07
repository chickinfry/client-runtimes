import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const returnListeners = new Set();
let initialUrl = null;
let initialError;
const secureRecords = new Map();
const nativePackageOpens = [];
let secureWriteBarrier;
const sessionScope = "c".repeat(64);
const recoveryService = `chik.checkout.${sessionScope}`;

function emitReturnUrl(url) {
  for (const listener of [...returnListeners]) listener({ url });
}

globalThis.__chikReactNativeCheckoutTest = {
  Linking: {
    addEventListener(name, listener) {
      assert.equal(name, "url");
      returnListeners.add(listener);
      return { remove: () => returnListeners.delete(listener) };
    },
    async getInitialURL() {
      if (initialError) throw initialError;
      return initialUrl;
    },
    async openURL() {},
  },
  NativeModules: {
    ChikCheckoutLauncher: {
      async openPackages(url, packageNames) {
        nativePackageOpens.push([url, packageNames]);
        return true;
      },
    },
  },
  Keychain: {
    async getGenericPassword({ service } = {}) {
      const password = secureRecords.get(service);
      return password === undefined ? false : { password };
    },
    async setGenericPassword(_username, password, { service } = {}) {
      if (secureWriteBarrier !== undefined) {
        const barrier = secureWriteBarrier;
        secureWriteBarrier = undefined;
        await barrier;
      }
      secureRecords.set(service, password);
      return true;
    },
    async resetGenericPassword({ service } = {}) {
      secureRecords.delete(service);
      return true;
    },
  },
};

const nativeHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "react-native" || specifier === "react-native-webview" || specifier === "react-native-keychain") {
      return { shortCircuit: true, url: `chik-test:${specifier}` };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "chik-test:react-native") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const Linking = globalThis.__chikReactNativeCheckoutTest.Linking;
          export const ActivityIndicator = "ActivityIndicator";
          export const Button = "Button";
          export const Modal = "Modal";
          export const NativeModules = globalThis.__chikReactNativeCheckoutTest.NativeModules;
          export const Platform = { OS: "android" };
          export const View = "View";
        `,
      };
    }
    if (url === "chik-test:react-native-webview") {
      return { format: "module", shortCircuit: true, source: 'export const WebView = "WebView";' };
    }
    if (url === "chik-test:react-native-keychain") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const getGenericPassword = globalThis.__chikReactNativeCheckoutTest.Keychain.getGenericPassword;
          export const setGenericPassword = globalThis.__chikReactNativeCheckoutTest.Keychain.setGenericPassword;
          export const resetGenericPassword = globalThis.__chikReactNativeCheckoutTest.Keychain.resetGenericPassword;
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { ChikReactNativeMobileCheckoutHost } = await import("../dist/react-native-checkout-host.js");
const { ChikCheckoutError } = await import("../dist/react-native-checkout.js");

test.after(() => {
  nativeHooks.deregister();
  delete globalThis.__chikReactNativeCheckoutTest;
});

test.beforeEach(() => {
  assert.equal(returnListeners.size, 0);
  initialUrl = null;
  initialError = undefined;
  secureRecords.clear();
  nativePackageOpens.length = 0;
  secureWriteBarrier = undefined;
});

test("cold and warm return links pass through the reviewed navigation decision", async () => {
  const resumedUrl = "https://checkout.example/resume";
  initialUrl = `exampleapp://?url=${encodeURIComponent(resumedUrl)}`;
  const navigated = [];
  const host = new ChikReactNativeMobileCheckoutHost();
  const result = host.present(presentation((url) => {
    navigated.push(url);
    if (url.startsWith("exampleapp://")) return { action: "resume", url: resumedUrl };
    return { action: "complete", redirect: failureRedirect() };
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigated.length, 1);
  assert.match(navigated[0], /^exampleapp:/u);
  assert.equal(host.snapshot()?.resumeUrl, resumedUrl);
  assert.equal(host.snapshot()?.revision, 1);
  assert.equal(host.shouldStartNavigation(host.snapshot().id, "https://checkout.example/complete"), false);

  assert.equal(await result, "https://checkout.example/complete");
  assert.equal(host.hasActiveSession, false);
  assert.equal(returnListeners.size, 0);
  const recovery = await host.restoreCheckout(sessionScope);
  assert.equal(recovery.redirectUrl, "https://checkout.example/complete");
  await assert.rejects(
    host.completeCheckout("wrong-capability", sessionScope),
    (error) => error instanceof ChikCheckoutError && error.code === "failed_precondition",
  );
  await host.completeCheckout(testPreparation.approvalCapability, sessionScope);
  assert.equal(await host.restoreCheckout(sessionScope), undefined);
});

test("session invalidation closes checkout and clears its recovery record", async () => {
  const controller = new AbortController();
  const host = new ChikReactNativeMobileCheckoutHost();
  const result = host.present(presentation(() => ({ action: "allow" }), controller.signal));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(host.snapshot());

  controller.abort();
  await assert.rejects(
    result,
    (error) => error instanceof ChikCheckoutError
      && error.code === "unauthenticated"
      && error.status === 401,
  );
  assert.equal(host.snapshot(), undefined);
  assert.equal(await host.restoreCheckout(sessionScope), undefined);
});

test("checkout settlement is atomic against dismissal and session invalidation", async () => {
  let releaseWrite;
  const host = new ChikReactNativeMobileCheckoutHost();
  const result = host.present(presentation(() => ({ action: "complete", redirect: failureRedirect() })));
  await new Promise((resolve) => setImmediate(resolve));
  const active = host.snapshot();
  assert.ok(active);

  secureWriteBarrier = new Promise((resolve) => { releaseWrite = resolve; });
  assert.equal(host.shouldStartNavigation(active.id, "https://checkout.example/complete"), false);
  assert.equal(secureWriteBarrier, undefined);
  host.dismiss();
  assert.equal(host.hasActiveSession, true);
  releaseWrite();
  assert.equal(await result, "https://checkout.example/complete");
  assert.equal((await host.restoreCheckout(sessionScope))?.redirectUrl, "https://checkout.example/complete");
  await host.completeCheckout(testPreparation.approvalCapability, sessionScope);

  const controller = new AbortController();
  const invalidated = host.present(presentation(
    () => ({ action: "complete", redirect: failureRedirect() }),
    controller.signal,
  ));
  await new Promise((resolve) => setImmediate(resolve));
  const invalidatedActive = host.snapshot();
  assert.ok(invalidatedActive);
  secureWriteBarrier = new Promise((resolve) => { releaseWrite = resolve; });
  assert.equal(host.shouldStartNavigation(invalidatedActive.id, "https://checkout.example/complete"), false);
  assert.equal(secureWriteBarrier, undefined);
  controller.abort();
  releaseWrite();
  await assert.rejects(
    invalidated,
    (error) => error instanceof ChikCheckoutError
      && error.code === "unauthenticated"
      && error.status === 401,
  );
  assert.equal(await host.restoreCheckout(sessionScope), undefined);
});

test("a different pending checkout cannot be overwritten", async () => {
  secureRecords.set(recoveryService, storedRecovery({
    preparation: { ...testPreparation, approvalCapability: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  }));
  const host = new ChikReactNativeMobileCheckoutHost();
  await assert.rejects(
    host.present(presentation(() => ({ action: "allow" }))),
    (error) => error instanceof ChikCheckoutError
      && error.code === "failed_precondition"
      && error.status === 412,
  );
  assert.match(secureRecords.get(recoveryService), /bbbbbbbb/u);
});

test("checkout recovery is isolated by the current native session scope", async () => {
  secureRecords.set(recoveryService, storedRecovery({ preparation: testPreparation }));
  const otherScope = "d".repeat(64);
  const host = new ChikReactNativeMobileCheckoutHost();

  assert.equal(await host.restoreCheckout(otherScope), undefined);
  await host.completeCheckout(testPreparation.approvalCapability, otherScope);
  assert.equal(secureRecords.has(recoveryService), true);
  assert.deepEqual(await host.restoreCheckout(sessionScope), { preparation: testPreparation });

  secureRecords.set(recoveryService, storedRecovery(
    { preparation: testPreparation },
    Date.now() + 40 * 60 * 1_000,
    otherScope,
  ));
  await assert.rejects(
    host.restoreCheckout(sessionScope),
    (error) => error instanceof ChikCheckoutError && error.code === "storage_error",
  );
  assert.equal(secureRecords.has(recoveryService), false);
});

test("an invalid secure recovery record fails closed and is removed", async () => {
  const invalidRecords = [
    { preparation: { approvalCapability: testPreparation.approvalCapability } },
    { preparation: testPreparation, unexpected: true },
    { preparation: { ...testPreparation, unexpected: true } },
    { preparation: { ...testPreparation, requestId: " " } },
    { preparation: { ...testPreparation, requestId: " request-1" } },
    { preparation: { ...testPreparation, requestId: "x".repeat(513) } },
    { preparation: { ...testPreparation, orderId: "order=1" } },
    { preparation: { ...testPreparation, orderName: " Order" } },
    { preparation: { ...testPreparation, customerKey: "customer" } },
    { preparation: testPreparation, redirectUrl: null },
    { preparation: testPreparation, redirectUrl: "not a URL" },
    { preparation: testPreparation, redirectUrl: "http://checkout.example/complete" },
    { preparation: testPreparation, redirectUrl: "https://attacker@checkout.example/complete" },
    { preparation: testPreparation, redirectUrl: "https://checkout.example/complete#result" },
    { preparation: testPreparation, redirectUrl: `https://checkout.example/${"x".repeat(16 * 1024)}` },
  ];
  for (const record of invalidRecords) {
    secureRecords.set(recoveryService, storedRecovery(record));
    const host = new ChikReactNativeMobileCheckoutHost();
    await assert.rejects(
      host.restoreCheckout(sessionScope),
      (error) => error instanceof ChikCheckoutError && error.code === "storage_error",
    );
    assert.equal(secureRecords.has(recoveryService), false);
  }
});

test("a cold nested return resumes and reaches the failure redirect", async () => {
  const resumedUrl = "https://checkout.example/resume";
  const failedUrl = "https://checkout.example/fail";
  initialUrl = `exampleapp://?url=${encodeURIComponent(resumedUrl)}`;
  const host = new ChikReactNativeMobileCheckoutHost();
  const result = host.present(presentation((url) => {
    if (url.startsWith("exampleapp://")) return { action: "resume", url: resumedUrl };
    return { action: "complete", redirect: failureRedirect() };
  }));

  await new Promise((resolve) => setImmediate(resolve));
  const active = host.snapshot();
  assert.ok(active);
  assert.equal(active.resumeUrl, resumedUrl);
  assert.equal(host.shouldStartNavigation(active.id, failedUrl), false);
  assert.equal(await result, failedUrl);
});

test("single active session, dismiss, and timeout use canonical errors", async () => {
  const host = new ChikReactNativeMobileCheckoutHost({ timeoutMs: 1_000 });
  const first = host.present(presentation(() => ({ action: "allow" })));
  await assert.rejects(
    host.present(presentation(() => ({ action: "allow" }))),
    (error) => error instanceof ChikCheckoutError && error.code === "failed_precondition",
  );
  await new Promise((resolve) => setImmediate(resolve));
  host.dismiss();
  await assert.rejects(
    first,
    (error) => error instanceof ChikCheckoutError && error.code === "canceled" && error.status === 499,
  );
  assert.equal(secureRecords.has(recoveryService), false);

  const timedOut = host.present(presentation(() => ({ action: "allow" })));
  await assert.rejects(
    timedOut,
    (error) => error instanceof ChikCheckoutError
      && error.code === "deadline_exceeded"
      && error.message === "Checkout timed out."
      && error.status === 504,
  );
  assert.equal(secureRecords.has(recoveryService), false);
});

test("the WebView gate synchronously allows, consumes returns, and completes", async () => {
  const opened = [];
  const host = new ChikReactNativeMobileCheckoutHost({
    openExternal: (url) => opened.push(url),
  });
  const result = host.present(presentation((url) => {
    if (url === "https://checkout.example/allowed" || url === "https://checkout.example/window#state") {
      return { action: "allow" };
    }
    if (url.startsWith("exampleapp://")) return { action: "restore" };
    return { action: "complete", redirect: failureRedirect() };
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const active = host.snapshot();
  assert.ok(active);

  assert.equal(host.shouldStartNavigation(active.id, "https://checkout.example/allowed"), true);
  host.openWindow(active.id, "https://checkout.example/window#state");
  assert.equal(host.snapshot()?.resumeUrl, "https://checkout.example/window#state");
  assert.deepEqual(opened, []);
  assert.equal(host.shouldStartNavigation(active.id, "exampleapp://return"), false);
  assert.equal(host.shouldStartNavigation(active.id, "https://checkout.example/complete"), false);
  assert.equal(await result, "https://checkout.example/complete");
});

test("external navigation uses the reviewed fallback and hides native errors", async () => {
  const opened = [];
  const host = new ChikReactNativeMobileCheckoutHost({
    openExternal: async (url) => {
      opened.push([url]);
      throw new Error(`private native detail for ${url}`);
    },
    openAndroidPackages: async (url, packageNames) => {
      opened.push([url, packageNames]);
      throw new Error(`private native detail for ${url}`);
    },
  });
  const result = host.present(presentation(() => ({
    action: "external",
    url: "supertoss://payments/open",
    fallbackUrl: "https://checkout.example/fallback",
    androidPackages: ["viva.republica.toss"],
  })));
  await new Promise((resolve) => setImmediate(resolve));
  const active = host.snapshot();
  assert.ok(active);
  assert.equal(host.shouldStartNavigation(active.id, "wallet://start"), false);

  await assert.rejects(result, (error) => {
    assert.ok(error instanceof ChikCheckoutError);
    assert.equal(error.code, "unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.message, "The payment application fallback could not be opened.");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    assert.doesNotMatch(error.message, /private native detail/u);
    return true;
  });
  assert.deepEqual(opened, [
    ["supertoss://payments/open", ["viva.republica.toss"]],
    ["https://checkout.example/fallback"],
  ]);
});

test("a package-bound native miss opens the reviewed HTTPS fallback", async () => {
  const opened = [];
  const host = new ChikReactNativeMobileCheckoutHost({
    openAndroidPackages: async (url, packageNames) => {
      opened.push([url, packageNames]);
      return false;
    },
    openExternal: async (url) => {
      opened.push([url]);
    },
  });
  const result = host.present(presentation((url) => url === "https://checkout.example/complete"
    ? { action: "complete", redirect: failureRedirect() }
    : {
        action: "external",
        url: "supertoss://payments/open",
        fallbackUrl: "https://play.google.com/store/apps/details?id=viva.republica.toss",
        androidPackages: ["viva.republica.toss"],
      }));
  await new Promise((resolve) => setImmediate(resolve));
  const active = host.snapshot();
  assert.ok(active);
  assert.equal(host.shouldStartNavigation(active.id, "supertoss://payments/open"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [
    ["supertoss://payments/open", ["viva.republica.toss"]],
    ["https://play.google.com/store/apps/details?id=viva.republica.toss"],
  ]);
  assert.equal(host.shouldStartNavigation(active.id, "https://checkout.example/complete"), false);
  assert.equal(await result, "https://checkout.example/complete");
});

test("Android custom schemes use the generated package-bound native launcher", async () => {
  const host = new ChikReactNativeMobileCheckoutHost();
  for (const url of ["wallet://checkout", "market://details?id=viva.republica.toss"]) {
    await assert.rejects(
      host.openExternal(url),
      (error) => error instanceof ChikCheckoutError
        && error.code === "invalid_argument"
        && error.status === 400,
    );
  }
  await host.openExternal("samsungpay://payments/open", [
    "com.samsung.android.spay",
    "com.samsung.android.spaylite",
  ]);
  assert.deepEqual(nativePackageOpens, [[
    "samsungpay://payments/open",
    ["com.samsung.android.spay", "com.samsung.android.spaylite"],
  ]]);
});

test("expired checkout recovery is deleted instead of blocking a new request", async () => {
  secureRecords.set(recoveryService, storedRecovery({ preparation: testPreparation }, Date.now() - 1));
  const host = new ChikReactNativeMobileCheckoutHost();
  assert.equal(await host.restoreCheckout(sessionScope), undefined);
  assert.equal(secureRecords.has(recoveryService), false);
});

test("checkout recovery cannot extend beyond the server intent lifetime", async () => {
  secureRecords.set(
    recoveryService,
    storedRecovery({ preparation: testPreparation }, Date.now() + 40 * 60 * 1_000 + 1_000),
  );
  const host = new ChikReactNativeMobileCheckoutHost();
  await assert.rejects(
    host.restoreCheckout(sessionScope),
    (error) => error instanceof ChikCheckoutError && error.code === "storage_error",
  );
  assert.equal(secureRecords.has(recoveryService), false);
});

test("unreviewed incoming links are ignored without failing the active checkout", async () => {
  const host = new ChikReactNativeMobileCheckoutHost();
  const result = host.present(presentation((url) => {
    if (url === "https://checkout.example/complete") {
      return { action: "complete", redirect: failureRedirect() };
    }
    if (url === "https://checkout.example/page") return { action: "allow" };
    throw new ChikCheckoutError("invalid_argument", "The checkout navigation URL is invalid.", 400);
  }));

  await new Promise((resolve) => setImmediate(resolve));

  const active = host.snapshot();
  assert.ok(active);
  emitReturnUrl("https://checkout.example/page");
  assert.equal(host.snapshot(), active);
  emitReturnUrl("unreviewed://return");
  assert.equal(host.hasActiveSession, true);
  emitReturnUrl("https://checkout.example/complete");
  assert.equal(await result, "https://checkout.example/complete");
});

test("native cold-start failures are normalized without their raw detail", async () => {
  const nativeCause = new Error("private initial-link failure");
  initialError = nativeCause;
  const host = new ChikReactNativeMobileCheckoutHost();
  await assert.rejects(
    host.present(presentation(() => ({ action: "allow" }))),
    (error) => error instanceof ChikCheckoutError
      && error.code === "unavailable"
      && error.message === "The checkout UI could not be displayed."
      && error.cause === nativeCause,
  );
  assert.equal(secureRecords.has(recoveryService), false);
});

test("a cold-start return without recovery information fails immediately", async () => {
  initialUrl = "exampleapp://";
  const host = new ChikReactNativeMobileCheckoutHost();
  await assert.rejects(
    host.present(presentation((url) => {
      if (url.startsWith("exampleapp:")) return { action: "restore" };
      return { action: "allow" };
    })),
    (error) => error instanceof ChikCheckoutError
      && error.code === "failed_precondition"
      && error.status === 412,
  );
  assert.equal(host.hasActiveSession, false);
  assert.equal(secureRecords.has(recoveryService), false);
});

test("a warm domestic app return preserves the active WebView session", async () => {
  const host = new ChikReactNativeMobileCheckoutHost();
  const result = host.present(presentation((url) => {
    if (url.startsWith("exampleapp:")) return { action: "restore" };
    return { action: "complete", redirect: failureRedirect() };
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const before = host.snapshot();
  assert.ok(before);
  emitReturnUrl("exampleapp://");
  assert.equal(host.snapshot(), before);
  assert.equal(host.shouldStartNavigation(before.id, "https://checkout.example/complete"), false);
  assert.equal(await result, "https://checkout.example/complete");
});

function presentation(navigate, sessionSignal = new AbortController().signal) {
  return {
    document: "<!doctype html><title>Checkout</title>",
    returnScheme: "exampleapp://",
    sessionScope,
    sessionSignal,
    recovery: { preparation: testPreparation },
    navigate,
  };
}

const testPreparation = Object.freeze({
  requestId: "request-1",
  orderId: "order-1",
  orderName: "Order",
  amount: 1000,
  currency: "KRW",
  customerKey: "customer-1",
  approvalCapability: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

function failureRedirect() {
  return { status: "failed", code: "payment_failed", message: "Checkout could not be completed." };
}

function storedRecovery(recovery, expiresAt = Date.now() + 40 * 60 * 1_000, scope = sessionScope) {
  return JSON.stringify({ version: 1, expiresAt, sessionScope: scope, recovery });
}
