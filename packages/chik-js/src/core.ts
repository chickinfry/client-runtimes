import { createChikRealtimeClient, type ChikRealtimeClient } from "./realtime.js";
import { createChikStorageClient, type ChikStorageClient } from "./storage.js";
import {
  ChikErrorCode,
  ChikErrorMessage,
  chikErrorDefaultStatus,
  isChikProtocolErrorCode,
  type ChikErrorCode as ChikClientErrorCode,
} from "./error-contract.js";
import { chikSessionScopeHeader, chikSessionScopeQuery } from "./wire-contract.js";

export { ChikErrorCode } from "./error-contract.js";
export type { ChikErrorCode as ChikClientErrorCode } from "./error-contract.js";

export interface ChikClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  sessionToken?: string | undefined;
  sessionTokenSource?: ChikSessionTokenSource | undefined;
  cookieSessionSource?: ChikCookieSessionSource | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  WebSocket?: typeof globalThis.WebSocket | undefined;
  headers?: HeadersInit | undefined;
}

/** Supplies the current application session to a long-lived generated client. */
export interface ChikSessionTokenSource {
  getSessionToken(): string | undefined;
  /** Returns a local opaque scope for state that must not cross sign-in sessions. */
  getSessionScope?(): string | undefined;
  /** Aborts synchronously when the current local sign-in session is replaced or cleared. */
  getSessionScopeSignal?(): AbortSignal | undefined;
  refreshSession?(expectedSessionScope: string): Promise<string | undefined>;
}

/** Supplies the opaque scope of the current same-origin cookie session. */
export interface ChikCookieSessionSource {
  getSessionScope(): string | undefined;
  getSessionScopeSignal(): AbortSignal | undefined;
  refreshSession(expectedSessionScope: string): Promise<string | undefined>;
}

export interface ChikCallOptions {
  token?: string | undefined;
  headers?: HeadersInit | undefined;
  signal?: AbortSignal | undefined;
}

export class ChikClientError extends Error {
  readonly rawCode: string | undefined;

  constructor(
    readonly code: ChikClientErrorCode,
    message: string,
    readonly status: number,
    readonly details: readonly unknown[] = [],
    options: { cause?: unknown; rawCode?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChikClientError";
    this.rawCode = options.rawCode;
  }
}

export const chikJsonNull: unique symbol = Symbol.for("@chickinfry/client/json-null");

export interface ChikJsonObject {
  [key: string]: ChikJsonNestedValue;
}

export type ChikJsonNestedValue =
  | null
  | boolean
  | number
  | string
  | ChikJsonNestedValue[]
  | ChikJsonObject;

export type ChikJsonValue =
  | typeof chikJsonNull
  | boolean
  | number
  | string
  | ChikJsonNestedValue[]
  | ChikJsonObject;

export interface ChikJsonInputObject {
  readonly [key: string]: ChikJsonInputNestedValue;
}

export type ChikJsonInputNestedValue =
  | null
  | boolean
  | number
  | string
  | readonly ChikJsonInputNestedValue[]
  | ChikJsonInputObject;

export type ChikJsonInput =
  | typeof chikJsonNull
  | boolean
  | number
  | string
  | readonly ChikJsonInputNestedValue[]
  | ChikJsonInputObject;

export interface ChikModelFieldSpec {
  readonly property: string;
  readonly wire: string;
  readonly encoding: "direct" | "list" | "nullable" | "nullable_list";
  readonly required: boolean;
  readonly value: "scalar" | "model" | "json" | "timestamp" | "bytes";
  readonly model?: string | undefined;
  readonly temporal?: "date" | "timestamp" | "timestamptz" | undefined;
}

export interface ChikModelSpec {
  readonly fields: readonly ChikModelFieldSpec[];
}

export interface ChikModelCodec<T> {
  encode(value: T): unknown;
  decode(value: unknown): T;
}

export interface ChikModelCodecs {
  codec<T>(name: string): ChikModelCodec<T>;
}

/** Creates the customer-model JSON codecs embedded by the compiler. */
export function createChikModelCodecs(specs: Readonly<Record<string, ChikModelSpec>>): ChikModelCodecs {
  const requireSpec = (name: string): ChikModelSpec => {
    const spec = specs[name];
    if (!spec) throw new TypeError(`Unknown customer model ${name}.`);
    return spec;
  };
  const encodeModel = (name: string, value: unknown): Record<string, unknown> => {
    const input = plainRecord(value, name);
    const output: Record<string, unknown> = {};
    for (const field of requireSpec(name).fields) {
      const entry = ownValue(input, field.property);
      if (entry === undefined) {
        if (field.required) throw new TypeError(`${name}.${field.property} is required.`);
        continue;
      }
      output[field.property] = encodeField(field, entry);
    }
    return output;
  };
  const decodeModel = (name: string, value: unknown): Record<string, unknown> => {
    const input = plainRecord(value, name);
    const output: Record<string, unknown> = {};
    for (const field of requireSpec(name).fields) {
      const wireValue = ownValue(input, field.wire);
      const entry = wireValue === undefined ? ownValue(input, field.property) : wireValue;
      if (entry === undefined) {
        if (field.required) throw new TypeError(`${name}.${field.property} is missing.`);
        continue;
      }
      output[field.property] = decodeField(field, entry);
    }
    return output;
  };
  const encodeValue = (field: ChikModelFieldSpec, value: unknown): unknown => {
    const canonical = field.temporal ? canonicalTemporalValue(field.temporal, value) : value;
    switch (field.value) {
      case "model": return encodeModel(requireModel(field), canonical);
      case "bytes": return encodeBytes(canonical);
      case "timestamp": return requiredString(canonical, field.property);
      case "json": return encodeChikJsonValue(canonical as ChikJsonInput);
      default: return canonical;
    }
  };
  const decodeValue = (field: ChikModelFieldSpec, value: unknown): unknown => {
    let decoded: unknown;
    switch (field.value) {
      case "model": decoded = decodeModel(requireModel(field), value); break;
      case "bytes": decoded = decodeBytes(value); break;
      case "timestamp": decoded = requiredString(value, field.property); break;
      case "json": decoded = decodeChikJsonValue(value); break;
      default: decoded = value;
    }
    return field.temporal ? canonicalTemporalValue(field.temporal, decoded) : decoded;
  };
  const encodeField = (field: ChikModelFieldSpec, value: unknown): unknown => {
    switch (field.encoding) {
      case "direct": return encodeValue(field, value);
      case "list": return { values: listValue(value, field.property).map((entry) => encodeValue(field, entry)) };
      case "nullable": return value === null ? { sqlNull: null } : { value: encodeValue(field, value) };
      case "nullable_list": return value === null
        ? { sqlNull: null }
        : { list: { values: listValue(value, field.property).map((entry) => encodeValue(field, entry)) } };
    }
  };
  const decodeField = (field: ChikModelFieldSpec, value: unknown): unknown => {
    switch (field.encoding) {
      case "direct": return decodeValue(field, value);
      case "list": {
        const wrapper = plainRecord(value, field.property);
        return listValue(ownValue(wrapper, "values") ?? [], field.property).map((entry) => decodeValue(field, entry));
      }
      case "nullable": {
        const wrapper = plainRecord(value, field.property);
        if (Object.hasOwn(wrapper, "sqlNull")) return null;
        const entry = ownValue(wrapper, "value");
        return entry === undefined ? null : decodeValue(field, entry);
      }
      case "nullable_list": {
        const wrapper = plainRecord(value, field.property);
        if (Object.hasOwn(wrapper, "sqlNull")) return null;
        const nested = ownValue(wrapper, "list");
        if (nested === undefined) return [];
        const list = plainRecord(nested, field.property);
        return listValue(ownValue(list, "values") ?? [], field.property).map((entry) => decodeValue(field, entry));
      }
    }
  };
  return {
    codec<T>(name: string): ChikModelCodec<T> {
      requireSpec(name);
      return {
        encode: (value) => encodeModel(name, value),
        decode: (value) => decodeModel(name, value) as T,
      };
    },
  };
}

export interface ChikMethodDefinition<Request, Response> {
  readonly service: string;
  readonly method: string;
  readonly request: ChikModelCodec<Request>;
  readonly response: ChikModelCodec<Response>;
  readonly retryOnAuthenticationFailure?: boolean | undefined;
}

export interface ChikRawOperationDefinition {
  readonly path: string;
  readonly method: string;
  readonly requestKind: "none" | "json" | "multipart-form" | "octet-stream";
  readonly responseKind: "json" | "empty";
  /** Retries replayable input once after the configured session is refreshed. */
  readonly retryOnAuthenticationFailure?: boolean | undefined;
}

export interface ChikRawOperationOptions {
  headers?: HeadersInit | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChikLiveQuerySnapshot<T> {
  items: readonly T[];
  pending: boolean;
  version?: number | undefined;
  cursor?: { stream: string; position: string } | undefined;
  error?: unknown | undefined;
}

export interface ChikLiveQueryOptions<T> {
  token?: string | undefined;
  onSnapshot(snapshot: ChikLiveQuerySnapshot<T>): void;
  onError?(error: unknown): void;
}

export interface ChikLiveQuery {
  refetch(): Promise<void>;
  close(): void;
}

export interface ChikClientRuntime {
  readonly realtime: ChikRealtimeClient;
  readonly storage: ChikStorageClient;
  /** Used by generated native integrations; it is not an authentication credential. */
  getSessionScope(): string | undefined;
  /** Used by generated native integrations to close session-owned local state immediately. */
  getSessionScopeSignal(): AbortSignal | undefined;
  unary<Request, Response>(definition: ChikMethodDefinition<Request, Response>, request: Request, options?: ChikCallOptions): Promise<Response>;
  serverStream<Request, Response>(definition: ChikMethodDefinition<Request, Response>, request: Request, options?: ChikCallOptions): AsyncIterable<Response>;
  clientStream<Request, Response>(definition: ChikMethodDefinition<Request, Response>, requests: AsyncIterable<Request>, options?: ChikCallOptions): Promise<Response>;
  bidiStream<Request, Response>(definition: ChikMethodDefinition<Request, Response>, requests: AsyncIterable<Request>, options?: ChikCallOptions): AsyncIterable<Response>;
  raw<Response>(definition: ChikRawOperationDefinition, input: ChikRawOperationOptions & { path: Record<string, string>; body?: unknown; contentType?: string | undefined }): Promise<Response>;
  watchList<Item, Request, Response>(definition: ChikMethodDefinition<Request, Response>, request: Request, collection: string, options: ChikLiveQueryOptions<Item>): ChikLiveQuery;
}

/** Creates the provider-neutral client runtime used by generated service facades. */
export function createChikClientRuntime(options: ChikClientOptions): ChikClientRuntime {
  return {
    realtime: createChikRealtimeClient(options),
    storage: createChikStorageClient(options),
    getSessionScope: () => options.sessionTokenSource?.getSessionScope?.(),
    getSessionScopeSignal: () => options.sessionTokenSource?.getSessionScopeSignal?.(),
    unary: (definition, request, callOptions = {}) => invoke(options, definition, request, callOptions),
    serverStream: (definition, request, callOptions = {}) => createRequestStream(options, definition, singleRequest(request), callOptions, false, true).responses,
    clientStream: (definition, requests, callOptions = {}) => createRequestStream(options, definition, requests, callOptions, true).singleResponse,
    bidiStream: (definition, requests, callOptions = {}) => createRequestStream(options, definition, requests, callOptions, false).responses,
    raw: (definition, input) => invokeRaw(options, definition, input),
    watchList: (definition, request, collection, liveOptions) => createLiveListQuery(options, definition, request, collection, liveOptions),
  };
}

function deploymentOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ChikClientError(ChikErrorCode.invalidArgument, "baseUrl must be an absolute HTTP deployment origin.", 400);
  }
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || (path !== "/" && path !== "/api")) {
    throw new ChikClientError(ChikErrorCode.invalidArgument, "baseUrl must be a deployment origin.", 400);
  }
  return url.origin;
}

function requestHeaders(
  options: ChikClientOptions,
  call: ChikCallOptions = {},
  authentication = authenticationRetryContext(options, call, false),
): Headers {
  if (authentication && !authenticationRetryScopeIsCurrent(authentication)) throw authenticationSessionChanged();
  const headers = new Headers(options.headers);
  if (!headers.has("authorization")) {
    const token = call.token ?? (authentication
      ? authentication.retryToken
      : sessionToken(options) ?? options.apiKey);
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  new Headers(call.headers).forEach((value, name) => headers.set(name, value));
  if (authentication?.kind === "cookie") headers.set(chikSessionScopeHeader, authentication.scope);
  return headers;
}

function sessionToken(options: ChikClientOptions): string | undefined {
  return options.sessionTokenSource ? options.sessionTokenSource.getSessionToken() : options.sessionToken;
}

function methodUrl(options: ChikClientOptions, definition: Pick<ChikMethodDefinition<unknown, unknown>, "service" | "method">): string {
  const url = new URL(deploymentOrigin(options.baseUrl));
  url.pathname = `/api/${encodeURIComponent(definition.service)}/${encodeURIComponent(definition.method)}`;
  return url.toString();
}

async function invoke<Request, Response>(
  options: ChikClientOptions,
  definition: ChikMethodDefinition<Request, Response>,
  request: Request,
  call: ChikCallOptions,
): Promise<Response> {
  try {
    const result = await invokeResponse(options, definition, request, call);
    const value = await responseJson(result.response);
    assertAuthenticationCurrent(result.authentication);
    return definition.response.decode(value);
  } catch (error) {
    if (error instanceof ChikClientError) throw error;
    throw requestError(error, call.signal);
  }
}

async function invokeResponse<Request, Result>(
  options: ChikClientOptions,
  definition: ChikMethodDefinition<Request, Result>,
  request: Request,
  call: ChikCallOptions,
): Promise<{ response: globalThis.Response; authentication: AuthenticationRetryContext | undefined }> {
  const body = JSON.stringify(definition.request.encode(request));
  const authentication = authenticationRetryContext(options, call, definition.retryOnAuthenticationFailure === true);
  return {
    response: await invokeEncodedResponse(options, definition, call, body, authentication, false),
    authentication,
  };
}

async function invokeEncodedResponse<Request, Result>(
  options: ChikClientOptions,
  definition: ChikMethodDefinition<Request, Result>,
  call: ChikCallOptions,
  body: string,
  retry: AuthenticationRetryContext | undefined,
  retriedAfterAuthenticationFailure: boolean,
): Promise<globalThis.Response> {
  const headers = requestHeaders(options, call, retry);
  const signal = combinedRequestSignal(call.signal, retry?.signal);
  headers.set("content-type", "application/json");
  headers.set("connect-protocol-version", "1");
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(methodUrl(options, definition), {
      method: "POST",
      headers,
      body,
      ...(signal ? { signal } : {}),
      ...(headers.has("authorization") ? { redirect: "error" } : {}),
    });
  } catch (error) {
    if (retry?.signal.aborted) throw authenticationSessionChanged(error);
    throw requestError(error, call.signal);
  }
  if (retry?.signal.aborted) throw authenticationSessionChanged();
  if (!response.ok) {
    const error = await responseError(response);
    assertAuthenticationCurrent(retry);
    if (
      !retriedAfterAuthenticationFailure
      && error.status === 401
      && retry !== undefined
      && await recoverAfterAuthenticationFailure(retry)
    ) {
      return invokeEncodedResponse(
        options,
        definition,
        call,
        body,
        retry,
        true,
      );
    }
    throw error;
  }
  return response;
}

type AuthenticationRetryContext = {
  readonly scope: string;
  readonly signal: AbortSignal;
  readonly source: ChikSessionTokenSource | ChikCookieSessionSource;
  readonly kind: "token" | "cookie";
  readonly retryEnabled: boolean;
  retryToken?: string | undefined;
};

function authenticationRetryContext(
  options: ChikClientOptions,
  call: ChikCallOptions,
  enabled: boolean,
): AuthenticationRetryContext | undefined {
  if (
    call.token !== undefined
    || new Headers(options.headers).has("authorization")
    || new Headers(call.headers).has("authorization")
  ) return undefined;
  const tokenSource = options.sessionTokenSource;
  if (tokenSource) {
    const token = tokenSource.getSessionToken();
    const scope = tokenSource.getSessionScope?.();
    const signal = tokenSource.getSessionScopeSignal?.();
    if (signal?.aborted) throw authenticationSessionChanged();
    if (scope === undefined && signal === undefined) return undefined;
    if (!scope?.trim() || !signal) throw authenticationSessionChanged();
    return {
      kind: "token",
      source: tokenSource,
      scope,
      signal,
      retryEnabled: enabled && typeof tokenSource.refreshSession === "function",
      ...(token?.trim() ? { retryToken: token.trim() } : {}),
    };
  }
  const cookieSource = options.cookieSessionSource;
  if (
    !cookieSource
    || options.sessionToken?.trim()
    || options.apiKey?.trim()
  ) return undefined;
  const scope = cookieSource.getSessionScope();
  const signal = cookieSource.getSessionScopeSignal();
  if (signal?.aborted) throw authenticationSessionChanged();
  if (scope === undefined && signal === undefined) return undefined;
  if (!scope?.trim() || !signal) throw authenticationSessionChanged();
  return { kind: "cookie", source: cookieSource, scope, signal, retryEnabled: enabled };
}

async function recoverAfterAuthenticationFailure(
  retry: AuthenticationRetryContext,
): Promise<boolean> {
  const refreshSession = retry.source.refreshSession;
  if (!retry.retryEnabled || !refreshSession || !authenticationRetryScopeIsCurrent(retry)) return false;
  const token = await refreshSession.call(retry.source, retry.scope);
  if (!authenticationRetryScopeIsCurrent(retry)) return false;
  if (retry.kind === "token") {
    const normalized = token?.trim();
    if (!normalized) return false;
    retry.retryToken = normalized;
  }
  return true;
}

function authenticationRetryScopeIsCurrent(retry: AuthenticationRetryContext): boolean {
  return !retry.signal.aborted
    && retry.source.getSessionScope?.() === retry.scope
    && retry.source.getSessionScopeSignal?.() === retry.signal;
}

function authenticationSessionChanged(cause?: unknown): ChikClientError {
  return new ChikClientError(
    ChikErrorCode.aborted,
    ChikErrorMessage.authenticationSessionChanged,
    409,
    [],
    cause === undefined ? {} : { cause },
  );
}

function assertAuthenticationCurrent(authentication: AuthenticationRetryContext | undefined): void {
  if (authentication && !authenticationRetryScopeIsCurrent(authentication)) throw authenticationSessionChanged();
}

function combinedRequestSignal(
  caller: AbortSignal | undefined,
  authentication: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!caller) return authentication;
  if (!authentication) return caller;
  return AbortSignal.any([caller, authentication]);
}

async function* singleRequest<Request>(request: Request): AsyncIterable<Request> {
  yield request;
}

function createRequestStream<Request, Response>(
  options: ChikClientOptions,
  definition: ChikMethodDefinition<Request, Response>,
  requests: AsyncIterable<Request>,
  call: ChikCallOptions,
  singleExpected: boolean,
  singleRequestExpected = false,
): { responses: AsyncIterable<Response>; singleResponse: Promise<Response> } {
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
  if (!WebSocketImpl) throw new ChikClientError(ChikErrorCode.internal, "A realtime implementation is required for request streams.", 500);
  const authentication = authenticationRetryContext(options, call, false);
  const headers = requestHeaders(options, call, authentication);
  const callerSignal = call.signal;
  const authenticationSignal = authentication?.signal;
  const url = new URL(deploymentOrigin(options.baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/_chik/rpc-stream/${encodeURIComponent(definition.service)}/${encodeURIComponent(definition.method)}`;
  if (authentication?.kind === "cookie") url.searchParams.set(chikSessionScopeQuery, authentication.scope);
  const socket = new WebSocketImpl(url.toString());
  let send = (_frame: Record<string, unknown>) => {};
  let cancel = async (_error?: unknown): Promise<void> => {};
  const queue = new ResponseQueue<Response>(() => send({ v: 2, t: "response_credit", value: 1 }), () => cancel());
  const iterator = requests[Symbol.asyncIterator]();
  let requestCredit = 0;
  let pumping = false;
  let completed = false;
  let cancelRequested = false;
  let cancellationError: unknown;
  let requestEnded = false;
  let requestsClosed = false;
  let count = 0;
  let first: Response | undefined;
  let resolveSingle!: (value: Response) => void;
  let rejectSingle!: (reason: unknown) => void;
  const singleResponse = new Promise<Response>((resolve, reject) => { resolveSingle = resolve; rejectSingle = reject; });
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  let terminalError: unknown;
  const waitForTerminal = async (): Promise<void> => {
    await terminal;
    if (terminalError !== undefined) throw terminalError;
  };
  const closeRequests = (): void => {
    if (requestsClosed) return;
    requestsClosed = true;
    void iterator.return?.().catch(() => {});
  };
  const finish = (error?: unknown, closeSocket = true) => {
    if (completed) return;
    completed = true;
    requestEnded = true;
    closeRequests();
    callerSignal?.removeEventListener("abort", onCallerAbort);
    authenticationSignal?.removeEventListener("abort", onAuthenticationChange);
    if (error === undefined) queue.end(); else queue.fail(error);
    if (singleExpected) {
      if (error !== undefined) rejectSingle(error);
      else if (count === 1 && first !== undefined) resolveSingle(first);
      else rejectSingle(new ChikClientError(ChikErrorCode.internal, "The stream returned an unexpected number of responses.", 500));
    }
    terminalError = error;
    resolveTerminal();
    if (closeSocket && (socket.readyState === 0 || socket.readyState === 1)) socket.close();
  };
  cancel = async (error = new ChikClientError(ChikErrorCode.canceled, "The stream was canceled.", chikErrorDefaultStatus(ChikErrorCode.canceled))): Promise<void> => {
    if (completed || cancelRequested) return waitForTerminal();
    cancelRequested = true;
    cancellationError = error;
    requestEnded = true;
    if (socket.readyState === 0) {
      finish(error);
      return waitForTerminal();
    }
    send({ v: 2, t: "cancel" });
    closeRequests();
    return waitForTerminal();
  };
  send = (frame: Record<string, unknown>) => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
  const pump = async () => {
    if (pumping || requestEnded) return;
    pumping = true;
    try {
      while (requestCredit > 0 && !requestEnded) {
        const next = await iterator.next();
        if (requestEnded) break;
        if (next.done) { requestEnded = true; send({ v: 2, t: "half_close" }); break; }
        requestCredit -= 1;
        send({ v: 2, t: "message", data: JSON.stringify(definition.request.encode(next.value)) });
        if (singleRequestExpected) {
          const end = await iterator.next();
          if (requestEnded) break;
          if (!end.done) throw new ChikClientError(ChikErrorCode.invalidArgument, "A server stream accepts only one request message.", 400);
          requestEnded = true;
          send({ v: 2, t: "half_close" });
          break;
        }
      }
    } catch (error) { await cancel(error).catch(() => {}); }
    finally { pumping = false; }
  };
  socket.onopen = () => {
    send({ v: 2, t: "start", responseCredit: singleExpected ? 1 : 16, ...(headers.get("authorization") ? { authorization: headers.get("authorization") } : {}) });
  };
  socket.onmessage = (event) => {
    try {
      const message = parseJSON(String(event.data), 502) as Record<string, unknown>;
      if (message.t === "ready" || message.t === "credit") {
        const value = message.t === "ready" ? message.requestCredit : message.value;
        if (!Number.isSafeInteger(value)) throw new ChikClientError(ChikErrorCode.dataLoss, "Invalid stream credit.", 502);
        requestCredit += Number(value);
        void pump();
      } else if (message.t === "message") {
        if (cancelRequested) return;
        const value = definition.response.decode(typeof message.data === "string" ? parseJSON(message.data, 502) : message.data);
        count += 1; first ??= value; queue.push(value);
      } else if (message.t === "complete") finish();
      else if (message.t === "error") {
        const code = errorCode(message.code);
        finish(cancelRequested && code.code === ChikErrorCode.canceled
          ? cancellationError
          : streamError(code, message.message));
      }
    } catch (error) { finish(error); socket.close(); }
  };
  socket.onerror = () => {
    if (!cancelRequested) finish(new ChikClientError(ChikErrorCode.unavailable, "The stream connection failed.", chikErrorDefaultStatus(ChikErrorCode.unavailable)));
  };
  socket.onclose = () => {
    if (!completed) finish(new ChikClientError(
      ChikErrorCode.unavailable,
      "The stream connection closed before a terminal response.",
      chikErrorDefaultStatus(ChikErrorCode.unavailable),
    ), false);
  };
  const onCallerAbort = (): void => {
    void cancel().catch(() => {});
  };
  const onAuthenticationChange = (): void => {
    finish(authenticationSessionChanged());
  };
  if (authenticationSignal) {
    if (authenticationSignal.aborted) onAuthenticationChange();
    else authenticationSignal.addEventListener("abort", onAuthenticationChange, { once: true });
  }
  if (!completed && callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return { responses: queue, singleResponse };
}

async function invokeRaw<Result>(
  options: ChikClientOptions,
  definition: ChikRawOperationDefinition,
  input: ChikRawOperationOptions & { path: Record<string, string>; body?: unknown; contentType?: string | undefined },
): Promise<Result> {
  let body: BodyInit | undefined;
  if (definition.requestKind === "json") {
    body = JSON.stringify(input.body);
  } else if (definition.requestKind === "octet-stream") {
    body = input.body as BodyInit | undefined;
  } else if (definition.requestKind === "multipart-form") {
    body = input.body as BodyInit | undefined;
  }
  const path = definition.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_whole, key: string) => {
    const value = input.path[key];
    if (!value) throw new ChikClientError(ChikErrorCode.invalidArgument, `A value for ${key} is required.`, 400);
    return encodeURIComponent(value);
  });
  const url = new URL(path, deploymentOrigin(options.baseUrl));
  const retry = authenticationRetryContext(
    options,
    input,
    definition.retryOnAuthenticationFailure === true
      && (definition.requestKind === "none" || definition.requestKind === "json"),
  );
  return invokeEncodedRaw(options, definition, input, url, body, retry, false);
}

async function invokeEncodedRaw<Result>(
  options: ChikClientOptions,
  definition: ChikRawOperationDefinition,
  input: ChikRawOperationOptions & { contentType?: string | undefined },
  url: URL,
  body: BodyInit | undefined,
  retry: AuthenticationRetryContext | undefined,
  retriedAfterAuthenticationFailure: boolean,
): Promise<Result> {
  const headers = requestHeaders(options, input, retry);
  const signal = combinedRequestSignal(input.signal, retry?.signal);
  if (definition.requestKind === "json") headers.set("content-type", "application/json");
  if (definition.requestKind === "octet-stream" && input.contentType) headers.set("content-type", input.contentType);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, { method: definition.method, headers, ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}) });
  } catch (error) {
    if (retry?.signal.aborted) throw authenticationSessionChanged(error);
    throw requestError(error, input.signal);
  }
  if (retry?.signal.aborted) throw authenticationSessionChanged();
  if (!response.ok) {
    const error = await responseError(response);
    assertAuthenticationCurrent(retry);
    if (
      !retriedAfterAuthenticationFailure
      && error.status === 401
      && retry !== undefined
      && await recoverAfterAuthenticationFailure(retry)
    ) {
      return invokeEncodedRaw(options, definition, input, url, body, retry, true);
    }
    throw error;
  }
  try {
    const result = definition.responseKind === "empty" ? undefined as Result : await responseJson(response) as Result;
    assertAuthenticationCurrent(retry);
    return result;
  } catch (error) {
    if (error instanceof ChikClientError) throw error;
    throw requestError(error, input.signal);
  }
}

function createLiveListQuery<Item, Request, Response>(
  options: ChikClientOptions,
  definition: ChikMethodDefinition<Request, Response>,
  request: Request,
  collection: string,
  liveOptions: ChikLiveQueryOptions<Item>,
): ChikLiveQuery {
  const authentication = authenticationRetryContext(options, { token: liveOptions.token }, false);
  let closed = false;
  let terminated = false;
  let items: readonly Item[] = [];
  let subscription: ReactiveSubscription | undefined;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let refreshTail: Promise<void> = Promise.resolve();
  let connect = () => {};
  let scheduleRenew = () => {};
  let renew = async (): Promise<void> => {};
  const detach = () => {
    if (!socket) return;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
  };
  const publish = (response: Response) => {
    const value = response as Record<string, unknown>;
    const next = value[collection];
    if (!Array.isArray(next)) throw new ChikClientError(ChikErrorCode.dataLoss, `The ${collection} response is invalid.`, 502);
    items = next as Item[];
    liveOptions.onSnapshot({ items, pending: false, ...(subscription ? { version: subscription.version, cursor: subscription.cursor } : {}) });
  };
  const refetch = (): Promise<void> => {
    const next = refreshTail.then(async () => {
      if (closed || terminated) return;
      const headers = new Headers({ [reactiveSubscribeHeader]: "1" });
      if (subscription) {
        headers.set(reactiveSubscriptionIDHeader, subscription.id);
        headers.set(reactiveVersionHeader, String(subscription.version));
      }
      try {
        const invocation = await invokeResponse(options, definition, request, { token: liveOptions.token, headers });
        const result = definition.response.decode(await responseJson(invocation.response));
        assertAuthenticationCurrent(invocation.authentication);
        subscription = reactiveSubscription(invocation.response.headers);
        publish(result);
        reconnectAttempt = 0;
        connect();
        scheduleRenew();
      } catch (error) {
        if (!closed && !terminated) { liveOptions.onSnapshot({ items, pending: false, error }); liveOptions.onError?.(error); }
      }
    });
    refreshTail = next.catch(() => undefined);
    return next;
  };
  const terminate = (error: unknown) => {
    if (terminated) return;
    terminated = true;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (renewTimer !== undefined) clearTimeout(renewTimer);
    authentication?.signal.removeEventListener("abort", onAuthenticationChange);
    detach();
    socket?.close();
    liveOptions.onSnapshot({ items, pending: false, error });
    liveOptions.onError?.(error);
  };
  connect = () => {
    if (closed || terminated || !subscription || socket?.readyState === 0 || socket?.readyState === 1) return;
    if (authentication && !authenticationRetryScopeIsCurrent(authentication)) {
      terminate(authenticationSessionChanged());
      return;
    }
    const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
    if (!WebSocketImpl) { terminate(new ChikClientError(ChikErrorCode.internal, "A realtime implementation is required.", 500)); return; }
    let headers: Headers;
    try {
      headers = requestHeaders(options, { token: liveOptions.token }, authentication);
    } catch (error) {
      terminate(error);
      return;
    }
    const url = new URL(deploymentOrigin(options.baseUrl));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/_chik/reactive";
    if (authentication?.kind === "cookie") url.searchParams.set(chikSessionScopeQuery, authentication.scope);
    url.searchParams.set("subscription_id", subscription.id);
    url.searchParams.set("identity_key", subscription.identityKey);
    url.searchParams.set("query_hash", subscription.queryHash);
    if (headers.has("authorization")) url.searchParams.set("frame_auth", "1");
    const current = new WebSocketImpl(url.toString());
    socket = current;
    current.onopen = () => { if (socket === current && headers.has("authorization")) current.send(JSON.stringify({ v: 1, t: "auth", authorization: headers.get("authorization") })); };
    current.onmessage = (event) => {
      if (socket !== current || closed || terminated) return;
      try {
        const frame = reactiveFrame(event.data);
        if (frame.type === "invalidation" && frame.id === subscription?.id) void refetch();
        if (frame.type === "snapshot" && frame.id === subscription?.id && subscription) {
          if (frame.identityKey !== subscription.identityKey || frame.version <= subscription.version) return;
          subscription = { ...subscription, version: frame.version, cursor: frame.cursor };
          publish(definition.response.decode(frame.value));
        }
      } catch (error) { liveOptions.onError?.(error); }
    };
    current.onerror = () => { if (socket === current && !closed && !terminated) liveOptions.onError?.(new ChikClientError(ChikErrorCode.unavailable, "The reactive connection failed.", 503)); };
    current.onclose = (event) => {
      if (socket !== current || closed || terminated) return;
      socket = undefined;
      if (event.code === 4401) { terminate(new ChikClientError(ChikErrorCode.unauthenticated, "Reactive authorization expired.", 401)); return; }
      if (event.code === 4000) { subscription = undefined; void refetch(); return; }
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, Math.min(1_000 * 2 ** Math.min(reconnectAttempt, 5), 30_000));
    };
  };
  scheduleRenew = () => {
    if (renewTimer !== undefined) clearTimeout(renewTimer);
    if (!subscription?.expiresAt || closed || terminated) return;
    renewTimer = setTimeout(() => { void renew(); }, Math.max(0, subscription.expiresAt - Date.now() - 60_000));
  };
  renew = async () => {
    if (!subscription || closed || terminated) return;
    try {
      const headers = requestHeaders(options, { token: liveOptions.token }, authentication);
      headers.set("content-type", "application/json");
      const response = await (options.fetch ?? globalThis.fetch)(new URL("/api/_chik/reactive/renew", deploymentOrigin(options.baseUrl)), {
        method: "POST",
        headers,
        body: JSON.stringify({ subscriptionId: subscription.id, queryHash: subscription.queryHash, expectedVersion: subscription.version }),
        ...(authentication ? { signal: authentication.signal } : {}),
      });
      assertAuthenticationCurrent(authentication);
      if (response.ok) {
        const expiresAt = Number(response.headers.get(reactiveExpiresAtHeader));
        if (Number.isSafeInteger(expiresAt) && expiresAt > Date.now()) subscription = { ...subscription, expiresAt };
        scheduleRenew();
      } else if (response.status === 404 || response.status === 409 || response.status === 410) {
        subscription = undefined;
        void refetch();
      } else {
        renewTimer = setTimeout(() => { void renew(); }, 5_000);
      }
    } catch (error) {
      if (authentication?.signal.aborted) {
        terminate(authenticationSessionChanged(error));
        return;
      }
      if (!closed && !terminated) renewTimer = setTimeout(() => { void renew(); }, 5_000);
    }
  };
  const onAuthenticationChange = (): void => terminate(authenticationSessionChanged());
  if (authentication) {
    authentication.signal.addEventListener("abort", onAuthenticationChange, { once: true });
    if (!authenticationRetryScopeIsCurrent(authentication)) onAuthenticationChange();
  }
  liveOptions.onSnapshot({ items, pending: true });
  void refetch();
  return {
    refetch,
    close: () => {
      closed = true;
      if (renewTimer !== undefined) clearTimeout(renewTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      authentication?.signal.removeEventListener("abort", onAuthenticationChange);
      detach();
      socket?.close();
    },
  };
}

interface ReactiveSubscription { id: string; identityKey: string; queryHash: string; version: number; cursor: { stream: string; position: string }; expiresAt?: number | undefined; }
const reactiveSubscribeHeader = "x-chik-reactive-subscribe";
const reactiveSubscriptionIDHeader = "x-chik-reactive-subscription-id";
const reactiveIdentityKeyHeader = "x-chik-reactive-identity-key";
const reactiveQueryHashHeader = "x-chik-reactive-query-hash";
const reactiveVersionHeader = "x-chik-reactive-version";
const reactiveCursorStreamHeader = "x-chik-reactive-cursor-stream";
const reactiveCursorPositionHeader = "x-chik-reactive-cursor-position";
const reactiveExpiresAtHeader = "x-chik-reactive-expires-at";
function reactiveSubscription(headers: Headers): ReactiveSubscription {
  const id = headers.get(reactiveSubscriptionIDHeader);
  const identityKey = headers.get(reactiveIdentityKeyHeader);
  const queryHash = headers.get(reactiveQueryHashHeader);
  const version = Number(headers.get(reactiveVersionHeader));
  const stream = headers.get(reactiveCursorStreamHeader);
  const position = headers.get(reactiveCursorPositionHeader);
  const expiresAt = Number(headers.get(reactiveExpiresAtHeader));
  if (!id || !identityKey || !queryHash || !stream || !position || !Number.isSafeInteger(version) || version < 1) throw new ChikClientError(ChikErrorCode.unavailable, "The reactive subscription response is invalid.", 503);
  return { id, identityKey, queryHash, version, cursor: { stream, position }, ...(Number.isSafeInteger(expiresAt) && expiresAt > Date.now() ? { expiresAt } : {}) };
}
function reactiveFrame(data: unknown): { type: "snapshot"; id: string; identityKey: string; version: number; cursor: { stream: string; position: string }; value: unknown } | { type: "invalidation"; id: string } {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
  const value = parseJSON(text, 502);
  if (!value || typeof value !== "object") throw new ChikClientError(ChikErrorCode.dataLoss, "The reactive message is invalid.", 502);
  const frame = value as Record<string, unknown>;
  if (frame.type === "reactive_invalidation" && typeof frame.subscriptionId === "string") return { type: "invalidation", id: frame.subscriptionId };
  if (frame.type === "reactive_snapshot" && typeof frame.subscriptionId === "string" && frame.snapshot && typeof frame.snapshot === "object") {
    const snapshot = frame.snapshot as Record<string, unknown>;
    if (typeof snapshot.identityKey === "string" && Number.isSafeInteger(snapshot.version) && snapshot.cursor && typeof snapshot.cursor === "object" && "value" in snapshot) {
      const cursor = snapshot.cursor as Record<string, unknown>;
      if (typeof cursor.stream === "string" && typeof cursor.position === "string") return { type: "snapshot", id: frame.subscriptionId, identityKey: snapshot.identityKey, version: Number(snapshot.version), cursor: { stream: cursor.stream, position: cursor.position }, value: snapshot.value };
    }
  }
  throw new ChikClientError(ChikErrorCode.dataLoss, "The reactive message is invalid.", 502);
}

class ResponseQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (reason: unknown) => void }> = [];
  #error: unknown;
  #ended = false;
  readonly #onConsumed: () => void;
  readonly #onReturn: () => Promise<void>;
  constructor(onConsumed: () => void, onReturn: () => Promise<void>) {
    this.#onConsumed = onConsumed;
    this.#onReturn = onReturn;
  }
  push(value: T): void { const waiter = this.#waiters.shift(); if (waiter) { waiter.resolve({ done: false, value }); this.#onConsumed(); } else this.#values.push(value); }
  end(): void { this.#ended = true; while (this.#waiters.length) this.#waiters.shift()?.resolve({ done: true, value: undefined }); }
  fail(error: unknown): void { this.#error = error; this.#ended = true; while (this.#waiters.length) this.#waiters.shift()?.reject(error); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: async () => { if (this.#values.length) { this.#onConsumed(); return { done: false, value: this.#values.shift()! }; } if (this.#error !== undefined) throw this.#error; if (this.#ended) return { done: true, value: undefined }; return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject })); }, return: async () => { await this.#onReturn(); this.end(); return { done: true, value: undefined }; } }; }
}

function requestError(error: unknown, signal?: AbortSignal | undefined): ChikClientError {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new ChikClientError(ChikErrorCode.canceled, "The request was canceled.", chikErrorDefaultStatus(ChikErrorCode.canceled), [], { cause: error });
  }
  return new ChikClientError(ChikErrorCode.unavailable, error instanceof Error ? error.message : "The request could not be sent.", chikErrorDefaultStatus(ChikErrorCode.unavailable), [], { cause: error });
}

function streamError(
  code: { code: ChikClientErrorCode; rawCode?: string },
  message: unknown,
): ChikClientError {
  return new ChikClientError(
    code.code,
    code.code === ChikErrorCode.internal
      ? "An internal server error occurred."
      : typeof message === "string" ? message : "The stream failed.",
    chikErrorDefaultStatus(code.code),
    [],
    { rawCode: code.rawCode },
  );
}

async function responseJson(response: Response): Promise<unknown> { return parseJSON(await response.text(), response.status); }
async function responseError(response: Response): Promise<ChikClientError> {
  const value = await response.text().then((body) => parseJSONOrUndefined(body));
  const record = value && typeof value === "object" ? value as { code?: unknown; message?: unknown; details?: unknown } : {};
  const code = errorCode(record.code);
  return new ChikClientError(code.code, typeof record.message === "string" ? record.message : `HTTP ${response.status}`, response.status, Array.isArray(record.details) ? record.details : [], { rawCode: code.rawCode });
}
function errorCode(value: unknown): { code: ChikClientErrorCode; rawCode?: string } {
  if (isChikProtocolErrorCode(value)) return { code: value };
  return {
    code: ChikErrorCode.unknown,
    ...(typeof value === "string" && value !== ChikErrorCode.unknown ? { rawCode: value } : {}),
  };
}
function parseJSON(text: string, status: number): unknown { const value = parseJSONOrUndefined(text); if (value === undefined) throw new ChikClientError(ChikErrorCode.dataLoss, "The response is not valid JSON.", status); return value; }
function parseJSONOrUndefined(text: string): unknown | undefined { try { return JSON.parse(text) as unknown; } catch { return undefined; } }
function plainRecord(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object.`); return value as Record<string, unknown>; }
function ownValue(value: Record<string, unknown>, key: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
function ownRequired(value: Record<string, unknown>, key: string, name: string): unknown { const result = ownValue(value, key); if (result === undefined) throw new TypeError(`${name}.${key} is missing.`); return result; }
function listValue(value: unknown, name: string): unknown[] { if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`); return value; }
function requireModel(field: ChikModelFieldSpec): string { if (!field.model) throw new TypeError(`${field.property} has no model codec.`); return field.model; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string") throw new TypeError(`${name} must be a string.`); return value; }
function encodeBytes(value: unknown): string { if (!(value instanceof Uint8Array)) throw new TypeError("A bytes field must be a Uint8Array."); let text = ""; for (const byte of value) text += String.fromCharCode(byte); return btoa(text); }
function decodeBytes(value: unknown): Uint8Array { const text = requiredString(value, "bytes"); const binary = atob(text); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }

type PlainJsonValue = null | boolean | number | string | PlainJsonValue[] | { [key: string]: PlainJsonValue };

export function encodeChikJsonValue(value: ChikJsonInput): PlainJsonValue {
  if (value === chikJsonNull) return null;
  return normalizeJson(value, new WeakSet<object>(), "$", false);
}

export function decodeChikJsonValue(value: unknown): ChikJsonValue {
  if (value === null) return chikJsonNull;
  return normalizeJson(value, new WeakSet<object>(), "$", false) as ChikJsonValue;
}

export function serializeChikJson(value: ChikJsonInput): string {
  const serialized = JSON.stringify(encodeChikJsonValue(value));
  if (serialized === undefined) throw new TypeError("JSON value cannot be serialized.");
  return serialized;
}

function normalizeJson(value: unknown, ancestors: WeakSet<object>, path: string, nested: boolean): PlainJsonValue {
  if (value === null) {
    if (nested) return null;
    throw new TypeError("A top-level raw null is not a JSON value. Use chikJsonNull for a JSON literal null.");
  }
  if (value === chikJsonNull) throw new TypeError(`${path}: chikJsonNull can only be used as a top-level JSON literal null.`);
  switch (typeof value) {
    case "string":
    case "boolean": return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: JSON numbers must be finite.`);
      return value;
    case "object": return normalizeJsonObject(value, ancestors, path);
    case "undefined": throw new TypeError(`${path}: JSON values cannot contain undefined.`);
    default: throw new TypeError(`${path}: ${nested ? "nested" : "top-level"} value must be JSON data.`);
  }
}

function normalizeJsonObject(value: object, ancestors: WeakSet<object>, path: string): PlainJsonValue {
  if (ancestors.has(value)) throw new TypeError(`${path}: JSON value contains a cyclic reference.`);
  ancestors.add(value);
  try {
    return Array.isArray(value) ? normalizeJsonArray(value, ancestors, path) : normalizeJsonRecord(value, ancestors, path);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeJsonArray(value: unknown[], ancestors: WeakSet<object>, path: string): PlainJsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${path}: JSON arrays must be plain arrays.`);
  const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
  if (keys.length !== value.length || keys.some((key) => typeof key !== "string" || !arrayIndex(key, value.length))) {
    throw new TypeError(`${path}: JSON arrays cannot be sparse or have extra properties.`);
  }
  const output: PlainJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    output.push(normalizeJson(dataValue(Object.getOwnPropertyDescriptor(value, String(index)), `${path}[${index}]`), ancestors, `${path}[${index}]`, true));
  }
  return output;
}

function normalizeJsonRecord(value: object, ancestors: WeakSet<object>, path: string): { [key: string]: PlainJsonValue } {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${path}: JSON objects must be plain objects.`);
  const output: { [key: string]: PlainJsonValue } = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${path}: JSON objects cannot contain symbol properties.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) throw new TypeError(`${jsonPath(path, key)}: JSON values cannot contain non-enumerable properties.`);
    Object.defineProperty(output, key, { configurable: true, enumerable: true, writable: true, value: normalizeJson(dataValue(descriptor, jsonPath(path, key)), ancestors, jsonPath(path, key), true) });
  }
  return output;
}

function dataValue(descriptor: PropertyDescriptor | undefined, path: string): unknown {
  if (!descriptor || !("value" in descriptor)) throw new TypeError(`${path}: JSON values cannot use accessors.`);
  return descriptor.value;
}

function arrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function jsonPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function canonicalTemporalValue(kind: NonNullable<ChikModelFieldSpec["temporal"]>, value: unknown): string {
  const text = requiredString(value, kind);
  if (kind === "date") return canonicalDate(text);
  if (kind === "timestamp") return canonicalTimestamp(text);
  return canonicalTimestampWithTimezone(text);
}

function canonicalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match || !validDate(match[1]!, match[2]!, match[3]!)) throw new TypeError("date value is invalid.");
  return value;
}

function canonicalTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?$/u.exec(value);
  if (!match || !validDateTime(match[1]!, match[2]!)) throw new TypeError("timestamp value is invalid.");
  return `${match[1]}T${match[2]}${match[3] ?? ""}`;
}

function canonicalTimestampWithTimezone(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)$/u.exec(value);
  if (!match || !validDate(match[1]!, match[2]!, match[3]!) || !validTime(match[4]!, match[5]!, match[6]!)) throw new TypeError("timestamp with timezone value is invalid.");
  const offset = timestampOffsetMilliseconds(match[8]!, value);
  const instant = new Date(0);
  instant.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  instant.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
  instant.setTime(instant.getTime() - offset);
  if (Number.isNaN(instant.getTime())) throw new TypeError("timestamp with timezone value is invalid.");
  const iso = instant.toISOString();
  if (!/^\d{4}-/u.test(iso)) throw new TypeError("timestamp with timezone value is invalid.");
  return `${iso.slice(0, 19)}${match[7] ?? ""}Z`;
}

function timestampOffsetMilliseconds(offset: string, value: string): number {
  if (offset === "Z") return 0;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/u.exec(offset);
  if (!match || Number(match[2]) > 23 || Number(match[3] ?? "0") > 59 || Number(match[4] ?? "0") > 59) throw new TypeError(`${value} has an invalid time zone offset.`);
  const milliseconds = (Number(match[2]) * 3_600 + Number(match[3] ?? "0") * 60 + Number(match[4] ?? "0")) * 1_000;
  return match[1] === "-" ? -milliseconds : milliseconds;
}

function validDateTime(date: string, time: string): boolean {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(time);
  return Boolean(dateMatch && timeMatch && validDate(dateMatch[1]!, dateMatch[2]!, dateMatch[3]!) && validTime(timeMatch[1]!, timeMatch[2]!, timeMatch[3]!));
}

function validDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function validTime(hour: string, minute: string, second: string): boolean {
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
