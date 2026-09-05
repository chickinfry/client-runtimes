import assert from "node:assert/strict";
import test from "node:test";

import { auth } from "../dist/auth.js";
import { ChikClientError, createChikClientRuntime } from "../dist/index.js";
import {
  chikAbsentSessionScope,
  chikBrowserSessionLockName,
  chikGitHubOAuthFinalizePath,
  chikOAuthPendingStorageKey,
  chikSessionScopeHeader,
  chikSessionTransitionStorageKey,
  chikTabSessionStorageKey,
} from "../dist/wire-contract.js";

test("a newer browser sign-in aborts an older session retry", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let refreshCalls = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/sign-in") {
      const email = JSON.parse(String(init?.body)).email;
      const scope = email === "old@example.test" ? "old-session" : "new-session";
      return Response.json({ user: { email }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: scope },
      });
    }
    if (path === "/api/auth/refresh") {
      refreshCalls += 1;
      return Response.json({ code: "unauthenticated", message: "expired" }, { status: 401 });
    }
    if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  await auth.signIn("old@example.test", "password");
  let releaseRequest;
  const blocked = new Promise((resolve) => { releaseRequest = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const scopes = [];
  const client = createChikClientRuntime({
    baseUrl: "https://app.example.test",
    cookieSessionSource: auth.cookieSessionSource,
    fetch: async (_input, init) => {
      scopes.push(new Headers(init.headers).get(chikSessionScopeHeader));
      markStarted();
      await blocked;
      return Response.json({ code: "unauthenticated", message: "expired" }, { status: 401 });
    },
  });
  const request = client.raw({
    path: "/payments/confirm",
    method: "POST",
    requestKind: "json",
    responseKind: "json",
    retryOnAuthenticationFailure: true,
  }, { path: {}, body: { requestId: "request-1" } });
  await started;
  await auth.signIn("new@example.test", "password");
  releaseRequest();

  await assert.rejects(request, (error) => (
    error instanceof ChikClientError
    && error.code === "aborted"
    && error.message === "The authentication session changed."
  ));
  assert.deepEqual(scopes, ["old-session"]);
  assert.equal(refreshCalls, 0);
  await auth.signOut();
  assert.equal(auth.cookieSessionSource.getSessionScope(), chikAbsentSessionScope);
});

test("a newer browser sign-in closes an older realtime session", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let socket;
  class TestWebSocket {
    readyState = 0;
    closed = false;
    onopen;
    onmessage;
    onerror;
    onclose;

    constructor() { socket = this; }
    send() {}
    close() { this.closed = true; this.readyState = 3; }
  }
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/sign-in") {
      const email = JSON.parse(String(init?.body)).email;
      const scope = email === "old@example.test" ? "old-session" : "new-session";
      return Response.json({ user: { email }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: scope },
      });
    }
    if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  await auth.signIn("old@example.test", "password");
  const errors = [];
  let closedBeforeError = false;
  const subscription = createChikClientRuntime({
    baseUrl: "https://app.example.test",
    cookieSessionSource: auth.cookieSessionSource,
    WebSocket: TestWebSocket,
  }).realtime.subscribe("orders", {
    onEvent() {},
    onGap() {},
    onError(error) { closedBeforeError = socket?.closed === true; errors.push(error); },
  });

  assert.equal(socket?.closed, false);
  await auth.signIn("new@example.test", "password");
  assert.equal(socket?.closed, true);
  assert.equal(closedBeforeError, true);
  assert.deepEqual(errors.map(({ code, message }) => ({ code, message })), [{
    code: "unauthorized",
    message: "The authentication session changed.",
  }]);
  subscription.close();
  await auth.signOut();
});

test("an OAuth session transition in another tab invalidates every older cookie lease", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tabA = origin.createTab();
  const tabB = origin.createTab();
  context.after(restoreGlobals);

  let refreshCalls = 0;
  let sessionCalls = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/sign-in") {
      return Response.json({ user: { email: "old@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "old-session" },
      });
    }
    if (path === "/api/auth/github/start") {
      return Response.json({
        authorizationUrl: "https://github.example.test/authorize",
        state: "oauth-state-b",
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      }, { headers: { [chikSessionScopeHeader]: "old-session" } });
    }
    if (path === chikGitHubOAuthFinalizePath) {
      assert.equal(JSON.parse(String(init?.body)).state, "oauth-state-b");
      return Response.json({ user: { email: "new@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "new-session" },
      });
    }
    if (path === "/api/auth/session") {
      sessionCalls += 1;
      return Response.json({ user: { email: "new@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "new-session" },
      });
    }
    if (path === "/api/auth/refresh") refreshCalls += 1;
    return Response.json({ code: "unauthenticated", message: "expired" }, { status: 401 });
  };

  const authA = (await import(`../dist/auth.js?tab=a-${Date.now()}`)).auth;
  const authB = (await import(`../dist/auth.js?tab=b-${Date.now()}`)).auth;
  await inBrowserTab(tabA, () => authA.signIn("old@example.test", "password"));

  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let networkCalls = 0;
  const applicationFetch = async (_input, init) => {
    networkCalls += 1;
    startedResolve();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  let sockets = 0;
  let socketCloses = 0;
  class TestWebSocket {
    readyState = 0;
    onopen;
    onmessage;
    onerror;
    onclose;
    constructor() { sockets += 1; }
    send() {}
    close() { socketCloses += 1; this.readyState = 3; }
  }
  const clientA = createChikClientRuntime({
    baseUrl: "https://app.example.test",
    cookieSessionSource: authA.cookieSessionSource,
    fetch: applicationFetch,
    WebSocket: TestWebSocket,
  });
  const definition = {
    path: "/payments/confirm",
    method: "POST",
    requestKind: "json",
    responseKind: "json",
    retryOnAuthenticationFailure: true,
  };
  const pendingRequest = startInBrowserTab(tabA, () => clientA.raw(definition, {
    path: {},
    body: { requestId: "request-1" },
  }));
  await started;
  const subscription = startInBrowserTab(tabA, () => clientA.realtime.subscribe("orders", {
    onEvent() {},
    onGap() {},
  }));

  await inBrowserTab(tabB, () => authB.startGitHub("/console"));
  assert.equal(authB.cookieSessionSource.getSessionScope(), undefined);
  tabB.reload();
  const returningAuth = (await import(`../dist/auth.js?tab=b-return-${Date.now()}`)).auth;
  await inBrowserTab(tabB, () => returningAuth.restoreSession());

  await assert.rejects(pendingRequest, (error) => (
    error instanceof ChikClientError
    && error.code === "aborted"
    && error.message === "The authentication session changed."
  ));
  assert.equal(refreshCalls, 0);
  assert.equal(networkCalls, 1);
  assert.equal(sockets, 1);
  assert.equal(socketCloses, 1);

  await assert.rejects(
    startInBrowserTab(tabA, () => clientA.raw(definition, { path: {}, body: {} })),
    (error) => error instanceof ChikClientError && error.code === "aborted",
  );
  await assert.rejects(
    startInBrowserTab(tabA, () => clientA.storage.getDownloadUrl({ bucket: "files", key: "one.txt" })),
    (error) => error?.code === "aborted",
  );
  await assert.rejects(
    startInBrowserTab(tabA, () => clientA.realtime.publish("orders", {})),
    (error) => error instanceof ChikClientError && error.code === "aborted",
  );
  assert.throws(
    () => startInBrowserTab(tabA, () => clientA.realtime.subscribe("orders", { onEvent() {}, onGap() {} })),
    (error) => error instanceof ChikClientError && error.code === "aborted",
  );
  assert.equal(networkCalls, 1);
  assert.equal(sockets, 1);
  assert.equal(sessionCalls, 0);
  assert.equal(tabB.sessionStorage.getItem(chikOAuthPendingStorageKey), null);
  assert.match(tabB.sessionStorage.getItem(chikTabSessionStorageKey) ?? "", /new-session/u);
  assert.deepEqual(origin.localStorageKeys(), [chikSessionTransitionStorageKey]);
  assert.doesNotMatch(origin.localStorage.getItem(chikSessionTransitionStorageKey) ?? "", /old-session|new-session/u);

  tabA.reload();
  const reloadedAuthA = (await import(`../dist/auth.js?tab=a-reload-${Date.now()}`)).auth;
  await assert.rejects(
    inBrowserTab(tabA, () => reloadedAuthA.restoreSession()),
    (error) => error?.code === "aborted" && error.message === "The authentication session changed.",
  );
  assert.equal(sessionCalls, 0);
  assert.equal(origin.maximumConcurrentLocks(), 1);
  subscription.close();
});

test("a signed-out tab keeps its own scope across reload and rejects a later shared session", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tabA = origin.createTab();
  const tabB = origin.createTab();
  context.after(restoreGlobals);

  let anonymousRequests = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/session" || path === "/api/auth/refresh") {
      anonymousRequests += 1;
      if (anonymousRequests > 2) {
        assert.equal(new Headers(init?.headers).get(chikSessionScopeHeader), chikAbsentSessionScope);
      }
      return Response.json({ code: "unauthenticated", message: "signed out" }, { status: 401 });
    }
    if (path === "/api/auth/sign-in") {
      return Response.json({ user: { email: "new@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "new-session" },
      });
    }
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  const firstAuthA = (await import(`../dist/auth.js?tab=signed-out-a-${Date.now()}`)).auth;
  await inBrowserTab(tabA, () => firstAuthA.restoreSession());
  assert.equal(firstAuthA.cookieSessionSource.getSessionScope(), chikAbsentSessionScope);
  assert.match(tabA.sessionStorage.getItem(chikTabSessionStorageKey) ?? "", /"transitionMarker":null/u);

  tabA.reload();
  const currentReloadAuthA = (await import(`../dist/auth.js?tab=signed-out-a-current-${Date.now()}`)).auth;
  await inBrowserTab(tabA, () => currentReloadAuthA.restoreSession());
  assert.equal(currentReloadAuthA.cookieSessionSource.getSessionScope(), chikAbsentSessionScope);
  assert.equal(anonymousRequests, 4);

  const authB = (await import(`../dist/auth.js?tab=signed-out-b-${Date.now()}`)).auth;
  await inBrowserTab(tabB, () => authB.signIn("new@example.test", "password"));
  tabA.reload();
  const staleReloadAuthA = (await import(`../dist/auth.js?tab=signed-out-a-stale-${Date.now()}`)).auth;
  await assert.rejects(
    inBrowserTab(tabA, () => staleReloadAuthA.restoreSession()),
    (error) => error?.code === "aborted" && error.message === "The authentication session changed.",
  );
  assert.equal(anonymousRequests, 4);
});

test("browser session transitions use one origin-wide named lock", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tabA = origin.createTab();
  const tabB = origin.createTab();
  context.after(restoreGlobals);

  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const calls = [];
  globalThis.fetch = async (_input, init) => {
    const email = JSON.parse(String(init?.body)).email;
    calls.push(email);
    if (email === "first@example.test") {
      markFirstStarted();
      await firstBlocked;
    }
    return Response.json({ user: { email }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
      headers: { [chikSessionScopeHeader]: `${email}-session` },
    });
  };

  const authA = (await import(`../dist/auth.js?tab=lock-a-${Date.now()}`)).auth;
  const authB = (await import(`../dist/auth.js?tab=lock-b-${Date.now()}`)).auth;
  const first = startInBrowserTab(tabA, () => authA.signIn("first@example.test", "password"));
  await firstStarted;
  const second = startInBrowserTab(tabB, () => authB.signIn("second@example.test", "password"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["first@example.test"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["first@example.test", "second@example.test"]);
  assert.equal(origin.maximumConcurrentLocks(), 1);
});

test("a rejected sign-in keeps the initiating tab on its old scope and invalidates other tabs", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tabA = origin.createTab();
  const tabB = origin.createTab();
  context.after(restoreGlobals);

  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/sign-in") {
      const email = JSON.parse(String(init?.body)).email;
      if (email === "rejected@example.test") {
        return Response.json({ code: "unauthenticated", message: "rejected" }, { status: 401 });
      }
      return Response.json({ user: { email }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "old-session" },
      });
    }
    if (path === "/api/auth/session") {
      return Response.json({ user: { email: "old@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "old-session" },
      });
    }
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  const authA = (await import(`../dist/auth.js?tab=rejected-a-${Date.now()}`)).auth;
  const authB = (await import(`../dist/auth.js?tab=rejected-b-${Date.now()}`)).auth;
  await inBrowserTab(tabA, () => authA.signIn("old@example.test", "password"));
  await inBrowserTab(tabB, () => authB.restoreSession());
  const oldTabSignal = authA.cookieSessionSource.getSessionScopeSignal();

  await assert.rejects(
    inBrowserTab(tabB, () => authB.signIn("rejected@example.test", "password")),
    (error) => error?.code === "unauthenticated" && error.status === 401,
  );
  assert.equal(oldTabSignal?.aborted, true);
  assert.equal(authB.cookieSessionSource.getSessionScope(), "old-session");
  assert.match(tabB.sessionStorage.getItem(chikTabSessionStorageKey) ?? "", /old-session/u);
});

test("an explicit sign-in abandons an older OAuth attempt", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tab = origin.createTab();
  context.after(restoreGlobals);

  let finalizeCalls = 0;
  let sessionCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/github/start") {
      return Response.json({
        authorizationUrl: "https://github.example.test/authorize",
        state: "abandoned-oauth",
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      }, { headers: { [chikSessionScopeHeader]: chikAbsentSessionScope } });
    }
    if (path === "/api/auth/sign-in") {
      return Response.json({ user: { email: "new@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "new-session" },
      });
    }
    if (path === chikGitHubOAuthFinalizePath) finalizeCalls += 1;
    if (path === "/api/auth/session") {
      sessionCalls += 1;
      return Response.json({ user: { email: "new@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "new-session" },
      });
    }
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  const browserAuth = (await import(`../dist/auth.js?tab=abandoned-oauth-${Date.now()}`)).auth;
  await inBrowserTab(tab, () => browserAuth.startGitHub("/console"));
  assert.notEqual(tab.sessionStorage.getItem(chikOAuthPendingStorageKey), null);
  await inBrowserTab(tab, () => browserAuth.signIn("new@example.test", "password"));
  assert.equal(tab.sessionStorage.getItem(chikOAuthPendingStorageKey), null);
  await inBrowserTab(tab, () => browserAuth.restoreSession());
  assert.equal(finalizeCalls, 0);
  assert.equal(sessionCalls, 1);
});

test("OAuth response headers commit the new scope before a response body failure", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tab = origin.createTab();
  context.after(restoreGlobals);

  globalThis.fetch = async (input) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/github/start") {
      return Response.json({
        authorizationUrl: "https://github.example.test/authorize",
        state: "oauth-response-loss",
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      }, { headers: { [chikSessionScopeHeader]: chikAbsentSessionScope } });
    }
    if (path === chikGitHubOAuthFinalizePath) {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("response body lost")); },
      }), { status: 200, headers: { [chikSessionScopeHeader]: "new-session" } });
    }
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  const browserAuth = (await import(`../dist/auth.js?tab=response-loss-${Date.now()}`)).auth;
  await inBrowserTab(tab, () => browserAuth.startGitHub("/console"));
  await assert.rejects(
    inBrowserTab(tab, () => browserAuth.restoreSession()),
    (error) => error?.code === "network_error" && error.status === 0,
  );
  assert.equal(browserAuth.cookieSessionSource.getSessionScope(), "new-session");
  assert.equal(tab.sessionStorage.getItem(chikOAuthPendingStorageKey), null);
  assert.match(tab.sessionStorage.getItem(chikTabSessionStorageKey) ?? "", /new-session/u);
});

test("sign-out response headers commit the signed-out scope before a response body failure", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tab = origin.createTab();
  context.after(restoreGlobals);

  globalThis.fetch = async (input) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/sign-in") {
      return Response.json({ user: { email: "old@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "old-session" },
      });
    }
    if (path === "/api/auth/sign-out") {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("response body lost")); },
      }), { status: 200 });
    }
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  const browserAuth = (await import(`../dist/auth.js?tab=sign-out-response-loss-${Date.now()}`)).auth;
  await inBrowserTab(tab, () => browserAuth.signIn("old@example.test", "password"));
  const oldSignal = browserAuth.cookieSessionSource.getSessionScopeSignal();
  await assert.rejects(
    inBrowserTab(tab, () => browserAuth.signOut()),
    (error) => error?.code === "network_error" && error.status === 0,
  );
  assert.equal(oldSignal?.aborted, true);
  assert.equal(browserAuth.cookieSessionSource.getSessionScope(), chikAbsentSessionScope);
  assert.match(tab.sessionStorage.getItem(chikTabSessionStorageKey) ?? "", /"sessionScope":null/u);
});

test("OAuth completion preserves pending state when the response was never received", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tab = origin.createTab();
  context.after(restoreGlobals);

  let finalizeCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    if (path === "/api/auth/github/start") {
      return Response.json({
        authorizationUrl: "https://github.example.test/authorize",
        state: "oauth-network-loss",
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      }, { headers: { [chikSessionScopeHeader]: chikAbsentSessionScope } });
    }
    if (path === chikGitHubOAuthFinalizePath) {
      finalizeCalls += 1;
      if (finalizeCalls === 1) throw new TypeError("connection lost before response");
      return Response.json({ user: { email: "new@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
        headers: { [chikSessionScopeHeader]: "new-session" },
      });
    }
    return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
  };

  const browserAuth = (await import(`../dist/auth.js?tab=network-loss-${Date.now()}`)).auth;
  await inBrowserTab(tab, () => browserAuth.startGitHub("/console"));
  await assert.rejects(
    inBrowserTab(tab, () => browserAuth.restoreSession()),
    (error) => error?.code === "network_error" && error.status === 0,
  );
  assert.notEqual(tab.sessionStorage.getItem(chikOAuthPendingStorageKey), null);

  await inBrowserTab(tab, () => browserAuth.restoreSession());
  assert.equal(finalizeCalls, 2);
  assert.equal(tab.sessionStorage.getItem(chikOAuthPendingStorageKey), null);
  assert.equal(browserAuth.cookieSessionSource.getSessionScope(), "new-session");
});

test("a session-changing request does not reach the network when its shared marker cannot be written", async (context) => {
  const restoreGlobals = browserGlobalsSnapshot();
  const origin = fakeBrowserOrigin();
  const tab = origin.createTab();
  context.after(restoreGlobals);

  let signInCalls = 0;
  globalThis.fetch = async () => {
    signInCalls += 1;
    return Response.json({ user: { email: "old@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z" }, {
      headers: { [chikSessionScopeHeader]: "old-session" },
    });
  };
  const browserAuth = (await import(`../dist/auth.js?tab=storage-failure-${Date.now()}`)).auth;
  await inBrowserTab(tab, () => browserAuth.signIn("old@example.test", "password"));
  const oldSignal = browserAuth.cookieSessionSource.getSessionScopeSignal();
  tab.localStorage.setItem = () => { throw new Error("storage unavailable"); };

  await assert.rejects(
    inBrowserTab(tab, () => browserAuth.signIn("new@example.test", "password")),
    (error) => error?.code === "unimplemented" && error.status === 501,
  );
  assert.equal(signInCalls, 1);
  assert.equal(oldSignal?.aborted, true);
});

function browserGlobalsSnapshot() {
  const names = ["fetch", "window", "document", "navigator"];
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function fakeBrowserOrigin() {
  const values = new Map();
  const tabs = [];
  let lockTail = Promise.resolve();
  let activeLocks = 0;
  let maximumConcurrentLocks = 0;
  const locks = {
    request(name, _options, operation) {
      assert.equal(name, chikBrowserSessionLockName);
      const result = lockTail.then(async () => {
        activeLocks += 1;
        maximumConcurrentLocks = Math.max(maximumConcurrentLocks, activeLocks);
        try { return await operation(); } finally { activeLocks -= 1; }
      });
      lockTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const storage = (entries, onChange = undefined) => ({
    get length() { return entries.size; },
    clear() { for (const key of [...entries.keys()]) this.removeItem(key); },
    getItem(key) { return entries.has(String(key)) ? entries.get(String(key)) : null; },
    key(index) { return [...entries.keys()][index] ?? null; },
    removeItem(key) {
      const normalized = String(key);
      if (!entries.has(normalized)) return;
      entries.delete(normalized);
      onChange?.(normalized);
    },
    setItem(key, value) {
      entries.set(String(key), String(value));
      onChange?.(String(key));
    },
  });
  const origin = {
    localStorage: undefined,
    createTab() {
      const listeners = new Set();
      const tab = {
        localStorage: undefined,
        sessionStorage: storage(new Map()),
        document: {},
        navigator: { locks },
        window: undefined,
        reload() { listeners.clear(); },
      };
      tab.localStorage = storage(values, (key) => {
        for (const other of tabs) {
          if (other === tab) continue;
          for (const listener of other.listeners) listener({ key, storageArea: other.localStorage });
        }
      });
      tab.window = {
        localStorage: tab.localStorage,
        sessionStorage: tab.sessionStorage,
        addEventListener(type, listener) { if (type === "storage") listeners.add(listener); },
      };
      tab.listeners = listeners;
      tabs.push(tab);
      origin.localStorage ??= tab.localStorage;
      return tab;
    },
    localStorageKeys: () => [...values.keys()].sort(),
    maximumConcurrentLocks: () => maximumConcurrentLocks,
  };
  return origin;
}

async function inBrowserTab(tab, operation) {
  const restore = installBrowserTab(tab);
  try { return await operation(); } finally { restore(); }
}

function startInBrowserTab(tab, operation) {
  const restore = installBrowserTab(tab);
  try { return operation(); } finally { restore(); }
}

function installBrowserTab(tab) {
  const names = ["window", "document", "navigator"];
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: tab.window });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: tab.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: tab.navigator });
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}
