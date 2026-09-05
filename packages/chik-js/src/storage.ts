import { ChikClientError, type ChikClientOptions, type ChikCookieSessionSource, type ChikSessionTokenSource } from "./core.js";
import { ChikErrorCode, ChikErrorMessage, chikErrorCodeFromWire, isChikErrorCode, type ChikErrorCode as ChikErrorCodeValue } from "./error-contract.js";
import { chikSessionScopeHeader } from "./wire-contract.js";

export type ChikStorageClientOptions = ChikClientOptions;

export interface ChikStorageCreateUploadInput {
  bucket: string;
  key: string;
  contentType: string;
  size: number;
  contentSha256?: string | undefined;
  expiresInSeconds?: number | undefined;
  idempotencyKey?: string | undefined;
}

export interface ChikStorageDownloadInput { bucket: string; key: string; expiresInSeconds?: number | undefined; }
export interface ChikStoragePublicUrlInput { bucket: string; key: string; }

export class ChikStorageApiError extends Error {
  readonly rawCode: string | undefined;

  constructor(readonly code: ChikErrorCodeValue, message: string, readonly status: number, options: { cause?: unknown; rawCode?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChikStorageApiError";
    this.rawCode = options.rawCode;
  }
}

export class ChikStorageUploadCommitUnknownError extends Error {
  readonly code = ChikErrorCode.commitUnknown;
  constructor(readonly uploadId: string, message: string, readonly status: number, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChikStorageUploadCommitUnknownError";
  }
}

export function isChikStorageUploadCommitUnknownError(error: unknown): error is ChikStorageUploadCommitUnknownError {
  return error instanceof ChikStorageUploadCommitUnknownError;
}

export interface ChikStorageUpload {
  readonly id: string;
  readonly expiresAt: string;
  put(body: BodyInit, init?: { signal?: AbortSignal | undefined }): Promise<void>;
  complete(): Promise<unknown>;
  abort(): Promise<void>;
}

export interface ChikStorageClient {
  createUpload(input: ChikStorageCreateUploadInput): Promise<ChikStorageUpload>;
  getDownloadUrl(input: ChikStorageDownloadInput): Promise<{ url: string; expiresAt: string }>;
  getPublicUrl(input: ChikStoragePublicUrlInput): string;
}

interface SingleUpload { uploadIntentId: string; expiresAt: string; uploadUrl: string; requiredHeaders: Record<string, string>; }
interface MultipartUpload { uploadIntentId: string; expiresAt: string; uploadMode: "multipart"; partSizeBytes: string; partCount: number; multipartToken: string; }

export function createChikStorageClient(options: ChikStorageClientOptions): ChikStorageClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const base = storageOrigin(options.baseUrl);
  return {
    async createUpload(input) {
      const request = {
        method: "POST",
        body: JSON.stringify({
          bucket: input.bucket,
          key: input.key,
          contentType: input.contentType,
          size: input.size,
          ...(input.contentSha256 ? { contentSha256: input.contentSha256 } : {}),
          expiresInSeconds: input.expiresInSeconds ?? 900,
          idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
        }),
      } satisfies RequestInit;
      const authentication = storageAuthenticationRetryContext(options, request, false);
      const created = await storageJSON<SingleUpload | MultipartUpload>(fetchImplementation, base, options, "/api/storage/uploads", request, false, authentication);
      if (isMultipart(created)) return multipartUpload(fetchImplementation, base, options, input, created, authentication);
      return singleUpload(fetchImplementation, base, options, created, authentication);
    },
    getDownloadUrl(input) {
      return storageJSON(fetchImplementation, base, options, "/api/storage/download-url", { method: "POST", body: JSON.stringify({ bucket: input.bucket, key: input.key, expiresInSeconds: input.expiresInSeconds ?? 900 }) }, true);
    },
    getPublicUrl(input) {
      const url = new URL("/api/storage/public", base);
      url.searchParams.set("bucket", input.bucket);
      url.searchParams.set("key", input.key);
      return url.toString();
    },
  };
}

function singleUpload(
  fetchImplementation: typeof fetch,
  base: string,
  options: ChikStorageClientOptions,
  descriptor: SingleUpload,
  authentication: StorageAuthenticationRetryContext | undefined,
): ChikStorageUpload {
  return {
    id: descriptor.uploadIntentId,
    expiresAt: descriptor.expiresAt,
    async put(body, init = {}) {
      assertStorageAuthenticationCurrent(authentication);
      const url = sameOriginUploadURL(base, descriptor.uploadUrl);
      const signal = combinedStorageSignal(init.signal, authentication?.signal);
      let response: Response;
      try {
        response = await fetchImplementation(url, { method: "PUT", headers: descriptor.requiredHeaders, body, ...(signal ? { signal } : {}) });
      } catch (error) {
        if (authentication?.signal.aborted) throw storageAuthenticationChanged(error);
        throw error;
      }
      assertStorageAuthenticationCurrent(authentication);
      if (response.ok) return;
      const error = await storageError(response, "Storage upload");
      assertStorageAuthenticationCurrent(authentication);
      if (error.code === ChikErrorCode.commitUnknown) throw new ChikStorageUploadCommitUnknownError(descriptor.uploadIntentId, "The upload result could not be verified. Check completion before retrying.", error.status, { cause: error });
      throw error;
    },
    complete: () => storageJSON(fetchImplementation, base, options, `/api/storage/uploads/${encodeURIComponent(descriptor.uploadIntentId)}/complete`, { method: "POST" }, false, authentication),
    abort: async () => { await storageJSON(fetchImplementation, base, options, `/api/storage/uploads/${encodeURIComponent(descriptor.uploadIntentId)}`, { method: "DELETE" }, false, authentication); },
  };
}

function multipartUpload(
  fetchImplementation: typeof fetch,
  base: string,
  options: ChikStorageClientOptions,
  input: ChikStorageCreateUploadInput,
  descriptor: MultipartUpload,
  authentication: StorageAuthenticationRetryContext | undefined,
): ChikStorageUpload {
  return {
    id: descriptor.uploadIntentId,
    expiresAt: descriptor.expiresAt,
    async put(body, init = {}) {
      assertStorageAuthenticationCurrent(authentication);
      if (!(body instanceof Blob)) throw new ChikStorageApiError(ChikErrorCode.multipartBodyRequired, "Multipart uploads require a Blob or File.", 400);
      const partSize = Number(descriptor.partSizeBytes);
      if (!Number.isSafeInteger(partSize) || partSize < 1 || !Number.isSafeInteger(descriptor.partCount) || descriptor.partCount < 1 || Math.ceil(body.size / partSize) !== descriptor.partCount || body.size !== input.size) {
        throw new ChikStorageApiError(ChikErrorCode.invalidMultipartPlan, "The multipart upload plan is invalid.", 502);
      }
      const signal = combinedStorageSignal(init.signal, authentication?.signal);
      for (let part = 1; part <= descriptor.partCount; part += 1) {
        const chunk = body.slice((part - 1) * partSize, Math.min(part * partSize, body.size), input.contentType);
        await putPart(fetchImplementation, base, descriptor, part, chunk, input.contentType, signal, authentication);
      }
    },
    complete: () => storageJSON(fetchImplementation, base, options, `/api/storage/uploads/${encodeURIComponent(descriptor.uploadIntentId)}/complete`, { method: "POST" }, false, authentication),
    abort: async () => { await storageJSON(fetchImplementation, base, options, `/api/storage/uploads/${encodeURIComponent(descriptor.uploadIntentId)}`, { method: "DELETE" }, false, authentication); },
  };
}

async function putPart(
  fetchImplementation: typeof fetch,
  base: string,
  descriptor: MultipartUpload,
  part: number,
  body: Blob,
  contentType: string,
  signal: AbortSignal | undefined,
  authentication: StorageAuthenticationRetryContext | undefined,
): Promise<void> {
  const url = new URL(`/api/storage/uploads/${encodeURIComponent(descriptor.uploadIntentId)}/parts/${part}`, base);
  url.searchParams.set("token", descriptor.multipartToken);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertStorageAuthenticationCurrent(authentication);
    let response: Response;
    try {
      response = await fetchImplementation(url, { method: "PUT", headers: { "content-type": contentType }, body, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (authentication?.signal.aborted) throw storageAuthenticationChanged(error);
      throw error;
    }
    assertStorageAuthenticationCurrent(authentication);
    if (response.ok) return;
    const error = await storageError(response, "Storage upload part");
    assertStorageAuthenticationCurrent(authentication);
    if (error.code !== ChikErrorCode.commitUnknown || attempt === 2) {
      if (error.code === ChikErrorCode.commitUnknown) throw new ChikStorageUploadCommitUnknownError(descriptor.uploadIntentId, "The part upload result could not be verified. Retry the same upload.", error.status, { cause: error });
      throw error;
    }
  }
}

function isMultipart(value: SingleUpload | MultipartUpload): value is MultipartUpload { return "uploadMode" in value && value.uploadMode === "multipart"; }

async function storageJSON<Result>(
  fetchImplementation: typeof fetch,
  base: string,
  options: ChikStorageClientOptions,
  path: string,
  init: RequestInit,
  retryOnAuthenticationFailure = false,
  retry = storageAuthenticationRetryContext(options, init, retryOnAuthenticationFailure),
  retriedAfterAuthenticationFailure = false,
): Promise<Result> {
  const headers = new Headers(options.headers);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  assertStorageAuthenticationCurrent(retry);
  headers.set("content-type", "application/json");
  if (!headers.has("authorization")) {
    const token = retry
      ? retry.retryToken
      : (options.sessionTokenSource ? options.sessionTokenSource.getSessionToken() : options.sessionToken)
        ?? options.apiKey;
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  if (retry?.kind === "cookie") headers.set(chikSessionScopeHeader, retry.scope);
  const signal = combinedStorageSignal(init.signal, retry?.signal);
  let response: globalThis.Response;
  try {
    response = await fetchImplementation(new URL(path, base), { ...init, headers, ...(signal ? { signal } : {}), ...(headers.has("authorization") ? { redirect: "error" } : {}) });
  } catch (error) {
    if (retry?.signal.aborted) throw storageAuthenticationChanged(error);
    throw new ChikStorageApiError(ChikErrorCode.unavailable, error instanceof Error ? error.message : "Storage could not be reached.", 503, { cause: error });
  }
  assertStorageAuthenticationCurrent(retry);
  if (!response.ok) {
    if (
      response.status === 401
      && retryOnAuthenticationFailure
      && !retriedAfterAuthenticationFailure
      && retry !== undefined
    ) {
      const token = await refreshStorageAuthentication(retry);
      if (token) {
        return storageJSON(
          fetchImplementation,
          base,
          options,
          path,
          init,
          true,
          retry,
          true,
        );
      }
    }
    const error = await storageError(response, "Storage request");
    assertStorageAuthenticationCurrent(retry);
    throw error;
  }
  if (response.status === 204) return undefined as Result;
  let result: Result;
  try {
    result = await response.json() as Result;
  } catch (error) {
    if (retry?.signal.aborted) throw storageAuthenticationChanged(error);
    throw new ChikStorageApiError(ChikErrorCode.invalidResponse, "Storage returned invalid JSON.", response.status);
  }
  assertStorageAuthenticationCurrent(retry);
  return result;
}

type StorageAuthenticationRetryContext = {
  readonly scope: string;
  readonly signal: AbortSignal;
  readonly source: ChikSessionTokenSource | ChikCookieSessionSource;
  readonly kind: "token" | "cookie";
  readonly retryEnabled: boolean;
  retryToken?: string | undefined;
};

function storageAuthenticationRetryContext(
  options: ChikStorageClientOptions,
  init: RequestInit,
  enabled: boolean,
): StorageAuthenticationRetryContext | undefined {
  if (
    new Headers(options.headers).has("authorization")
    || new Headers(init.headers).has("authorization")
  ) return undefined;
  const tokenSource = options.sessionTokenSource;
  if (tokenSource) {
    const token = tokenSource.getSessionToken();
    const scope = tokenSource.getSessionScope?.();
    const signal = tokenSource.getSessionScopeSignal?.();
    if (signal?.aborted) throw storageAuthenticationChanged();
    if (scope === undefined && signal === undefined) return undefined;
    if (!scope?.trim() || !signal) throw storageAuthenticationChanged();
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
  if (!cookieSource || options.sessionToken?.trim() || options.apiKey?.trim()) return undefined;
  const scope = cookieSource.getSessionScope();
  const signal = cookieSource.getSessionScopeSignal();
  if (signal?.aborted) throw storageAuthenticationChanged();
  if (scope === undefined && signal === undefined) return undefined;
  if (!scope?.trim() || !signal) throw storageAuthenticationChanged();
  return { kind: "cookie", source: cookieSource, scope, signal, retryEnabled: enabled };
}

async function refreshStorageAuthentication(retry: StorageAuthenticationRetryContext): Promise<string | undefined> {
  const refreshSession = retry.source.refreshSession;
  if (!retry.retryEnabled || !refreshSession || !storageAuthenticationRetryScopeIsCurrent(retry)) return undefined;
  const token = await refreshSession.call(retry.source, retry.scope);
  if (!storageAuthenticationRetryScopeIsCurrent(retry)) return undefined;
  if (retry.kind === "token") {
    const normalized = token?.trim();
    if (!normalized) return undefined;
    retry.retryToken = normalized;
  }
  return retry.scope;
}

function storageAuthenticationRetryScopeIsCurrent(retry: StorageAuthenticationRetryContext): boolean {
  return !retry.signal.aborted
    && retry.source.getSessionScope?.() === retry.scope
    && retry.source.getSessionScopeSignal?.() === retry.signal;
}

function assertStorageAuthenticationCurrent(authentication: StorageAuthenticationRetryContext | undefined): void {
  if (authentication && !storageAuthenticationRetryScopeIsCurrent(authentication)) throw storageAuthenticationChanged();
}

function storageAuthenticationChanged(cause?: unknown): ChikStorageApiError {
  return new ChikStorageApiError(
    ChikErrorCode.aborted,
    ChikErrorMessage.authenticationSessionChanged,
    409,
    cause === undefined ? {} : { cause },
  );
}

function combinedStorageSignal(
  caller: AbortSignal | null | undefined,
  authentication: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!caller) return authentication;
  if (!authentication) return caller;
  return AbortSignal.any([caller, authentication]);
}

async function storageError(response: Response, action: string): Promise<ChikStorageApiError> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as { code?: unknown; message?: unknown };
    const rawCode = typeof value.code === "string" && !isChikErrorCode(value.code) ? value.code : undefined;
    return new ChikStorageApiError(chikErrorCodeFromWire(value.code), typeof value.message === "string" ? value.message : `${action} failed with HTTP ${response.status}`, response.status, { rawCode });
  } catch { return new ChikStorageApiError(ChikErrorCode.unknown, `${action} failed with HTTP ${response.status}`, response.status); }
}

function storageOrigin(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ChikClientError(ChikErrorCode.invalidArgument, "baseUrl must be an absolute HTTP deployment origin.", 400); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) throw new ChikClientError(ChikErrorCode.invalidArgument, "baseUrl must be an absolute HTTP deployment origin.", 400);
  return url.origin;
}

function sameOriginUploadURL(origin: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password) throw new Error("different origin");
    return url.toString();
  } catch { throw new ChikStorageApiError(ChikErrorCode.invalidUploadUrl, "The upload URL is not valid for this application.", 502); }
}
