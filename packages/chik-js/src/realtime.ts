import {
  ChikClientError,
  ChikErrorCode,
  type ChikClientOptions,
  type ChikCookieSessionSource,
  type ChikSessionTokenSource,
} from "./core.js";
import {
  ChikErrorMessage,
  isChikProtocolErrorCode,
  type ChikErrorCode as ChikClientErrorCode,
  type ChikProtocolErrorCode,
} from "./error-contract.js";
import { chikSessionScopeHeader, chikSessionScopeQuery } from "./wire-contract.js";

export interface ChikRealtimeEvent {
  channel?: string | undefined;
  seq: number;
  ts: number;
  payload: unknown;
}

export interface ChikRealtimeGap {
  channel?: string | undefined;
  oldestSeq: number;
  latestSeq: number;
}

export type ChikRealtimeErrorCode =
  | ChikProtocolErrorCode
  | typeof ChikErrorCode.unauthorized
  | typeof ChikErrorCode.channelLimit
  | typeof ChikErrorCode.payloadTooLarge;

export interface ChikRealtimeProtocolError {
  code: ChikRealtimeErrorCode;
  message: string;
  rawCode?: string | undefined;
  cause?: unknown;
}

export interface ChikRealtimePublishResult {
  seq: number;
  ts: number;
}

export interface ChikRealtimeSubscribeOptions {
  lastSeq?: number | undefined;
  token?: string | undefined;
  onEvent(event: ChikRealtimeEvent): void;
  onGap(gap: ChikRealtimeGap): void;
  onError?(error: ChikRealtimeProtocolError): void;
}

export interface ChikRealtimeSubscription { close(): void; }

export interface ChikRealtimeConnectionOptions {
  token?: string | undefined;
  onEvent(event: ChikRealtimeEvent): void;
  onGap(gap: ChikRealtimeGap): void;
  onError?(error: ChikRealtimeProtocolError): void;
}

export interface ChikRealtimeConnection {
  subscribe(channel: string, options?: { lastSeq?: number | undefined }): void;
  unsubscribe(channel: string): void;
  close(): void;
}

export interface ChikRealtimeClient {
  publish(channel: string, payload: unknown, options?: { token?: string | undefined }): Promise<ChikRealtimePublishResult>;
  subscribe(channel: string, options: ChikRealtimeSubscribeOptions): ChikRealtimeSubscription;
  connect(options: ChikRealtimeConnectionOptions): ChikRealtimeConnection;
}

export function createChikRealtimeClient(options: ChikClientOptions): ChikRealtimeClient {
  return {
    async publish(channel, payload, publishOptions = {}) {
      const authorizationScope = captureAuthorizationScope(options, publishOptions.token);
      const headers = authorizationHeaders(options, publishOptions.token, authorizationScope);
      headers.set("content-type", "application/json");
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(publishURL(options.baseUrl, channel), {
          method: "POST",
          headers,
          body: JSON.stringify({ payload }),
          ...(authorizationScope ? { signal: authorizationScope.signal } : {}),
          ...(headers.has("authorization") ? { redirect: "error" } : {}),
        });
      } catch (error) {
        if (authorizationScope?.signal.aborted) throw authorizationSessionChanged(error);
        throw error;
      }
      if (authorizationScope && !authorizationScopeIsCurrent(authorizationScope)) throw authorizationSessionChanged();
      if (!response.ok) {
        const error = await realtimeError(response);
        assertAuthorizationScopeCurrent(authorizationScope);
        throw error;
      }
      const result = await response.json() as ChikRealtimePublishResult;
      assertAuthorizationScopeCurrent(authorizationScope);
      return result;
    },
    subscribe(channel, subscribeOptions) {
      let closed = false;
      let socket: WebSocket | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let lastSeq = validSequence(subscribeOptions.lastSeq ?? 0);
      let unauthorizedReported = false;
      let authorizationRecoveryUsed = false;
      let authorizationRecoveryInFlight = false;
      const authorizationScope = captureAuthorizationScope(options, subscribeOptions.token);
      let releaseAuthorizationScope = () => {};
      let open = () => {};
      const stopUnauthorized = (message: string) => {
        closed = true;
        releaseAuthorizationScope();
        const current = socket;
        socket = undefined;
        current?.close();
        if (!unauthorizedReported) {
          unauthorizedReported = true;
          subscribeOptions.onError?.({ code: ChikErrorCode.unauthorized, message });
        }
      };
      releaseAuthorizationScope = observeAuthorizationScope(authorizationScope, () => {
        stopUnauthorized(ChikErrorMessage.authenticationSessionChanged);
      });
      const recoverAuthorization = (message: string) => {
        if (closed) return;
        if (authorizationRecoveryUsed || authorizationRecoveryInFlight) { stopUnauthorized(message); return; }
        authorizationRecoveryUsed = true;
        authorizationRecoveryInFlight = true;
        const current = socket;
        socket = undefined;
        current?.close();
        void refreshAuthorization(subscribeOptions.token, authorizationScope).then((refreshed) => {
          authorizationRecoveryInFlight = false;
          if (closed) return;
          if (!refreshed) { stopUnauthorized(message); return; }
          open();
        }).catch(() => {
          authorizationRecoveryInFlight = false;
          if (!closed) stopUnauthorized(message);
        });
      };
      open = () => {
        if (closed) return;
        if (authorizationScope && !authorizationScopeIsCurrent(authorizationScope)) {
          stopUnauthorized(ChikErrorMessage.authenticationSessionChanged);
          return;
        }
        const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
        if (!WebSocketImpl) throw new ChikClientError(ChikErrorCode.internal, "A realtime implementation is required.", 500);
        const authorization = authorizationHeaders(options, subscribeOptions.token, authorizationScope).get("authorization") ?? undefined;
        const current = new WebSocketImpl(socketURL(options.baseUrl, `/v1/realtime/${encodeURIComponent(channel)}`, {
          last_seq: String(lastSeq),
          ...(authorizationScope?.kind === "cookie" ? { [chikSessionScopeQuery]: authorizationScope.scope } : {}),
          ...(authorization ? { frame_auth: "1" } : {}),
        }));
        socket = current;
        current.onopen = () => {
          if (closed || socket !== current) return;
          attempt = 0;
          if (authorization) current.send(JSON.stringify({ v: 1, t: "auth", authorization }));
        };
        current.onmessage = (event) => {
          if (closed || socket !== current) return;
          try {
            const frame = realtimeFrame(event.data);
            if (frame.t === "event") { lastSeq = frame.seq; subscribeOptions.onEvent({ seq: frame.seq, ts: frame.ts, payload: frame.payload }); }
            else if (frame.t === "gap") { lastSeq = Math.max(lastSeq, frame.latestSeq); subscribeOptions.onGap({ oldestSeq: frame.oldestSeq, latestSeq: frame.latestSeq }); }
            else if (frame.t === "error") {
              if (frame.code === ChikErrorCode.unauthorized) recoverAuthorization(frame.message);
              else subscribeOptions.onError?.(frame);
            }
          } catch (cause) { subscribeOptions.onError?.(realtimeFailure(cause)); }
        };
        current.onerror = (cause) => { if (!closed && socket === current) subscribeOptions.onError?.(realtimeFailure(cause, "The realtime connection failed.")); };
        current.onclose = (event) => {
          if (closed || socket !== current) return;
          if (event.code === 4401) { recoverAuthorization("Realtime authorization is required."); return; }
          attempt += 1;
          reconnectTimer = globalThis.setTimeout(open, Math.min(1_000 * attempt, 10_000));
        };
      };
      open();
      return { close: () => { if (closed) return; closed = true; releaseAuthorizationScope(); if (reconnectTimer !== undefined) clearTimeout(reconnectTimer); socket?.close(); } };
    },
    connect(connectionOptions) {
      let closed = false;
      let socket: WebSocket | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      const subscriptions = new Map<string, number>();
      let unauthorizedReported = false;
      let authorizationRecoveryUsed = false;
      let authorizationRecoveryInFlight = false;
      const authorizationScope = captureAuthorizationScope(options, connectionOptions.token);
      let releaseAuthorizationScope = () => {};
      let open = () => {};
      const stopUnauthorized = (message: string) => {
        closed = true;
        releaseAuthorizationScope();
        const current = socket;
        socket = undefined;
        current?.close();
        if (!unauthorizedReported) {
          unauthorizedReported = true;
          connectionOptions.onError?.({ code: ChikErrorCode.unauthorized, message });
        }
      };
      releaseAuthorizationScope = observeAuthorizationScope(authorizationScope, () => {
        stopUnauthorized(ChikErrorMessage.authenticationSessionChanged);
      });
      const recoverAuthorization = (message: string) => {
        if (closed) return;
        if (authorizationRecoveryUsed || authorizationRecoveryInFlight) { stopUnauthorized(message); return; }
        authorizationRecoveryUsed = true;
        authorizationRecoveryInFlight = true;
        const current = socket;
        socket = undefined;
        current?.close();
        void refreshAuthorization(connectionOptions.token, authorizationScope).then((refreshed) => {
          authorizationRecoveryInFlight = false;
          if (closed) return;
          if (!refreshed) { stopUnauthorized(message); return; }
          open();
        }).catch(() => {
          authorizationRecoveryInFlight = false;
          if (!closed) stopUnauthorized(message);
        });
      };
      const send = (frame: unknown) => { if (!closed && socket?.readyState === 1) socket.send(JSON.stringify(frame)); };
      open = () => {
        if (closed) return;
        if (authorizationScope && !authorizationScopeIsCurrent(authorizationScope)) {
          stopUnauthorized(ChikErrorMessage.authenticationSessionChanged);
          return;
        }
        const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
        if (!WebSocketImpl) throw new ChikClientError(ChikErrorCode.internal, "A realtime implementation is required.", 500);
        const authorization = authorizationHeaders(options, connectionOptions.token, authorizationScope).get("authorization") ?? undefined;
        const current = new WebSocketImpl(socketURL(options.baseUrl, "/v1/realtime", {
          ...(authorizationScope?.kind === "cookie" ? { [chikSessionScopeQuery]: authorizationScope.scope } : {}),
          ...(authorization ? { frame_auth: "1" } : {}),
        }));
        socket = current;
        current.onopen = () => {
          if (closed || socket !== current) return;
          attempt = 0;
          if (authorization) send({ v: 1, t: "auth", authorization });
          for (const [channel, lastSeq] of subscriptions) send({ v: 1, t: "sub", channel, last_seq: lastSeq });
        };
        current.onmessage = (event) => {
          if (closed || socket !== current) return;
          try {
            const frame = realtimeFrame(event.data);
            if (frame.t === "event") { if (frame.channel) subscriptions.set(frame.channel, frame.seq); connectionOptions.onEvent({ channel: frame.channel, seq: frame.seq, ts: frame.ts, payload: frame.payload }); }
            else if (frame.t === "gap") { if (frame.channel) subscriptions.set(frame.channel, frame.latestSeq); connectionOptions.onGap({ channel: frame.channel, oldestSeq: frame.oldestSeq, latestSeq: frame.latestSeq }); }
            else if (frame.t === "error") {
              if (frame.code === ChikErrorCode.unauthorized) recoverAuthorization(frame.message);
              else connectionOptions.onError?.(frame);
            }
          } catch (cause) { connectionOptions.onError?.(realtimeFailure(cause)); }
        };
        current.onclose = (event) => {
          if (closed || socket !== current) return;
          if (event.code === 4401) { recoverAuthorization("Realtime authorization is required."); return; }
          attempt += 1;
          reconnectTimer = globalThis.setTimeout(open, Math.min(1_000 * attempt, 10_000));
        };
      };
      open();
      return {
        subscribe(channel, subscribeOptions = {}) { const lastSeq = validSequence(subscribeOptions.lastSeq ?? subscriptions.get(channel) ?? 0); subscriptions.set(channel, lastSeq); send({ v: 1, t: "sub", channel, last_seq: lastSeq }); },
        unsubscribe(channel) { subscriptions.delete(channel); send({ v: 1, t: "unsub", channel }); },
        close() { if (closed) return; closed = true; releaseAuthorizationScope(); if (reconnectTimer !== undefined) clearTimeout(reconnectTimer); socket?.close(); },
      };
    },
  };
}

function authorizationHeaders(options: ChikClientOptions, override?: string, scope?: AuthorizationScope): Headers {
  if (scope && !authorizationScopeIsCurrent(scope)) throw authorizationSessionChanged();
  const headers = new Headers(options.headers);
  if (!headers.has("authorization")) {
    const token = override ?? (scope
      ? scope.token
      : (options.sessionTokenSource ? options.sessionTokenSource.getSessionToken() : options.sessionToken) ?? options.apiKey);
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  if (scope?.kind === "cookie") headers.set(chikSessionScopeHeader, scope.scope);
  return headers;
}

type AuthorizationScope = {
  readonly source: ChikSessionTokenSource | ChikCookieSessionSource;
  readonly kind: "token" | "cookie";
  readonly scope: string;
  readonly signal: AbortSignal;
  readonly retryEnabled: boolean;
  token?: string | undefined;
};

function captureAuthorizationScope(options: ChikClientOptions, override?: string): AuthorizationScope | undefined {
  if (override !== undefined || new Headers(options.headers).has("authorization")) return undefined;
  const tokenSource = options.sessionTokenSource;
  if (tokenSource) {
    const token = tokenSource.getSessionToken()?.trim();
    const scope = tokenSource.getSessionScope?.();
    const signal = tokenSource.getSessionScopeSignal?.();
    if (signal?.aborted) throw authorizationSessionChanged();
    if (scope === undefined && signal === undefined) return undefined;
    if (!scope?.trim() || !signal) throw authorizationSessionChanged();
    return {
      kind: "token",
      source: tokenSource,
      scope,
      signal,
      retryEnabled: typeof tokenSource.refreshSession === "function",
      ...(token ? { token } : {}),
    };
  }
  const cookieSource = options.cookieSessionSource;
  if (!cookieSource || options.sessionToken?.trim() || options.apiKey?.trim()) return undefined;
  const scope = cookieSource.getSessionScope();
  const signal = cookieSource.getSessionScopeSignal();
  if (signal?.aborted) throw authorizationSessionChanged();
  if (scope === undefined && signal === undefined) return undefined;
  if (!scope?.trim() || !signal) throw authorizationSessionChanged();
  return { kind: "cookie", source: cookieSource, scope, signal, retryEnabled: true };
}

function authorizationSessionChanged(cause?: unknown): ChikClientError {
  return new ChikClientError(
    ChikErrorCode.aborted,
    ChikErrorMessage.authenticationSessionChanged,
    409,
    [],
    cause === undefined ? {} : { cause },
  );
}

function authorizationScopeIsCurrent(value: AuthorizationScope): boolean {
  return !value.signal.aborted
    && value.source.getSessionScope?.() === value.scope
    && value.source.getSessionScopeSignal?.() === value.signal;
}

function assertAuthorizationScopeCurrent(value: AuthorizationScope | undefined): void {
  if (value && !authorizationScopeIsCurrent(value)) throw authorizationSessionChanged();
}

async function refreshAuthorization(
  override: string | undefined,
  scope: AuthorizationScope | undefined,
): Promise<boolean> {
  const refreshSession = scope?.source.refreshSession;
  if (override !== undefined || !scope?.retryEnabled || !refreshSession || !authorizationScopeIsCurrent(scope)) return false;
  const token = await refreshSession.call(scope.source, scope.scope);
  if (!authorizationScopeIsCurrent(scope) || typeof token !== "string" || !token.trim()) return false;
  if (scope.kind === "token") scope.token = token.trim();
  else if (token !== scope.scope) return false;
  return true;
}

function observeAuthorizationScope(
  scope: AuthorizationScope | undefined,
  onChange: () => void,
): () => void {
  if (!scope) return () => {};
  scope.signal.addEventListener("abort", onChange, { once: true });
  if (!authorizationScopeIsCurrent(scope)) onChange();
  return () => scope.signal.removeEventListener("abort", onChange);
}

function baseURL(baseUrl: string): URL {
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
  url.pathname = "/";
  return url;
}

function httpURL(baseUrl: string, path: string): string {
  const url = baseURL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/u, "") + path;
  return url.toString();
}
function publishURL(baseUrl: string, channel: string): string {
  return httpURL(baseUrl, `/v1/realtime/${encodeURIComponent(channel)}/publish`);
}
function socketURL(baseUrl: string, path: string, parameters: Record<string, string>): string {
  const url = baseURL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/u, "") + path;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

function validSequence(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw new ChikClientError(ChikErrorCode.invalidArgument, "lastSeq must be a non-negative integer.", 400); return value; }

function realtimeFrame(data: unknown): { t: "event"; channel?: string; seq: number; ts: number; payload: unknown } | { t: "gap"; channel?: string; oldestSeq: number; latestSeq: number } | ({ t: "error" } & ChikRealtimeProtocolError) {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new ChikClientError(ChikErrorCode.dataLoss, "The realtime message is not valid JSON.", 502); }
  if (!value || typeof value !== "object") throw new ChikClientError(ChikErrorCode.dataLoss, "The realtime message is invalid.", 502);
  const frame = value as Record<string, unknown>;
  if (frame.t === "event" && Number.isSafeInteger(frame.seq) && Number.isSafeInteger(frame.ts) && "payload" in frame) return { t: "event", ...(typeof frame.channel === "string" ? { channel: frame.channel } : {}), seq: Number(frame.seq), ts: Number(frame.ts), payload: frame.payload };
  if (frame.t === "gap" && Number.isSafeInteger(frame.oldest_seq) && Number.isSafeInteger(frame.latest_seq)) return { t: "gap", ...(typeof frame.channel === "string" ? { channel: frame.channel } : {}), oldestSeq: Number(frame.oldest_seq), latestSeq: Number(frame.latest_seq) };
  if (frame.t === "error" && typeof frame.message === "string") return { t: "error", ...realtimeErrorCode(frame.code), message: frame.message };
  throw new ChikClientError(ChikErrorCode.dataLoss, "The realtime message is invalid.", 502);
}

function realtimeErrorCode(value: unknown): Pick<ChikRealtimeProtocolError, "code" | "rawCode"> {
  if (isChikProtocolErrorCode(value)) return { code: value };
  if (value === ChikErrorCode.unauthorized) return { code: ChikErrorCode.unauthorized };
  if (value === ChikErrorCode.channelLimit) return { code: ChikErrorCode.channelLimit };
  if (value === ChikErrorCode.payloadTooLarge) return { code: ChikErrorCode.payloadTooLarge };
  return {
    code: ChikErrorCode.unknown,
    ...(typeof value === "string" && value !== ChikErrorCode.unknown ? { rawCode: value } : {}),
  };
}

function realtimeFailure(cause: unknown, fallbackMessage = "Invalid realtime message."): ChikRealtimeProtocolError {
  if (cause instanceof ChikClientError) {
    return { ...realtimeErrorCode(cause.code), message: cause.message, cause };
  }
  return {
    code: ChikErrorCode.internal,
    message: cause instanceof Error ? cause.message : fallbackMessage,
    cause,
  };
}

async function realtimeError(response: Response): Promise<ChikClientError> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = isChikProtocolErrorCode(value.code) ? value.code : ChikErrorCode.unknown;
    const rawCode = typeof value.code === "string" && code === ChikErrorCode.unknown && value.code !== ChikErrorCode.unknown ? value.code : undefined;
    return new ChikClientError(code as ChikClientErrorCode, typeof value.message === "string" ? value.message : `HTTP ${response.status}`, response.status, [], { rawCode });
  } catch (cause) { return new ChikClientError(ChikErrorCode.unknown, `HTTP ${response.status}`, response.status, [], { cause }); }
}
