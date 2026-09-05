import assert from "node:assert/strict";
import test from "node:test";

import { createNativeAuth } from "../dist/auth.js";

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function remoteSession(prefix = "a") {
  return {
    user: { userId: `${prefix}-user`, projectId: "project", email: `${prefix}@example.test`, emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
    expiresAt: "2099-01-01T00:00:00Z",
  };
}

test("native GitHub OAuth rejects duplicate callback parameters", async () => {
  let stored;
  let completionCalls = 0;
  let refreshCalls = 0;
  const clearedScopes = [];
  const localLifecycle = [];
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { localLifecycle.push("session"); stored = undefined; },
      async clearSessionScope(scope) { localLifecycle.push(`scope:${scope}`); clearedScopes.push(scope); },
    },
    async fetch(url, init) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/native/github/start") {
        return Response.json({
          authorizationUrl: "https://github.example.test/login",
          state: "state",
          browserNonce: "nonce",
          pkceVerifier: "verifier",
          expiresAt: "2099-01-01T00:00:00Z",
          redirectUri: "https://app.example.test/api/auth/github/callback",
        });
      }
      if (path === "/api/auth/native/github/complete") {
        completionCalls += 1;
        assert.deepEqual(JSON.parse(init.body), {
          code: "code",
          state: "state",
          browserNonce: "nonce",
          pkceVerifier: "verifier",
        });
        return Response.json({
          user: { userId: "user", projectId: "project", email: "user@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "access",
          refreshToken: "refresh",
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: "a".repeat(64),
        });
      }
      if (path === "/api/auth/refresh") {
        refreshCalls += 1;
        return Response.json({
          user: { userId: "user", projectId: "project", email: "user@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "access-refreshed",
          refreshToken: "refresh-refreshed",
          expiresAt: "2099-01-01T01:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
        });
      }
      if (path === "/api/auth/native/sign-in") {
        return Response.json({
          user: { userId: "second-user", projectId: "project", email: "second@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "second-access",
          refreshToken: "second-refresh",
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: "b".repeat(64),
        });
      }
      if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
      return new Response("not found", { status: 404 });
    },
  });

  const transaction = await auth.startGitHubNative();
  const duplicate = "https://app.example.test/api/auth/github/callback?code=code&state=state&state=other";
  assert.equal(transaction.matchesRedirect(duplicate), false);
  await assert.rejects(transaction.complete(duplicate));
  assert.equal(completionCalls, 0);

  const session = await transaction.complete("https://app.example.test/api/auth/github/callback?code=code&state=state");
  assert.equal(session.user.userId, "user");
  assert.equal(stored.refreshToken, "refresh");
  assert.equal(stored.sessionScope, "a".repeat(64));
  const sessionScope = stored.sessionScope;
  const firstTokenSource = (await auth.clientOptions()).sessionTokenSource;
  const firstSessionSignal = firstTokenSource.getSessionScopeSignal();
  assert.equal(firstTokenSource.getSessionScope(), sessionScope);
  assert.equal(firstSessionSignal.aborted, false);
  await auth.refreshSession();
  assert.equal(stored.sessionToken, "access-refreshed");
  assert.equal(stored.sessionScope, sessionScope);
  assert.equal(refreshCalls, 1);
  await auth.signIn("second@example.test", "password");
  const secondSessionScope = stored.sessionScope;
  assert.equal(secondSessionScope, "b".repeat(64));
  assert.equal(firstSessionSignal.aborted, true);
  const secondSessionSignal = (await auth.clientOptions()).sessionTokenSource.getSessionScopeSignal();
  assert.equal(secondSessionSignal.aborted, false);
  assert.deepEqual(clearedScopes, [sessionScope]);
  await auth.signOut();
  assert.equal(stored, undefined);
  assert.equal((await auth.clientOptions()).sessionTokenSource.getSessionScope(), undefined);
  assert.equal(secondSessionSignal.aborted, true);
  assert.deepEqual(clearedScopes, [sessionScope, secondSessionScope]);
  assert.deepEqual(localLifecycle.slice(-2), [`scope:${secondSessionScope}`, "session"]);
  assert.equal(completionCalls, 1);
});

test("a GitHub transaction started before a newer sign-in aborts before completion I/O", async () => {
  let stored;
  let completionCalls = 0;
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/native/github/start") {
        return Response.json({
          authorizationUrl: "https://github.example.test/login",
          state: "state",
          browserNonce: "nonce",
          expiresAt: "2099-01-01T00:00:00Z",
          redirectUri: "https://app.example.test/api/auth/github/callback",
        });
      }
      if (path === "/api/auth/native/github/complete") {
        completionCalls += 1;
        return new Response("unexpected completion", { status: 500 });
      }
      if (path === "/api/auth/native/sign-in") {
        return Response.json({
          user: { userId: "new-user", projectId: "project", email: "new@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: "b".repeat(64),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const transaction = await auth.startGitHubNative();
  await auth.signIn("new@example.test", "password");
  await assert.rejects(
    transaction.complete("https://app.example.test/api/auth/github/callback?code=code&state=state"),
    (error) => error?.code === "aborted",
  );
  assert.equal(completionCalls, 0);
  assert.equal(stored.sessionToken, "new-access");
  assert.equal(stored.sessionScope, "b".repeat(64));
});

test("a deferred GitHub start aborts when a newer sign-in completes", async () => {
  const startResponse = deferred();
  const startRequestStarted = deferred();
  let stored;
  let startCalls = 0;
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/native/github/start") {
        startCalls += 1;
        startRequestStarted.resolve();
        return startResponse.promise;
      }
      if (path === "/api/auth/native/sign-in") {
        return Response.json({
          user: { userId: "new-user", projectId: "project", email: "new@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: "b".repeat(64),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const staleStart = auth.startGitHubNative();
  await startRequestStarted.promise;
  await auth.signIn("new@example.test", "password");
  const rejected = assert.rejects(staleStart, (error) => error?.code === "aborted");
  startResponse.resolve(Response.json({
    authorizationUrl: "https://github.example.test/login",
    state: "state",
    browserNonce: "nonce",
    expiresAt: "2099-01-01T00:00:00Z",
    redirectUri: "https://app.example.test/api/auth/github/callback",
  }));
  await rejected;
  assert.equal(startCalls, 1);
  assert.equal(stored.sessionToken, "new-access");
  assert.equal(stored.sessionScope, "b".repeat(64));
});

test("invalid stored sessions are tombstoned and canonically cleared before background scope cleanup", async () => {
  const sessionScope = "d".repeat(64);
  let stored = {
    sessionToken: "access",
    refreshToken: "refresh",
    expiresAt: "invalid",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  const localLifecycle = [];
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { localLifecycle.push(`tombstone:${session.sessionScope}`); stored = session; },
      async clearSession() { localLifecycle.push("session"); stored = undefined; },
      async clearSessionScope(scope) { localLifecycle.push(`scope:${scope}`); },
    },
    async fetch() { return new Response("not found", { status: 404 }); },
  });

  await auth.clientOptions();
  assert.equal(stored, undefined);
  assert.deepEqual(localLifecycle, [`tombstone:${sessionScope}`, "session", `scope:${sessionScope}`]);
});

test("a failed background scope cleanup is retried by a new coordinated auth instance", async () => {
  const sessionScope = "c".repeat(64);
  const localLifecycle = [];
  let scopeAttempts = 0;
  let stored = {
    sessionToken: "access",
    refreshToken: "refresh",
    expiresAt: "invalid",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  const createSessionStore = () => ({
    coordinationKey: "test:native-auth:invalid-cleanup-retry",
    async getSession() { return stored; },
    async setSession(session) { stored = session; },
    async clearSession() { localLifecycle.push("session"); stored = undefined; },
    async clearSessionScope(scope) {
      scopeAttempts += 1;
      localLifecycle.push(`scope-${scopeAttempts}:${scope}`);
      if (scopeAttempts === 1) throw new Error("temporary secure storage failure");
    },
  });
  const fetch = async () => new Response("not found", { status: 404 });

  const firstAuth = createNativeAuth({ baseUrl: "https://app.example.test", sessionStore: createSessionStore(), fetch });
  const firstTokenSource = (await firstAuth.clientOptions()).sessionTokenSource;
  await Promise.resolve();
  assert.equal(firstTokenSource.getSessionToken(), undefined);
  assert.equal(firstTokenSource.getSessionScope(), undefined);
  assert.equal(stored, undefined);
  assert.deepEqual(localLifecycle, ["session", `scope-1:${sessionScope}`]);

  const restartedAuth = createNativeAuth({ baseUrl: "https://app.example.test", sessionStore: createSessionStore(), fetch });
  const tokenSource = (await restartedAuth.clientOptions()).sessionTokenSource;
  assert.equal(tokenSource.getSessionToken(), undefined);
  assert.equal(tokenSource.getSessionScope(), undefined);
  assert.equal(stored, undefined);
  assert.deepEqual(localLifecycle, [
    "session",
    `scope-1:${sessionScope}`,
    `scope-2:${sessionScope}`,
  ]);
});

test("native sign-in requires a server-issued session scope", async () => {
  let stored;
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    async fetch() {
      return Response.json({
        user: { userId: "user", projectId: "project", email: "user@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        sessionToken: "access",
        refreshToken: "refresh",
        expiresAt: "2099-01-01T00:00:00Z",
        refreshExpiresAt: "2099-01-02T00:00:00Z",
      });
    },
  });

  await assert.rejects(
    auth.signIn("user@example.test", "password"),
    (error) => error?.code === "invalid_response" && error?.status === 502,
  );
  assert.equal(stored, undefined);
});

test("a scoped recovery cleanup failure is best effort and does not block a replacement", async () => {
  const sessionScope = "e".repeat(64);
  let stored = {
    sessionToken: "access",
    refreshToken: "refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  let scopeAttempts = 0;
  let clearAttempts = 0;
  let setAttempts = 0;
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { setAttempts += 1; stored = session; },
      async clearSession() { clearAttempts += 1; stored = undefined; },
      async clearSessionScope() {
        scopeAttempts += 1;
        if (scopeAttempts === 1) throw new Error("temporary secure storage failure");
      },
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
      if (path === "/api/auth/native/sign-in") {
        return Response.json({
          user: { userId: "new-user", projectId: "project", email: "new@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: "f".repeat(64),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const signal = (await auth.clientOptions()).sessionTokenSource.getSessionScopeSignal();
  await auth.signOut();
  assert.equal(stored, undefined);
  assert.equal(signal.aborted, true);
  assert.equal((await auth.clientOptions()).sessionTokenSource.getSessionScope(), undefined);
  assert.ok(scopeAttempts >= 1);
  assert.equal(clearAttempts, 1);

  const session = await auth.signIn("new@example.test", "password");
  assert.equal(session.user.userId, "new-user");
  assert.equal(setAttempts, 2);
  assert.ok(scopeAttempts >= 1);
  assert.equal(clearAttempts, 1);
  assert.equal(stored.sessionToken, "new-access");
  assert.equal(stored.sessionScope, "f".repeat(64));
});

test("a tombstone surviving canonical clear failure cannot restore after a new auth instance", async () => {
  const sessionScope = "a".repeat(64);
  const lifecycle = [];
  let scopeAttempts = 0;
  let clearAttempts = 0;
  let signOutCalls = 0;
  let restartedNetworkCalls = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  const sessionStore = {
    async getSession() { return stored; },
    async setSession(session) {
      lifecycle.push(`${session.invalidated ? "tombstone" : "session"}:${session.sessionScope}`);
      stored = session;
    },
    async clearSession() {
      clearAttempts += 1;
      lifecycle.push(`clear-${clearAttempts}`);
      if (clearAttempts === 1) throw new Error("temporary secure storage failure");
      stored = undefined;
    },
    async clearSessionScope(scope) {
      scopeAttempts += 1;
      lifecycle.push(`scope-${scopeAttempts}:${scope}`);
    },
  };
  const firstAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore,
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/sign-out") {
        signOutCalls += 1;
        return Response.json({ signedOut: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const firstTokenSource = (await firstAuth.clientOptions()).sessionTokenSource;
  const firstSignal = firstTokenSource.getSessionScopeSignal();
  await assert.rejects(firstAuth.signOut(), (error) => error?.code === "storage_error");
  assert.equal(signOutCalls, 1);
  assert.equal(stored.invalidated, true);
  assert.equal(stored.sessionToken, undefined);
  assert.equal(firstTokenSource.getSessionToken(), undefined);
  assert.equal(firstTokenSource.getSessionScope(), undefined);
  assert.equal(firstSignal.aborted, true);

  const restartedAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore,
    async fetch() {
      restartedNetworkCalls += 1;
      return new Response("unexpected network call", { status: 500 });
    },
  });
  await assert.rejects(restartedAuth.getSession(), (error) => error?.code === "unauthenticated");
  assert.equal(await restartedAuth.restoreSession(), undefined);
  const restartedTokenSource = (await restartedAuth.clientOptions()).sessionTokenSource;
  assert.equal(restartedTokenSource.getSessionToken(), undefined);
  assert.equal(restartedTokenSource.getSessionScope(), undefined);
  assert.equal(restartedTokenSource.getSessionScopeSignal(), undefined);
  assert.equal(restartedNetworkCalls, 0);
  assert.equal(stored, undefined);
  assert.equal(clearAttempts, 2);
  assert.ok(scopeAttempts >= 1);
  assert.ok(lifecycle.indexOf(`tombstone:${sessionScope}`) < lifecycle.indexOf("clear-1"));
});

test("a tombstone storage failure reports storage error after best-effort revoke and clear", async () => {
  const sessionScope = "a".repeat(64);
  let tombstoneAttempts = 0;
  let scopeAttempts = 0;
  let clearAttempts = 0;
  let signOutCalls = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) {
        if (session.invalidated) {
          tombstoneAttempts += 1;
          throw new Error("secure storage unavailable");
        }
        stored = session;
      },
      async clearSession() { clearAttempts += 1; stored = undefined; },
      async clearSessionScope() { scopeAttempts += 1; },
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/sign-out") {
        signOutCalls += 1;
        return Response.json({ signedOut: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const tokenSource = (await auth.clientOptions()).sessionTokenSource;
  const signal = tokenSource.getSessionScopeSignal();
  await assert.rejects(auth.signOut(), (error) => error?.code === "storage_error");
  assert.equal(tombstoneAttempts, 1);
  assert.equal(signOutCalls, 1);
  assert.equal(scopeAttempts, 1);
  assert.equal(clearAttempts, 1);
  assert.equal(stored, undefined);
  assert.equal(tokenSource.getSessionToken(), undefined);
  assert.equal(tokenSource.getSessionScope(), undefined);
  assert.equal(signal.aborted, true);
});

test("failed tombstone and clear writes expose the physical storage limit without restoring a revoked session", async () => {
  const sessionScope = "a".repeat(64);
  const remoteCalls = [];
  let storageAvailable = false;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  const createSessionStore = () => ({
    async getSession() { return stored; },
    async setSession(session) {
      if (!storageAvailable) throw new Error("secure storage write unavailable");
      stored = session;
    },
    async clearSession() {
      if (!storageAvailable) throw new Error("secure storage clear unavailable");
      stored = undefined;
    },
    async clearSessionScope() {
      if (!storageAvailable) throw new Error("scoped storage clear unavailable");
    },
  });
  const firstAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: createSessionStore(),
    async fetch(url) {
      const path = new URL(url).pathname;
      remoteCalls.push(`first:${path}`);
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
      return new Response("not found", { status: 404 });
    },
  });

  const firstTokenSource = (await firstAuth.clientOptions()).sessionTokenSource;
  await assert.rejects(firstAuth.signOut(), (error) => error?.code === "storage_error");
  assert.equal(firstTokenSource.getSessionToken(), undefined);
  assert.equal(stored.sessionToken, "a-access");
  assert.deepEqual(remoteCalls, ["first:/api/auth/session", "first:/api/auth/sign-out"]);

  const rejectedRestart = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: createSessionStore(),
    async fetch(url) {
      const path = new URL(url).pathname;
      remoteCalls.push(`rejected-restart:${path}`);
      if (path === "/api/auth/session" || path === "/api/auth/refresh") {
        return Response.json({ code: "unauthenticated", message: "revoked" }, { status: 401 });
      }
      if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
      return new Response("not found", { status: 404 });
    },
  });
  await assert.rejects(rejectedRestart.clientOptions(), (error) => error?.code === "storage_error");
  assert.equal(stored.sessionToken, "a-access");
  assert.deepEqual(remoteCalls.slice(-2), [
    "rejected-restart:/api/auth/session",
    "rejected-restart:/api/auth/sign-out",
  ]);

  storageAvailable = true;
  const recoveredRestart = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: createSessionStore(),
    async fetch(url) {
      const path = new URL(url).pathname;
      remoteCalls.push(`recovered-restart:${path}`);
      if (path === "/api/auth/session" || path === "/api/auth/refresh") {
        return Response.json({ code: "unauthenticated", message: "revoked" }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const recoveredTokenSource = (await recoveredRestart.clientOptions()).sessionTokenSource;
  assert.equal(recoveredTokenSource.getSessionToken(), undefined);
  assert.equal(recoveredTokenSource.getSessionScope(), undefined);
  assert.equal(stored, undefined);
  assert.deepEqual(remoteCalls.slice(-2), [
    "recovered-restart:/api/auth/session",
    "recovered-restart:/api/auth/refresh",
  ]);
});

test("a replacement blocks its provider and revokes the old session when neither tombstone nor clear can be stored", async () => {
  const remoteCalls = [];
  let storageAvailable = false;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const createSessionStore = () => ({
    async getSession() { return stored; },
    async setSession(session) {
      if (!storageAvailable) throw new Error("secure storage write unavailable");
      stored = session;
    },
    async clearSession() {
      if (!storageAvailable) throw new Error("secure storage clear unavailable");
      stored = undefined;
    },
    async clearSessionScope() {
      if (!storageAvailable) throw new Error("scoped storage clear unavailable");
    },
  });
  const firstAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: createSessionStore(),
    async fetch(url, init) {
      const path = new URL(url).pathname;
      remoteCalls.push(path);
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/native/sign-in") {
        return Response.json({
          user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "b-access",
          refreshToken: "b-refresh",
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: "b".repeat(64),
        });
      }
      if (path === "/api/auth/sign-out") {
        assert.equal(JSON.parse(init.body).refreshToken, "a-refresh");
        return Response.json({ signedOut: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const firstTokenSource = (await firstAuth.clientOptions()).sessionTokenSource;
  await assert.rejects(firstAuth.signIn("b@example.test", "password"), (error) => error?.code === "storage_error");
  assert.equal(firstTokenSource.getSessionToken(), undefined);
  assert.equal(stored.sessionToken, "a-access");
  assert.deepEqual(remoteCalls, [
    "/api/auth/session",
    "/api/auth/sign-out",
  ]);

  storageAvailable = true;
  const restartedAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: createSessionStore(),
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session" || path === "/api/auth/refresh") {
        return Response.json({ code: "unauthenticated", message: "revoked" }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const restartedTokenSource = (await restartedAuth.clientOptions()).sessionTokenSource;
  assert.equal(restartedTokenSource.getSessionToken(), undefined);
  assert.equal(restartedTokenSource.getSessionScope(), undefined);
  assert.equal(stored, undefined);
});

test("a replacement accepts the new session while old scope cleanup remains pending", async () => {
  const sessionScope = "a".repeat(64);
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const lifecycle = [];
  const acceptedSessions = [];
  let scopeAttempts = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  const sessionStore = {
    async getSession() { return stored; },
    async setSession(session) {
      if (session.invalidated) lifecycle.push(`tombstone:${session.sessionScope}`);
      else {
        acceptedSessions.push(session.sessionScope);
        lifecycle.push(`session:${session.sessionScope}`);
      }
      stored = session;
    },
    async clearSession() {
      lifecycle.push("clear");
      stored = undefined;
    },
    async clearSessionScope(scope) {
      scopeAttempts += 1;
      lifecycle.push(`scope-${scopeAttempts}:${scope}`);
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    },
  };
  const firstAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore,
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path !== "/api/auth/native/sign-in") return new Response("not found", { status: 404 });
      lifecycle.push("network:b");
      return Response.json({
        user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        sessionToken: "b-access",
        refreshToken: "b-refresh",
        expiresAt: "2099-01-01T00:00:00Z",
        refreshExpiresAt: "2099-01-02T00:00:00Z",
        sessionScope: "b".repeat(64),
      });
    },
  });

  const firstTokenSource = (await firstAuth.clientOptions()).sessionTokenSource;
  const firstSignal = firstTokenSource.getSessionScopeSignal();
  const replacement = firstAuth.signIn("b@example.test", "password");
  await cleanupStarted.promise;
  const session = await replacement;
  assert.equal(session.user.userId, "b-user");
  assert.equal(stored.sessionScope, "b".repeat(64));
  assert.equal(stored.sessionToken, "b-access");
  assert.equal(firstTokenSource.getSessionToken(), "b-access");
  assert.equal(firstTokenSource.getSessionScope(), "b".repeat(64));
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(acceptedSessions, ["b".repeat(64)]);
  assert.deepEqual(lifecycle, [
    `tombstone:${sessionScope}`,
    `scope-1:${sessionScope}`,
    "network:b",
    `session:${"b".repeat(64)}`,
  ]);
  releaseCleanup.resolve();
});

test("a stale refresh cannot replace or clear a newer sign-in", async () => {
  for (const outcome of ["success", "unauthenticated"]) {
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    let stored = {
      sessionToken: "a-access",
      refreshToken: "a-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
      refreshExpiresAt: "2099-01-02T00:00:00Z",
      sessionScope: "a".repeat(64),
    };
    const auth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: {
        async getSession() { return stored; },
        async setSession(session) { stored = session; },
        async clearSession() { stored = undefined; },
        async clearSessionScope() {},
      },
      async fetch(url) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/session") return Response.json(remoteSession());
        if (path === "/api/auth/refresh") {
          refreshStarted.resolve();
          return refreshResponse.promise;
        }
        if (path === "/api/auth/native/sign-in") {
          return Response.json({
            user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            sessionToken: "b-access",
            refreshToken: "b-refresh",
            expiresAt: "2099-01-01T00:00:00Z",
            refreshExpiresAt: "2099-01-02T00:00:00Z",
            sessionScope: "b".repeat(64),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    await auth.clientOptions();
    const staleRefresh = auth.refreshSession();
    await refreshStarted.promise;
    await auth.signIn("b@example.test", "password");
    const rejected = assert.rejects(staleRefresh, (error) => error?.code === "aborted");
    refreshResponse.resolve(outcome === "success"
      ? Response.json({
        user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        sessionToken: "a-refreshed-access",
        refreshToken: "a-refreshed-refresh",
        expiresAt: "2099-01-01T01:00:00Z",
        refreshExpiresAt: "2099-01-02T00:00:00Z",
      })
      : Response.json({ code: "unauthenticated", message: "expired" }, { status: 401 }));
    await rejected;
    assert.equal(stored.sessionToken, "b-access");
    assert.equal(stored.sessionScope, "b".repeat(64));
  }
});

test("two auth instances share one refresh request and both rehydrate the persisted rotated session", async () => {
  const refreshResponse = deferred();
  const refreshStarted = deferred();
  let refreshCalls = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const store = () => ({
    coordinationKey: "test:native-auth:shared-refresh",
    async getSession() { return stored; },
    async setSession(session) { stored = session; },
    async clearSession() { stored = undefined; },
    async clearSessionScope() {},
  });
  const createAuth = () => createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: store(),
    async fetch(url, init) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/refresh") {
        refreshCalls += 1;
        assert.equal(JSON.parse(init.body).refreshToken, "a-refresh");
        refreshStarted.resolve();
        return refreshResponse.promise;
      }
      return new Response("not found", { status: 404 });
    },
  });
  const firstAuth = createAuth();
  const secondAuth = createAuth();
  const firstTokenSource = (await firstAuth.clientOptions()).sessionTokenSource;
  const secondTokenSource = (await secondAuth.clientOptions()).sessionTokenSource;
  const firstSignal = firstTokenSource.getSessionScopeSignal();
  const secondSignal = secondTokenSource.getSessionScopeSignal();

  const firstRefresh = firstAuth.refreshSession();
  const secondRefresh = secondAuth.refreshSession();
  await refreshStarted.promise;
  let optionsResolvedDuringRefresh = false;
  const optionsDuringRefresh = firstAuth.clientOptions().then((value) => {
    optionsResolvedDuringRefresh = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  assert.equal(optionsResolvedDuringRefresh, false);
  assert.equal(stored.invalidated, true);
  assert.equal(firstSignal.aborted, false);
  assert.equal(secondSignal.aborted, false);
  assert.equal(firstTokenSource.getSessionToken(), undefined);
  assert.equal(secondTokenSource.getSessionToken(), undefined);
  assert.equal(firstTokenSource.getSessionScope(), "a".repeat(64));
  assert.equal(secondTokenSource.getSessionScope(), "a".repeat(64));
  assert.equal(firstTokenSource.getSessionScopeSignal(), firstSignal);
  assert.equal(secondTokenSource.getSessionScopeSignal(), secondSignal);
  let crashSnapshot = { ...stored };
  let crashRestartNetworkCalls = 0;
  const crashRestart = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return crashSnapshot; },
      async setSession(session) { crashSnapshot = session; },
      async clearSession() { crashSnapshot = undefined; },
      async clearSessionScope() {},
    },
    async fetch() {
      crashRestartNetworkCalls += 1;
      return new Response("unexpected network call", { status: 500 });
    },
  });
  const crashRestartTokenSource = (await crashRestart.clientOptions()).sessionTokenSource;
  assert.equal(crashRestartTokenSource.getSessionToken(), undefined);
  assert.equal(crashRestartTokenSource.getSessionScope(), undefined);
  assert.equal(crashRestartNetworkCalls, 0);
  assert.equal(crashSnapshot, undefined);

  refreshResponse.resolve(Response.json({
    user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
    sessionToken: "a2-access",
    refreshToken: "a2-refresh",
    expiresAt: "2099-01-01T01:00:00Z",
    refreshExpiresAt: "2099-01-02T01:00:00Z",
  }));
  const [firstSession, secondSession] = await Promise.all([firstRefresh, secondRefresh]);
  const refreshedOptions = await optionsDuringRefresh;

  assert.equal(firstSession.user.userId, "a-user");
  assert.equal(secondSession.user.userId, "a-user");
  assert.equal(refreshCalls, 1);
  assert.equal(stored.sessionToken, "a2-access");
  assert.equal(stored.refreshToken, "a2-refresh");
  assert.equal(stored.sessionScope, "a".repeat(64));
  assert.equal(firstTokenSource.getSessionToken(), "a2-access");
  assert.equal(secondTokenSource.getSessionToken(), "a2-access");
  assert.equal(refreshedOptions.sessionTokenSource.getSessionToken(), "a2-access");
  assert.equal(firstTokenSource.getSessionScopeSignal(), firstSignal);
  assert.equal(secondTokenSource.getSessionScopeSignal(), secondSignal);
  await secondAuth.onAppForeground();
  assert.equal(secondTokenSource.getSessionScopeSignal(), secondSignal);
  assert.equal(secondSignal.aborted, false);
});

test("a failed rotated-session write aborts the lease and clears any partial credential write", async () => {
  const sessionScope = "a".repeat(64);
  let writes = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope,
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) {
        writes += 1;
        stored = session;
        if (writes === 2) throw new Error("secure storage rejected the rotated session after writing it");
      },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/refresh") {
        return Response.json({
          user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "a2-access",
          refreshToken: "a2-refresh",
          expiresAt: "2099-01-01T01:00:00Z",
          refreshExpiresAt: "2099-01-02T01:00:00Z",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const tokenSource = (await auth.clientOptions()).sessionTokenSource;
  const leaseSignal = tokenSource.getSessionScopeSignal();
  await assert.rejects(auth.refreshSession(), (error) => error?.code === "storage_error");

  assert.equal(writes, 2);
  assert.equal(stored, undefined);
  assert.equal(leaseSignal.aborted, true);
  assert.equal(tokenSource.getSessionToken(), undefined);
  assert.equal(tokenSource.getSessionScope(), undefined);
  assert.equal(tokenSource.getSessionScopeSignal(), undefined);
});

test("a credential write followed by clear and tombstone failures is revoked before restart validation", async () => {
  for (const operation of ["sign-in", "refresh"]) {
    const oldScope = "a".repeat(64);
    const newScope = operation === "sign-in" ? "b".repeat(64) : oldScope;
    let storageRecovered = false;
    let activeWriteFailed = false;
    let revokedRefreshToken;
    let stored = operation === "refresh" ? {
      sessionToken: "a-access",
      refreshToken: "a-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
      refreshExpiresAt: "2099-01-02T00:00:00Z",
      sessionScope: oldScope,
    } : undefined;
    const createSessionStore = () => ({
      async getSession() { return stored; },
      async setSession(session) {
        if (storageRecovered) {
          stored = session;
          return;
        }
        if (session.invalidated) {
          if (activeWriteFailed) throw new Error("cleanup tombstone unavailable");
          stored = session;
          return;
        }
        stored = session;
        activeWriteFailed = true;
        throw new Error("credential write failed after its side effect");
      },
      async clearSession() {
        if (!storageRecovered) throw new Error("credential clear unavailable");
        stored = undefined;
      },
      async clearSessionScope() {},
    });
    const firstAuth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: createSessionStore(),
      async fetch(url, init) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/session") return Response.json(remoteSession());
        if (path === "/api/auth/native/sign-in" || path === "/api/auth/refresh") {
          return Response.json({
            user: { userId: "new-user", projectId: "project", email: "new@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            sessionToken: "new-access",
            refreshToken: "new-refresh",
            expiresAt: "2099-01-01T01:00:00Z",
            refreshExpiresAt: "2099-01-02T01:00:00Z",
            ...(operation === "sign-in" ? { sessionScope: newScope } : {}),
          });
        }
        if (path === "/api/auth/sign-out") {
          revokedRefreshToken = JSON.parse(init.body).refreshToken;
          return Response.json({ signedOut: true });
        }
        return new Response("not found", { status: 404 });
      },
    });

    if (operation === "refresh") await firstAuth.clientOptions();
    await assert.rejects(
      operation === "sign-in"
        ? firstAuth.signIn("new@example.test", "password")
        : firstAuth.refreshSession(),
      (error) => error?.code === "storage_error",
    );
    assert.equal(stored.sessionToken, "new-access");
    assert.equal(stored.sessionScope, newScope);
    assert.equal(revokedRefreshToken, "new-refresh");

    storageRecovered = true;
    let restartValidationCalls = 0;
    const restartedAuth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: createSessionStore(),
      async fetch(url) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/session" || path === "/api/auth/refresh") {
          restartValidationCalls += 1;
          return Response.json({ code: "unauthenticated", message: "revoked" }, { status: 401 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const restartedTokenSource = (await restartedAuth.clientOptions()).sessionTokenSource;
    assert.equal(restartedTokenSource.getSessionToken(), undefined);
    assert.equal(restartedTokenSource.getSessionScope(), undefined);
    assert.equal(stored, undefined);
    assert.equal(restartValidationCalls, 2);
  }
});

test("prepare and approval raw calls await one same-scope refresh and use only the rotated token", async () => {
  const refreshResponse = deferred();
  const refreshStarted = deferred();
  const rawAuthorizations = [];
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/session") return Response.json(remoteSession());
    if (path === "/api/auth/refresh") {
      refreshStarted.resolve();
      return refreshResponse.promise;
    }
    if (path === "/api/checkout/prepare" || path === "/api/checkout/approve") {
      rawAuthorizations.push(new Headers(init.headers).get("authorization"));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    fetch,
  });
  const client = await auth.createClient({ fetch });
  const leaseSignal = client.getSessionScopeSignal();
  const refresh = auth.refreshSession();
  await refreshStarted.promise;
  const prepare = client.raw(
    { path: "/api/checkout/prepare", method: "POST", requestKind: "json", responseKind: "json" },
    { path: {}, body: {} },
  );
  const approve = client.raw(
    { path: "/api/checkout/approve", method: "POST", requestKind: "json", responseKind: "json" },
    { path: {}, body: {} },
  );
  await Promise.resolve();
  assert.deepEqual(rawAuthorizations, []);
  assert.equal(client.getSessionScope(), "a".repeat(64));
  assert.equal(client.getSessionScopeSignal(), leaseSignal);
  assert.equal(leaseSignal.aborted, false);

  refreshResponse.resolve(Response.json({
    user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
    sessionToken: "a2-access",
    refreshToken: "a2-refresh",
    expiresAt: "2099-01-01T01:00:00Z",
    refreshExpiresAt: "2099-01-02T01:00:00Z",
  }));
  await refresh;
  assert.deepEqual(await Promise.all([prepare, approve]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(rawAuthorizations, ["Bearer a2-access", "Bearer a2-access"]);
  assert.equal(client.getSessionScopeSignal(), leaseSignal);
  assert.equal(leaseSignal.aborted, false);
});

test("canceling a raw call waiting on a shared refresh leaves the refresh running", async () => {
  const refreshResponse = deferred();
  const refreshStarted = deferred();
  const rawAuthorizations = [];
  let refreshSignal;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/session") return Response.json(remoteSession());
    if (path === "/api/auth/refresh") {
      refreshSignal = init.signal;
      refreshStarted.resolve();
      return refreshResponse.promise;
    }
    if (path === "/api/checkout/prepare") {
      rawAuthorizations.push(new Headers(init.headers).get("authorization"));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    fetch,
  });
  const client = await auth.createClient({ fetch });
  const refresh = auth.refreshSession();
  await refreshStarted.promise;

  const controller = new AbortController();
  const canceled = client.raw(
    { path: "/api/checkout/prepare", method: "POST", requestKind: "json", responseKind: "json" },
    { path: {}, body: {}, signal: controller.signal },
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(canceled, (error) => error?.code === "canceled");
  assert.deepEqual(rawAuthorizations, []);
  assert.equal(refreshSignal.aborted, false);

  refreshResponse.resolve(Response.json({
    user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
    sessionToken: "a2-access",
    refreshToken: "a2-refresh",
    expiresAt: "2099-01-01T01:00:00Z",
    refreshExpiresAt: "2099-01-02T01:00:00Z",
  }));
  await refresh;
  assert.deepEqual(await client.raw(
    { path: "/api/checkout/prepare", method: "POST", requestKind: "json", responseKind: "json" },
    { path: {}, body: {} },
  ), { ok: true });
  assert.deepEqual(rawAuthorizations, ["Bearer a2-access"]);
});

test("a superseding sign-in aborts an in-flight refresh fetch and keeps only the new credential", async () => {
  const refreshStarted = deferred();
  const refreshAborted = deferred();
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    async fetch(url, init) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/refresh") {
        refreshStarted.resolve(init.signal);
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            refreshAborted.resolve();
            reject(new Error("refresh request aborted"));
          }, { once: true });
        });
      }
      if (path === "/api/auth/native/sign-in") {
        return Response.json({
          user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "b-access",
          refreshToken: "b-refresh",
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: "b".repeat(64),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  await auth.clientOptions();
  const staleRefresh = auth.refreshSession();
  const requestSignal = await refreshStarted.promise;
  const rejected = assert.rejects(staleRefresh, (error) => error?.code === "aborted");
  const replacement = auth.signIn("b@example.test", "password");
  await refreshAborted.promise;
  await rejected;
  await replacement;

  assert.equal(requestSignal.aborted, true);
  assert.equal(stored.sessionToken, "b-access");
  assert.equal(stored.sessionScope, "b".repeat(64));
});

test("restore shares only the same session stamp while a remote restore is deferred", async () => {
  for (const staleOutcome of ["success", "unauthenticated"]) {
    const staleResponse = deferred();
    const staleRequestStarted = deferred();
    let sessionCalls = 0;
    let refreshCalls = 0;
    let stored = {
      sessionToken: "a-access",
      refreshToken: "a-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
      refreshExpiresAt: "2099-01-02T00:00:00Z",
      sessionScope: "a".repeat(64),
    };
    const auth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: {
        async getSession() { return stored; },
        async setSession(session) { stored = session; },
        async clearSession() { stored = undefined; },
        async clearSessionScope() {},
      },
      async fetch(url, init) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/session") {
          sessionCalls += 1;
          const authorization = new Headers(init.headers).get("authorization");
          if (authorization === "Bearer a-access") {
            staleRequestStarted.resolve();
            return staleResponse.promise;
          }
          assert.equal(authorization, "Bearer b-access");
          return Response.json({
            user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            expiresAt: "2099-01-01T00:00:00Z",
          });
        }
        if (path === "/api/auth/native/sign-in") {
          return Response.json({
            user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            sessionToken: "b-access",
            refreshToken: "b-refresh",
            expiresAt: "2099-01-01T00:00:00Z",
            refreshExpiresAt: "2099-01-02T00:00:00Z",
            sessionScope: "b".repeat(64),
          });
        }
        if (path === "/api/auth/refresh") {
          refreshCalls += 1;
          return new Response("unexpected refresh", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const firstRestore = auth.restoreSession();
    await staleRequestStarted.promise;
    const sharedRestore = auth.restoreSession();
    await Promise.resolve();
    assert.equal(sessionCalls, 1);

    await auth.signIn("b@example.test", "password");
    const current = await auth.restoreSession();
    assert.equal(current.user.userId, "b-user");
    assert.equal(sessionCalls, 2);

    const firstRejected = assert.rejects(firstRestore, (error) => error?.code === "aborted");
    const sharedRejected = assert.rejects(sharedRestore, (error) => error?.code === "aborted");
    staleResponse.resolve(staleOutcome === "success"
      ? Response.json({
        user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        expiresAt: "2099-01-01T00:00:00Z",
      })
      : Response.json({ code: "unauthenticated", message: "expired" }, { status: 401 }));
    await Promise.all([firstRejected, sharedRejected]);
    assert.equal(refreshCalls, 0);
    assert.equal(stored.sessionToken, "b-access");
    assert.equal(stored.sessionScope, "b".repeat(64));
  }
});

test("a stale sign-out cannot clear a newer sign-in", async () => {
  for (const outcome of ["success", "unauthenticated"]) {
    const signOutResponse = deferred();
    const signOutStarted = deferred();
    const clearedScopes = [];
    let stored = {
      sessionToken: "a-access",
      refreshToken: "a-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
      refreshExpiresAt: "2099-01-02T00:00:00Z",
      sessionScope: "a".repeat(64),
    };
    const auth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: {
        async getSession() { return stored; },
        async setSession(session) { stored = session; },
        async clearSession() { stored = undefined; },
        async clearSessionScope(scope) { clearedScopes.push(scope); },
      },
      async fetch(url) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/session") return Response.json(remoteSession());
        if (path === "/api/auth/sign-out") {
          signOutStarted.resolve();
          return signOutResponse.promise;
        }
        if (path === "/api/auth/native/sign-in") {
          return Response.json({
            user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            sessionToken: "b-access",
            refreshToken: "b-refresh",
            expiresAt: "2099-01-01T00:00:00Z",
            refreshExpiresAt: "2099-01-02T00:00:00Z",
            sessionScope: "b".repeat(64),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    await auth.clientOptions();
    const staleSignOut = auth.signOut();
    await signOutStarted.promise;
    await auth.signIn("b@example.test", "password");
    const rejected = assert.rejects(staleSignOut, (error) => error?.code === "aborted");
    signOutResponse.resolve(outcome === "success"
      ? Response.json({ signedOut: true })
      : Response.json({ code: "unauthenticated", message: "expired" }, { status: 401 }));
    await rejected;
    assert.equal(stored.sessionToken, "b-access");
    assert.equal(stored.sessionScope, "b".repeat(64));
    assert.ok(clearedScopes.length >= 1);
    assert.ok(clearedScopes.every((scope) => scope === "a".repeat(64)));
  }
});

test("a stale GitHub completion cannot win a deferred response or blocked write race", async () => {
  for (const blockedAt of ["response", "write"]) {
    const blocked = deferred();
    const release = deferred();
    const writes = [];
    let stored;
    const auth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: {
        async getSession() { return stored; },
        async setSession(session) {
          writes.push(`${session.invalidated ? "tombstone" : "session"}:${session.sessionScope}`);
          if (blockedAt === "write" && !session.invalidated && session.sessionScope === "a".repeat(64)) {
            blocked.resolve();
            await release.promise;
          }
          stored = session;
        },
        async clearSession() { stored = undefined; },
        async clearSessionScope() {},
      },
      async fetch(url) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/native/github/start") {
          return Response.json({
            authorizationUrl: "https://github.example.test/login",
            state: "state",
            browserNonce: "nonce",
            expiresAt: "2099-01-01T00:00:00Z",
            redirectUri: "https://app.example.test/api/auth/github/callback",
          });
        }
        if (path === "/api/auth/native/github/complete") {
          if (blockedAt === "response") {
            blocked.resolve();
            await release.promise;
          }
          return Response.json({
            user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            sessionToken: "a-access",
            refreshToken: "a-refresh",
            expiresAt: "2099-01-01T00:00:00Z",
            refreshExpiresAt: "2099-01-02T00:00:00Z",
            sessionScope: "a".repeat(64),
          });
        }
        if (path === "/api/auth/native/sign-in") {
          return Response.json({
            user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            sessionToken: "b-access",
            refreshToken: "b-refresh",
            expiresAt: "2099-01-01T00:00:00Z",
            refreshExpiresAt: "2099-01-02T00:00:00Z",
            sessionScope: "b".repeat(64),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const transaction = await auth.startGitHubNative();
    const staleCompletion = transaction.complete("https://app.example.test/api/auth/github/callback?code=code&state=state");
    await blocked.promise;
    const winningSignIn = auth.signIn("b@example.test", "password");
    const rejected = assert.rejects(staleCompletion, (error) => error?.code === "aborted");
    release.resolve();
    await rejected;
    await winningSignIn;
    assert.equal(stored.sessionToken, "b-access");
    assert.equal(stored.sessionScope, "b".repeat(64));
    assert.deepEqual(writes, blockedAt === "response"
      ? [`session:${"b".repeat(64)}`]
      : [`session:${"a".repeat(64)}`, `tombstone:${"a".repeat(64)}`, `session:${"b".repeat(64)}`]);
  }
});

test("a superseding sign-in aborts stale provider I/O without waiting for background scope cleanup", async () => {
  for (const staleOperation of ["replace", "clear"]) {
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const staleProviderStarted = deferred();
    const lifecycle = [];
    let stored = {
      sessionToken: "a-access",
      refreshToken: "a-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
      refreshExpiresAt: "2099-01-02T00:00:00Z",
      sessionScope: "a".repeat(64),
    };
    const auth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: {
        async getSession() { return stored; },
        async setSession(session) {
          const kind = session.invalidated ? "tombstone" : "session";
          lifecycle.push(`${kind}:${session.sessionScope}`);
          stored = session;
        },
        async clearSession() {
          lifecycle.push("session");
          stored = undefined;
        },
        async clearSessionScope(scope) {
          lifecycle.push(`scope-start:${scope}`);
          cleanupStarted.resolve();
          await releaseCleanup.promise;
          lifecycle.push(`scope-end:${scope}`);
        },
      },
      async fetch(url, init) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/session") return Response.json(remoteSession());
        if (path === "/api/auth/sign-out") {
          staleProviderStarted.resolve();
          return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted by replacement")), { once: true });
          });
        }
        if (path !== "/api/auth/native/sign-in") return new Response("not found", { status: 404 });
        const email = JSON.parse(init.body).email;
        const prefix = email.startsWith("b@") ? "b" : "c";
        if (prefix === "b") {
          staleProviderStarted.resolve();
          return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted by replacement")), { once: true });
          });
        }
        return Response.json({
          user: { userId: `${prefix}-user`, projectId: "project", email, emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: `${prefix}-access`,
          refreshToken: `${prefix}-refresh`,
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: prefix.repeat(64),
        });
      },
    });

    const tokenSource = (await auth.clientOptions()).sessionTokenSource;
    const firstSignal = tokenSource.getSessionScopeSignal();
    const staleTransition = staleOperation === "replace"
      ? auth.signIn("b@example.test", "password")
      : auth.signOut();
    await cleanupStarted.promise;
    await staleProviderStarted.promise;
    assert.equal(firstSignal.aborted, true);
    assert.equal(tokenSource.getSessionScope(), undefined);

    const winningReplacement = auth.signIn("c@example.test", "password");
    const rejected = assert.rejects(staleTransition, (error) => error?.code === "aborted");
    await rejected;
    await winningReplacement;
    assert.equal(stored.sessionToken, "c-access");
    assert.equal(stored.sessionScope, "c".repeat(64));
    assert.equal(lifecycle.includes(`scope-end:${"a".repeat(64)}`), false);
    assert.equal(lifecycle.at(-1), `session:${"c".repeat(64)}`);
    releaseCleanup.resolve();
  }
});

test("a permanently pending old-scope cleanup does not block replacement or same-scope refresh", async () => {
  const cleanupStarted = deferred();
  const lifecycle = [];
  let cleanupAttempts = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) {
        const kind = session.invalidated ? "tombstone" : "session";
        lifecycle.push(`${kind}:${session.sessionScope}`);
        stored = session;
      },
      async clearSession() {
        lifecycle.push("session");
        stored = undefined;
      },
      async clearSessionScope(scope) {
        cleanupAttempts += 1;
        lifecycle.push(`scope-${cleanupAttempts}-start:${scope}`);
        cleanupStarted.resolve();
        await new Promise(() => {});
      },
    },
    async fetch(url, init) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/refresh") {
        lifecycle.push("refresh:b2");
        return Response.json({
          user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: "b2-access",
          refreshToken: "b2-refresh",
          expiresAt: "2099-01-01T01:00:00Z",
          refreshExpiresAt: "2099-01-02T01:00:00Z",
        });
      }
      if (path !== "/api/auth/native/sign-in") return new Response("not found", { status: 404 });
      const email = JSON.parse(init.body).email;
      return Response.json({
        user: { userId: "b-user", projectId: "project", email, emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        sessionToken: "b-access",
        refreshToken: "b-refresh",
        expiresAt: "2099-01-01T00:00:00Z",
        refreshExpiresAt: "2099-01-02T00:00:00Z",
        sessionScope: "b".repeat(64),
      });
    },
  });

  await auth.clientOptions();
  const replacement = auth.signIn("b@example.test", "password");
  await cleanupStarted.promise;
  await replacement;
  const tokenSource = (await auth.clientOptions()).sessionTokenSource;
  const leaseSignal = tokenSource.getSessionScopeSignal();
  await auth.refreshSession();

  assert.equal(cleanupAttempts, 1);
  assert.equal(stored.sessionToken, "b2-access");
  assert.equal(stored.sessionScope, "b".repeat(64));
  assert.equal(tokenSource.getSessionToken(), "b2-access");
  assert.equal(tokenSource.getSessionScope(), "b".repeat(64));
  assert.equal(tokenSource.getSessionScopeSignal(), leaseSignal);
  assert.equal(leaseSignal.aborted, false);
  assert.equal(lifecycle.includes("refresh:b2"), true);
});

test("a stale stored-session read cannot restore state after sign-out", async () => {
  const firstReadStarted = deferred();
  const releaseFirstRead = deferred();
  let reads = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() {
        reads += 1;
        if (reads === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return stored;
      },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    async fetch(url) {
      if (new URL(url).pathname === "/api/auth/sign-out") return Response.json({ signedOut: true });
      return new Response("not found", { status: 404 });
    },
  });

  const staleRead = auth.clientOptions();
  await firstReadStarted.promise;
  const rejected = assert.rejects(staleRead, (error) => error?.code === "aborted");
  const signOut = auth.signOut();
  releaseFirstRead.resolve();
  await rejected;
  await signOut;
  assert.equal(stored, undefined);
  assert.equal(reads, 2);
});

test("a queued replacement or clear wins after a stale session write has started", async () => {
  for (const nextOperation of ["replace", "clear"]) {
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    let stored;
    const auth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: {
        async getSession() { return stored; },
        async setSession(session) {
          if (session.sessionScope === "a".repeat(64)) {
            firstWriteStarted.resolve();
            await releaseFirstWrite.promise;
          }
          stored = session;
        },
        async clearSession() { stored = undefined; },
        async clearSessionScope() {},
      },
      async fetch(url, init) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
        if (path !== "/api/auth/native/sign-in") return new Response("not found", { status: 404 });
        const email = JSON.parse(init.body).email;
        const prefix = email.startsWith("a@") ? "a" : "b";
        return Response.json({
          user: { userId: `${prefix}-user`, projectId: "project", email, emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
          sessionToken: `${prefix}-access`,
          refreshToken: `${prefix}-refresh`,
          expiresAt: "2099-01-01T00:00:00Z",
          refreshExpiresAt: "2099-01-02T00:00:00Z",
          sessionScope: prefix.repeat(64),
        });
      },
    });

    const staleWrite = auth.signIn("a@example.test", "password");
    await firstWriteStarted.promise;
    const rejected = assert.rejects(staleWrite, (error) => error?.code === "aborted");
    const newer = nextOperation === "replace"
      ? auth.signIn("b@example.test", "password")
      : auth.signOut();
    releaseFirstWrite.resolve();
    await rejected;
    await newer;
    assert.equal(stored?.sessionToken, nextOperation === "replace" ? "b-access" : undefined);
  }
});

test("a replacement waits for a stale write and its tombstone before provider I/O", async () => {
  const firstWriteStarted = deferred();
  const releaseFirstWrite = deferred();
  const lifecycle = [];
  let secondProviderCalls = 0;
  let stored;
  const store = (label) => ({
    coordinationKey: "test:native-auth:shared-write",
    async getSession() {
      lifecycle.push(`${label}:get`);
      return stored;
    },
    async setSession(session) {
      const prefix = session.sessionScope[0];
      lifecycle.push(`${label}:set-${prefix}-start`);
      if (prefix === "a") {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      stored = session;
      lifecycle.push(`${label}:set-${prefix}-end`);
    },
    async clearSession() {
      lifecycle.push(`${label}:clear`);
      stored = undefined;
    },
    async clearSessionScope(scope) { lifecycle.push(`${label}:scope-${scope[0]}`); },
  });
  const createAuth = (label, prefix) => createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: store(label),
    async fetch(url) {
      if (new URL(url).pathname !== "/api/auth/native/sign-in") return new Response("not found", { status: 404 });
      if (label === "second") {
        secondProviderCalls += 1;
        lifecycle.push("second:provider-b");
      }
      return Response.json({
        user: { userId: `${prefix}-user`, projectId: "project", email: `${prefix}@example.test`, emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        sessionToken: `${prefix}-access`,
        refreshToken: `${prefix}-refresh`,
        expiresAt: "2099-01-01T00:00:00Z",
        refreshExpiresAt: "2099-01-02T00:00:00Z",
        sessionScope: prefix.repeat(64),
      });
    },
  });
  const firstAuth = createAuth("first", "a");
  const secondAuth = createAuth("second", "b");

  const staleWrite = firstAuth.signIn("a@example.test", "password");
  await firstWriteStarted.promise;
  const winningReplacement = secondAuth.signIn("b@example.test", "password");
  const staleRejected = assert.rejects(staleWrite, (error) => error?.code === "aborted");
  await Promise.resolve();
  assert.equal(secondProviderCalls, 0);
  releaseFirstWrite.resolve();
  await staleRejected;
  const session = await winningReplacement;

  assert.equal(session.user.userId, "b-user");
  assert.equal(stored.sessionToken, "b-access");
  assert.equal(stored.sessionScope, "b".repeat(64));
  assert.ok(lifecycle.indexOf("first:set-a-end") < lifecycle.indexOf("second:get"));
  assert.ok(lifecycle.indexOf("second:set-a-end") < lifecycle.indexOf("second:provider-b"));
  assert.ok(lifecycle.indexOf("second:provider-b") < lifecycle.indexOf("second:set-b-start"));
  assert.equal(lifecycle.includes("second:clear"), false);
});

test("auth instances with one coordination key accept a new session while old cleanup is pending", async () => {
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const lifecycle = [];
  let cleanupAttempts = 0;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const store = (label) => ({
    coordinationKey: "test:native-auth:shared-cleanup",
    async getSession() {
      lifecycle.push(`${label}:get`);
      return stored;
    },
    async setSession(session) {
      lifecycle.push(`${label}:set-${session.invalidated ? "tombstone" : session.sessionScope[0]}`);
      stored = session;
    },
    async clearSession() {
      lifecycle.push(`${label}:clear`);
      stored = undefined;
    },
    async clearSessionScope(scope) {
      cleanupAttempts += 1;
      lifecycle.push(`${label}:scope-${scope[0]}-${cleanupAttempts}-start`);
      if (cleanupAttempts === 1) {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        lifecycle.push(`${label}:scope-${scope[0]}-${cleanupAttempts}-failed`);
        throw new Error("temporary scoped storage failure");
      }
      lifecycle.push(`${label}:scope-${scope[0]}-${cleanupAttempts}-end`);
    },
  });
  const firstAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: store("first"),
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path === "/api/auth/session") return Response.json(remoteSession());
      if (path === "/api/auth/sign-out") return Response.json({ signedOut: true });
      return new Response("not found", { status: 404 });
    },
  });
  const secondAuth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: store("second"),
    async fetch(url) {
      if (new URL(url).pathname !== "/api/auth/native/sign-in") return new Response("not found", { status: 404 });
      return Response.json({
        user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        sessionToken: "b-access",
        refreshToken: "b-refresh",
        expiresAt: "2099-01-01T00:00:00Z",
        refreshExpiresAt: "2099-01-02T00:00:00Z",
        sessionScope: "b".repeat(64),
      });
    },
  });

  const firstTokenSource = (await firstAuth.clientOptions()).sessionTokenSource;
  const firstSignal = firstTokenSource.getSessionScopeSignal();
  const signOut = firstAuth.signOut();
  await cleanupStarted.promise;
  await signOut;
  const winningSignIn = secondAuth.signIn("b@example.test", "password");
  assert.equal(firstSignal.aborted, true);
  assert.equal(firstTokenSource.getSessionToken(), undefined);
  const session = await winningSignIn;

  assert.equal(session.user.userId, "b-user");
  assert.equal(stored.sessionToken, "b-access");
  assert.equal(stored.sessionScope, "b".repeat(64));
  assert.equal(cleanupAttempts, 1);
  assert.equal(lifecycle.includes("first:scope-a-1-failed"), false);
  assert.equal(lifecycle.at(-1), "second:set-b");
  releaseCleanup.resolve();
});

test("hydration does not create a credential-retaining refresh timer", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const auth = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: {
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    },
    async fetch(url) {
      if (new URL(url).pathname === "/api/auth/session") return Response.json(remoteSession());
      return new Response("not found", { status: 404 });
    },
  });
  globalThis.setTimeout = () => { throw new Error("native auth must not schedule a refresh timer"); };
  try {
    const tokenSource = (await auth.clientOptions()).sessionTokenSource;
    assert.equal(tokenSource.getSessionToken(), "a-access");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("the keyed coordinator fallback works when Hermes lacks WeakRef and FinalizationRegistry", async () => {
  const weakRefDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WeakRef");
  const finalizationRegistryDescriptor = Object.getOwnPropertyDescriptor(globalThis, "FinalizationRegistry");
  try {
    Object.defineProperty(globalThis, "WeakRef", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "FinalizationRegistry", { configurable: true, value: undefined });
    const { createNativeAuth: createHermesAuth } = await import(`../dist/auth.js?hermes-fallback=${Date.now()}`);
    let stored;
    const createStore = (coordinationKey = "test:native-auth:hermes-fallback") => ({
      coordinationKey,
      async getSession() { return stored; },
      async setSession(session) { stored = session; },
      async clearSession() { stored = undefined; },
      async clearSessionScope() {},
    });
    const createAuth = (coordinationKey) => createHermesAuth({
      baseUrl: "https://app.example.test",
      sessionStore: createStore(coordinationKey),
      async fetch(url) {
        const path = new URL(url).pathname;
        if (path === "/api/auth/session") return Response.json(remoteSession());
        if (path === "/api/auth/native/sign-in") {
          return Response.json({
            user: { userId: "a-user", projectId: "project", email: "a@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
            sessionToken: "a-access",
            refreshToken: "a-refresh",
            expiresAt: "2099-01-01T00:00:00Z",
            refreshExpiresAt: "2099-01-02T00:00:00Z",
            sessionScope: "a".repeat(64),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    await createAuth().signIn("a@example.test", "password");
    const tokenSource = (await createAuth().clientOptions()).sessionTokenSource;
    assert.equal(tokenSource.getSessionToken(), "a-access");
    assert.equal(tokenSource.getSessionScope(), "a".repeat(64));
    for (let index = 1; index < 64; index += 1) createAuth(`test:native-auth:hermes-fallback:${index}`);
    assert.throws(
      () => createAuth("test:native-auth:hermes-fallback:overflow"),
      (error) => error?.code === "resource_exhausted",
    );
  } finally {
    if (weakRefDescriptor) Object.defineProperty(globalThis, "WeakRef", weakRefDescriptor);
    else delete globalThis.WeakRef;
    if (finalizationRegistryDescriptor) Object.defineProperty(globalThis, "FinalizationRegistry", finalizationRegistryDescriptor);
    else delete globalThis.FinalizationRegistry;
  }
});

test("repeated auth instances need no disposal timer and share only the coordinator session lease", async () => {
  let stored = {
    sessionToken: "a-access",
    refreshToken: "a-refresh",
    expiresAt: "2099-01-01T00:00:00Z",
    refreshExpiresAt: "2099-01-02T00:00:00Z",
    sessionScope: "a".repeat(64),
  };
  const createStore = () => ({
    coordinationKey: "test:native-auth:bounded-coordinator",
    async getSession() { return stored; },
    async setSession(session) { stored = session; },
    async clearSession() { stored = undefined; },
    async clearSessionScope() {},
  });
  const tokenSources = [];
  for (let index = 0; index < 32; index += 1) {
    const auth = createNativeAuth({
      baseUrl: "https://app.example.test",
      sessionStore: createStore(),
      async fetch(url) {
        if (new URL(url).pathname === "/api/auth/session") return Response.json(remoteSession());
        return new Response("not found", { status: 404 });
      },
    });
    tokenSources.push((await auth.clientOptions()).sessionTokenSource);
  }
  const epochSignals = new Set(tokenSources.map((source) => source.getSessionScopeSignal()));
  assert.equal(epochSignals.size, 1);
  const [epochSignal] = epochSignals;
  assert.ok(epochSignal);

  const replacement = createNativeAuth({
    baseUrl: "https://app.example.test",
    sessionStore: createStore(),
    async fetch(url) {
      if (new URL(url).pathname !== "/api/auth/native/sign-in") return new Response("not found", { status: 404 });
      return Response.json({
        user: { userId: "b-user", projectId: "project", email: "b@example.test", emailVerified: true, disabled: false, createdAt: "2026-01-01T00:00:00Z" },
        sessionToken: "b-access",
        refreshToken: "b-refresh",
        expiresAt: "2099-01-01T00:00:00Z",
        refreshExpiresAt: "2099-01-02T00:00:00Z",
        sessionScope: "b".repeat(64),
      });
    },
  });
  await replacement.signIn("b@example.test", "password");
  assert.equal(epochSignal.aborted, true);
  assert.equal(tokenSources.every((source) => source.getSessionToken() === undefined), true);
  assert.equal(stored.sessionToken, "b-access");
});
