import assert from "node:assert/strict";
import test from "node:test";

import {
  ChikClientError,
  ChikErrorCode,
  chikErrorCodeFromWire,
  createChikClientRuntime,
} from "../dist/index.js";
import { createNativeAuth } from "../dist/auth.js";
import { chikSessionScopeHeader } from "../dist/wire-contract.js";

test("error contract keeps typed codes and native causes", () => {
  const cause = new Error("transport closed");
  const error = new ChikClientError(ChikErrorCode.unavailable, "The request could not be sent.", 503, [], { cause });
  assert.equal(error.code, ChikErrorCode.unavailable);
  assert.equal(error.cause, cause);
  assert.equal(chikErrorCodeFromWire("future_provider_code"), ChikErrorCode.unknown);
});

test("generic RPC keeps a non-protocol response code as raw data", async () => {
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    fetch: async () => new Response(JSON.stringify({
      code: ChikErrorCode.storageError,
      message: "Storage operation failed.",
    }), { status: 400, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    client.raw({ path: "/test", method: "GET", requestKind: "none", responseKind: "json" }, { path: {} }),
    (error) => {
      assert.ok(error instanceof ChikClientError);
      assert.equal(error.code, ChikErrorCode.unknown);
      assert.equal(error.rawCode, ChikErrorCode.storageError);
      return true;
    },
  );
});

test("a marked replayable raw operation refreshes one same session and explicit auth does not", async () => {
  let token = "old-access";
  let scope = "old-scope";
  let scopeController = new AbortController();
  let recoveryCalls = 0;
  const requestBodies = [];
  const authorization = [];
  let encodedBodies = 0;
  const definition = {
    path: "/payments/confirm",
    method: "POST",
    requestKind: "json",
    responseKind: "json",
    retryOnAuthenticationFailure: true,
  };
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    sessionTokenSource: {
      getSessionToken: () => token,
      getSessionScope: () => scope,
      getSessionScopeSignal: () => scopeController.signal,
      async refreshSession(expectedScope) {
        assert.equal(expectedScope, scope);
        recoveryCalls += 1;
        token = "new-access";
        return token;
      },
    },
    fetch: async (_url, init) => {
      requestBodies.push(init.body);
      authorization.push(new Headers(init.headers).get("authorization"));
      if (authorization.at(-1) !== "Bearer new-access") {
        return new Response(JSON.stringify({ code: "unauthenticated", message: "expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ paymentId: "payment" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(
    await client.raw(definition, { path: {}, body: { toJSON() { encodedBodies += 1; return { requestId: "request" }; } } }),
    { paymentId: "payment" },
  );
  assert.equal(recoveryCalls, 1);
  assert.equal(encodedBodies, 1);
  assert.deepEqual(authorization, ["Bearer old-access", "Bearer new-access"]);
  assert.deepEqual(requestBodies, [
    JSON.stringify({ requestId: "request" }),
    JSON.stringify({ requestId: "request" }),
  ]);

  const explicitClient = createChikClientRuntime({
    baseUrl: "https://example.test",
    sessionTokenSource: clientOptionsSessionSource(),
    fetch: async () => new Response(JSON.stringify({ code: "unauthenticated", message: "expired" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    explicitClient.raw(definition, { path: {}, headers: { authorization: "Bearer explicit" }, body: {} }),
    (error) => error instanceof ChikClientError && error.status === 401,
  );
  assert.equal(recoveryCalls, 1);

  let releaseRequest;
  const requestBlocked = new Promise((resolve) => { releaseRequest = resolve; });
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  let replacementRefreshes = 0;
  token = "replacement-old-access";
  scope = "replacement-old-scope";
  scopeController = new AbortController();
  const replacementClient = createChikClientRuntime({
    baseUrl: "https://example.test",
    sessionTokenSource: {
      getSessionToken: () => token,
      getSessionScope: () => scope,
      getSessionScopeSignal: () => scopeController.signal,
      async refreshSession() { replacementRefreshes += 1; return token; },
    },
    fetch: async (_url, init) => {
      requestStarted();
      await requestBlocked;
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer replacement-old-access");
      return new Response(JSON.stringify({ code: "unauthenticated", message: "expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const staleRequest = replacementClient.raw(definition, { path: {}, body: { requestId: "stale" } });
  await started;
  scopeController.abort();
  scopeController = new AbortController();
  scope = "replacement-new-scope";
  token = "replacement-new-access";
  releaseRequest();
  await assert.rejects(
    staleRequest,
    (error) => error instanceof ChikClientError
      && error.code === ChikErrorCode.aborted
      && error.status === 409,
  );
  assert.equal(replacementRefreshes, 0);

  function clientOptionsSessionSource() {
    const signal = new AbortController().signal;
    return {
      getSessionToken: () => "explicit-fallback",
      getSessionScope: () => "explicit-scope",
      getSessionScopeSignal: () => signal,
      async refreshSession() { recoveryCalls += 1; return "unexpected"; },
    };
  }
});

test("a request started during refresh stays session-only without exposing its local lease", async () => {
  let token;
  const scopeController = new AbortController();
  const authorization = [];
  const scopes = [];
  let refreshCalls = 0;
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    apiKey: "must-not-be-used",
    sessionTokenSource: {
      getSessionToken: () => token,
      getSessionScope: () => "session-a",
      getSessionScopeSignal: () => scopeController.signal,
      async refreshSession() {
        refreshCalls += 1;
        token = "refreshed";
        return token;
      },
    },
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      authorization.push(headers.get("authorization"));
      scopes.push(headers.get(chikSessionScopeHeader));
      return authorization.at(-1) === "Bearer refreshed"
        ? Response.json({ paymentId: "payment" })
        : Response.json({ code: "unauthenticated", message: "expired" }, { status: 401 });
    },
  });

  await client.raw({
    path: "/payments/confirm",
    method: "POST",
    requestKind: "json",
    responseKind: "json",
    retryOnAuthenticationFailure: true,
  }, { path: {}, body: { requestId: "request" } });

  assert.equal(refreshCalls, 1);
  assert.deepEqual(authorization, [null, "Bearer refreshed"]);
  assert.deepEqual(scopes, [null, null]);
});

test("auth keeps protocol response codes and classifies local codes as raw data", async () => {
  let responseCode = ChikErrorCode.resourceExhausted;
  const auth = createNativeAuth({
    baseUrl: "https://example.test",
    sessionStore: {
      async getSession() { return undefined; },
      async setSession() {},
      async clearSession() {},
      async clearSessionScope() {},
    },
    fetch: async () => new Response(JSON.stringify({
      code: responseCode,
      message: "The request could not be completed.",
    }), { status: responseCode === ChikErrorCode.resourceExhausted ? 429 : 413 }),
  });

  await assert.rejects(
    auth.requestPasswordReset("person@example.test"),
    (error) => {
      assert.equal(error.code, ChikErrorCode.resourceExhausted);
      assert.equal(error.rawCode, undefined);
      return true;
    },
  );

  responseCode = ChikErrorCode.payloadTooLarge;
  await assert.rejects(
    auth.requestPasswordReset("person@example.test"),
    (error) => {
      assert.equal(error.code, ChikErrorCode.unknown);
      assert.equal(error.rawCode, ChikErrorCode.payloadTooLarge);
      return true;
    },
  );
});

test("realtime HTTP keeps protocol codes and classifies local codes as raw data", async () => {
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    fetch: async () => new Response(JSON.stringify({
      code: ChikErrorCode.permissionDenied,
      message: "Publishing is not allowed.",
    }), { status: 403, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    client.realtime.publish("notes", {}),
    (error) => {
      assert.ok(error instanceof ChikClientError);
      assert.equal(error.code, ChikErrorCode.permissionDenied);
      assert.equal(error.rawCode, undefined);
      return true;
    },
  );

  const localClient = createChikClientRuntime({
    baseUrl: "https://example.test",
    fetch: async () => new Response(JSON.stringify({
      code: ChikErrorCode.payloadTooLarge,
      message: "The payload is too large.",
    }), { status: 413, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    localClient.realtime.publish("notes", {}),
    (error) => {
      assert.ok(error instanceof ChikClientError);
      assert.equal(error.code, ChikErrorCode.unknown);
      assert.equal(error.rawCode, ChikErrorCode.payloadTooLarge);
      return true;
    },
  );
});

test("realtime WebSocket preserves protocol, raw code, and parsing cause", () => {
  class FakeWebSocket {
    static current;
    readyState = 1;
    onopen;
    onmessage;
    onclose;
    onerror;

    constructor() {
      FakeWebSocket.current = this;
    }

    close() {}
    send() {}
    emit(data) { this.onmessage?.({ data }); }
  }

  const errors = [];
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    WebSocket: FakeWebSocket,
  });
  const subscription = client.realtime.subscribe("notes", {
    onEvent() {},
    onGap() {},
    onError(error) { errors.push(error); },
  });
  FakeWebSocket.current.emit(JSON.stringify({
    t: "error",
    code: ChikErrorCode.permissionDenied,
    message: "Publishing is not allowed.",
  }));
  FakeWebSocket.current.emit(JSON.stringify({
    t: "error",
    code: "future_realtime_code",
    message: "Unknown realtime error.",
  }));
  FakeWebSocket.current.emit("not json");
  subscription.close();

  assert.equal(errors[0].code, ChikErrorCode.permissionDenied);
  assert.equal(errors[0].rawCode, undefined);
  assert.equal(errors[1].code, ChikErrorCode.unknown);
  assert.equal(errors[1].rawCode, "future_realtime_code");
  assert.equal(errors[2].code, ChikErrorCode.dataLoss);
  assert.ok(errors[2].cause instanceof ChikClientError);
});

test("realtime refreshes one captured session once without API-key fallback", async () => {
  class RecoveryWebSocket {
    static instances = [];
    readyState = 1;
    sent = [];
    onopen;
    onmessage;
    onclose;
    onerror;

    constructor() { RecoveryWebSocket.instances.push(this); }
    close() { this.readyState = 3; }
    send(frame) { this.sent.push(JSON.parse(frame)); }
    open() { this.onopen?.(); }
    emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }

  let token = "old-access";
  let refreshCalls = 0;
  const controller = new AbortController();
  const errors = [];
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    apiKey: "must-not-be-used",
    WebSocket: RecoveryWebSocket,
    sessionTokenSource: {
      getSessionToken: () => token,
      getSessionScope: () => "session-a",
      getSessionScopeSignal: () => controller.signal,
      async refreshSession() {
        refreshCalls += 1;
        token = "new-access";
        return token;
      },
    },
  });
  const subscription = client.realtime.subscribe("notes", {
    onEvent() {},
    onGap() {},
    onError(error) { errors.push(error); },
  });
  const first = RecoveryWebSocket.instances[0];
  first.open();
  assert.equal(first.sent[0]?.authorization, "Bearer old-access");
  first.emit({ t: "error", code: "unauthorized", message: "expired" });
  await new Promise((resolve) => setImmediate(resolve));

  const second = RecoveryWebSocket.instances[1];
  second.open();
  assert.equal(second.sent[0]?.authorization, "Bearer new-access");
  second.emit({ t: "error", code: "unauthorized", message: "expired again" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refreshCalls, 1);
  assert.equal(RecoveryWebSocket.instances.length, 2);
  assert.equal(errors.at(-1)?.code, ChikErrorCode.unauthorized);
  subscription.close();
});

test("realtime closes the old socket before reporting an authentication change", () => {
  const authentication = new AbortController();
  let connection;
  let closedBeforeCallback = false;
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    cookieSessionSource: {
      getSessionScope: () => "session-1",
      getSessionScopeSignal: () => authentication.signal,
      refreshSession: async () => "session-1",
    },
    WebSocket: RpcWebSocket,
  });
  connection = client.realtime.connect({
    onEvent() {},
    onGap() {},
    onError() {
      closedBeforeCallback = RpcWebSocket.current.closed;
      connection.subscribe("after-auth-change");
    },
  });
  const socket = RpcWebSocket.current;
  socket.open();

  authentication.abort();

  assert.equal(closedBeforeCallback, true);
  assert.equal(socket.closed, true);
  assert.deepEqual(socket.sent, []);
});

test("unary abort uses the canonical canceled contract", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    fetch: async () => { throw new DOMException("aborted", "AbortError"); },
  });

  await assert.rejects(
    client.unary(identityDefinition("Unary"), { value: "request" }, { signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof ChikClientError);
      assert.equal(error.code, ChikErrorCode.canceled);
      assert.equal(error.status, 499);
      return true;
    },
  );
});

test("server stream sends one request, half-closes, and observes cancellation acknowledgement", async () => {
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    WebSocket: RpcWebSocket,
  });
  const iterator = client.serverStream(identityDefinition("Watch"), { value: "request" })[Symbol.asyncIterator]();
  const socket = RpcWebSocket.current;
  socket.open();
  socket.receive({ v: 2, t: "ready", requestCredit: 1 });
  await nextTurn();

  assert.deepEqual(socket.sent.map((frame) => frame.t), ["start", "message", "half_close"]);
  assert.deepEqual(JSON.parse(socket.sent[1].data), { value: "request" });
  socket.receive({ v: 2, t: "message", data: JSON.stringify({ value: "response" }) });
  assert.deepEqual(await iterator.next(), { done: false, value: { value: "response" } });

  const returned = iterator.return();
  await nextTurn();
  assert.equal(socket.closed, false);
  socket.receive({ v: 2, t: "error", code: "canceled", message: "The client canceled the request." });
  await assert.rejects(returned, (error) => {
    assert.equal(error.code, ChikErrorCode.canceled);
    assert.equal(error.status, 499);
    return true;
  });
  assert.equal(socket.closed, true);
});

test("unary and raw response-body aborts preserve the canceled cause", async () => {
  for (const invoke of [
    (client, signal) => client.unary(identityDefinition("Unary"), { value: "request" }, { signal }),
    (client, signal) => client.raw(
      { path: "/raw", method: "GET", requestKind: "none", responseKind: "json" },
      { path: {}, signal },
    ),
  ]) {
    const controller = new AbortController();
    const cause = new DOMException("response aborted", "AbortError");
    const client = createChikClientRuntime({
      baseUrl: "https://example.test",
      fetch: async () => {
        controller.abort();
        return {
          ok: true,
          async text() { throw cause; },
        };
      },
    });

    await assert.rejects(invoke(client, controller.signal), (error) => {
      assert.equal(error.code, ChikErrorCode.canceled);
      assert.equal(error.status, 499);
      assert.equal(error.cause, cause);
      return true;
    });
  }
});

test("request stream abort waits for the server cancellation acknowledgement", async () => {
  const controller = new AbortController();
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    WebSocket: RpcWebSocket,
  });
  const response = client.clientStream(identityDefinition("Collect"), requestValues("one"), { signal: controller.signal });
  const socket = RpcWebSocket.current;
  socket.open();
  socket.receive({ v: 2, t: "ready", requestCredit: 1 });
  await nextTurn();

  let settled = false;
  void response.catch(() => { settled = true; });
  controller.abort();
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(socket.closed, false);
  assert.equal(socket.sent.some((frame) => frame.t === "cancel"), true);

  socket.receive({ v: 2, t: "error", code: "canceled", message: "The client canceled the request." });
  await assert.rejects(response, (error) => {
    assert.ok(error instanceof ChikClientError);
    assert.equal(error.code, ChikErrorCode.canceled);
    assert.equal(error.status, 499);
    return true;
  });
  assert.equal(socket.closed, true);
});

test("an authentication change hard-closes a stream after caller cancellation", async () => {
  const caller = new AbortController();
  const authentication = new AbortController();
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    cookieSessionSource: {
      getSessionScope: () => "session-1",
      getSessionScopeSignal: () => authentication.signal,
      refreshSession: async () => "session-1",
    },
    WebSocket: RpcWebSocket,
  });
  const response = client.clientStream(
    identityDefinition("Collect"),
    requestValues("one"),
    { signal: caller.signal },
  );
  const socket = RpcWebSocket.current;
  socket.open();
  caller.abort();
  await nextTurn();
  assert.equal(socket.closed, false);

  authentication.abort();
  assert.equal(socket.closed, true);
  await assert.rejects(response, (error) => {
    assert.equal(error.code, ChikErrorCode.aborted);
    assert.equal(error.status, 409);
    return true;
  });
});

test("pre-open abort finishes locally without starting the server stream", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    WebSocket: RpcWebSocket,
  });
  const response = client.clientStream(identityDefinition("Collect"), requestValues("one"), { signal: controller.signal });
  const socket = RpcWebSocket.current;

  await assert.rejects(response, (error) => {
    assert.equal(error.code, ChikErrorCode.canceled);
    assert.equal(error.status, 499);
    return true;
  });
  assert.equal(socket.closed, true);
  assert.deepEqual(socket.sent, []);
});

test("pre-open iterator return finishes locally without starting the server stream", async () => {
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    WebSocket: RpcWebSocket,
  });
  const iterator = client.bidiStream(identityDefinition("Chat"), requestValues("one"))[Symbol.asyncIterator]();
  const socket = RpcWebSocket.current;

  await assert.rejects(iterator.return(), (error) => {
    assert.equal(error.code, ChikErrorCode.canceled);
    assert.equal(error.status, 499);
    return true;
  });
  assert.equal(socket.closed, true);
  assert.deepEqual(socket.sent, []);
});

test("bidi iterator return waits for the server cancellation acknowledgement", async () => {
  const client = createChikClientRuntime({
    baseUrl: "https://example.test",
    WebSocket: RpcWebSocket,
  });
  const iterator = client.bidiStream(identityDefinition("Chat"), requestValues("one"))[Symbol.asyncIterator]();
  const socket = RpcWebSocket.current;
  socket.open();
  const returned = iterator.return();
  let settled = false;
  void returned.then(() => { settled = true; }, () => { settled = true; });
  await nextTurn();

  assert.equal(settled, false);
  assert.equal(socket.closed, false);
  socket.receive({ v: 2, t: "error", code: "canceled", message: "The client canceled the request." });
  await assert.rejects(returned, (error) => {
    assert.equal(error.code, ChikErrorCode.canceled);
    assert.equal(error.status, 499);
    return true;
  });
  assert.equal(socket.closed, true);
});

test("wire completion wins a cancellation race", async () => {
  const client = createChikClientRuntime({ baseUrl: "https://example.test", WebSocket: RpcWebSocket });
  const iterator = client.bidiStream(identityDefinition("Chat"), requestValues("one"))[Symbol.asyncIterator]();
  const socket = RpcWebSocket.current;
  socket.open();
  const returned = iterator.return();
  await nextTurn();
  socket.receive({ v: 2, t: "complete" });

  assert.deepEqual(await returned, { done: true, value: undefined });
  assert.equal(socket.closed, true);
});

test("close before a terminal frame is unavailable", async () => {
  const client = createChikClientRuntime({ baseUrl: "https://example.test", WebSocket: RpcWebSocket });
  const response = client.clientStream(identityDefinition("Collect"), requestValues());
  const socket = RpcWebSocket.current;
  socket.open();
  socket.remoteClose();

  await assert.rejects(response, (error) => {
    assert.equal(error.code, ChikErrorCode.unavailable);
    assert.equal(error.status, 503);
    return true;
  });
});

test("request stream maps typed error codes to canonical status and masks internal detail", async () => {
  const permissionClient = createChikClientRuntime({ baseUrl: "https://example.test", WebSocket: RpcWebSocket });
  const denied = permissionClient.clientStream(identityDefinition("Collect"), requestValues());
  RpcWebSocket.current.open();
  RpcWebSocket.current.receive({ v: 2, t: "error", code: "permission_denied", message: "Denied." });
  await assert.rejects(denied, (error) => {
    assert.equal(error.code, ChikErrorCode.permissionDenied);
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(RpcWebSocket.current.closed, true);

  const internalClient = createChikClientRuntime({ baseUrl: "https://example.test", WebSocket: RpcWebSocket });
  const failed = internalClient.clientStream(identityDefinition("Collect"), requestValues());
  RpcWebSocket.current.open();
  RpcWebSocket.current.receive({ v: 2, t: "error", code: "internal", message: "private detail" });
  await assert.rejects(failed, (error) => {
    assert.equal(error.code, ChikErrorCode.internal);
    assert.equal(error.status, 500);
    assert.equal(error.message, "An internal server error occurred.");
    return true;
  });
  assert.equal(RpcWebSocket.current.closed, true);
});

test("request stream closes its socket after normal completion", async () => {
  const client = createChikClientRuntime({ baseUrl: "https://example.test", WebSocket: RpcWebSocket });
  const response = client.clientStream(identityDefinition("Collect"), requestValues());
  const socket = RpcWebSocket.current;
  socket.open();
  socket.receive({ v: 2, t: "message", data: JSON.stringify({ value: "done" }) });
  socket.receive({ v: 2, t: "complete" });

  assert.deepEqual(await response, { value: "done" });
  assert.equal(socket.closed, true);
});

class RpcWebSocket {
  static current;
  readyState = 0;
  sent = [];
  closed = false;
  onopen;
  onmessage;
  onclose;
  onerror;

  constructor() { RpcWebSocket.current = this; }
  open() { this.readyState = 1; this.onopen?.(); }
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.closed = true; }
  remoteClose() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

function identityDefinition(method) {
  return {
    service: "Data",
    method,
    request: { encode: (value) => value, decode: (value) => value },
    response: { encode: (value) => value, decode: (value) => value },
  };
}

async function* requestValues(...values) {
  for (const value of values) yield { value };
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
