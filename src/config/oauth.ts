import { type ModelCredentialProfileInput, type OAuthDeviceCodeInfo, type OAuthSelectPrompt, type OAuthLoginAdapter, validateOAuthProvider, loadModelCredentialProfiles, getModelCredentialProfile, nextBuiltinProfileName, now, saveModelCredentialProfile, validateInput, credentialRevision } from "./models.js";
export interface OAuthLoginJobPublic {id:string;status:"starting"|"awaiting_input"|"awaiting_device"|"completed"|"failed"|"cancelled";providerId:string;authUrl?:string;userCode?:string;deviceCode?:OAuthDeviceCodeInfo;selectPrompt?:OAuthSelectPrompt;prompt:string;error?:string;profileId?:string;createdAt:number;updatedAt:number;}
export interface StartOAuthConnectionRequest {providerId:string;profileId?:string;name?:string;requestProfile?:"standard";}
import { PiAiOAuthLoginAdapter } from "./pi-adapt/credentials.js";
import { modelsForBuiltinProvider, protocolForBuiltinProvider, baseUrlForBuiltinProvider, getBuiltinProvider } from "./catalog.js";
import { getDatabase } from "../data/database.js";
import { logger } from "../kernel/logger.js";
import { randomUUID } from "node:crypto";
type OAuthInputWaiter = { resolve: (value: string) => void; reject: (error: Error) => void };
type OAuthLoginJob = OAuthLoginJobPublic & {
  profileInput: ModelCredentialProfileInput & { id?: string };
  profileRevision: number | null;
  inputWaiter?: OAuthInputWaiter;
  abortController: AbortController;
  ready: Promise<void>;
  resolveReady: () => void;
};
const oauthJobs = new Map<string, OAuthLoginJob>();
let oauthLoginAdapter: OAuthLoginAdapter | null = null;
function sanitizeOAuthJob(job: OAuthLoginJob): OAuthLoginJobPublic {
  return {
    id: job.id,
    status: job.status,
    providerId: job.providerId,
    authUrl: job.authUrl,
    userCode: job.userCode,
    deviceCode: job.deviceCode,
    selectPrompt: job.selectPrompt,
    prompt: job.prompt,
    error: job.error,
    profileId: job.profileId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function waitForOAuthInput(job: OAuthLoginJob): Promise<string> {
  if (job.status === "cancelled") return Promise.reject(new Error("OAuth login job was cancelled"));
  return new Promise<string>((resolve, reject) => { job.inputWaiter = { resolve, reject }; });
}
function getOAuthLoginAdapter(): OAuthLoginAdapter {
  if (!oauthLoginAdapter) oauthLoginAdapter = new PiAiOAuthLoginAdapter();
  return oauthLoginAdapter;
}
function mapOAuthError(err: unknown): string {
  const message = String((err as any)?.message || err || "OAuth login failed");
  if (message.includes("Failed to extract accountId from token") || message.toLowerCase().includes("invalid_grant") || message.toLowerCase().includes("refresh")) {
    return "OAuth credential is invalid or expired. 请在 Settings 重新连接。";
  }
  return message;
}
function parseDeviceCodeFromAuth(info: { url: string; instructions?: string }): OAuthDeviceCodeInfo | undefined {
  const instructions = info.instructions || "";
  const codeMatch = instructions.match(/(?:enter code|code)[:：]?\s*([A-Z0-9-]{4,})/i);
  if (!codeMatch) return undefined;
  return { userCode: codeMatch[1], verificationUri: info.url };
}
function buildNativeOAuthProfileInput(input: StartOAuthConnectionRequest): { providerId: string; profileInput: ModelCredentialProfileInput & { id?: string }; profileId?: string } {
  const providerId = validateOAuthProvider(input.providerId);
  const provider = getBuiltinProvider(providerId);
  if (!provider) throw new Error(`Unsupported built-in provider: ${providerId}`);
  if (!provider.authModes.includes("oauth")) throw new Error(`Provider ${providerId} does not support OAuth`);

  const existingById = input.profileId ? getModelCredentialProfile(input.profileId) : null;
  if (input.profileId && !existingById) throw new Error("profile not found");
  if (existingById && existingById.providerSlug !== providerId) throw new Error("profile provider does not match OAuth provider");
  const hasExistingSameProviderProfile = loadModelCredentialProfiles().some((p) => p.providerSlug === providerId && (p.profileKind ?? "custom_endpoint") === "builtin_provider");
  const existing = existingById ?? null;

  return {
    providerId,
    profileId: existing?.id,
    profileInput: {
      id: existing?.id,
      profileKind: "builtin_provider",
      name: input.name?.trim() || existing?.name || nextBuiltinProfileName(providerId, provider.displayName),
      providerSlug: providerId,
      protocol: protocolForBuiltinProvider(providerId),
      baseUrl: baseUrlForBuiltinProvider(providerId),
      authType: "oauth",
      oauthProviderId: providerId,
      requestProfile: "standard",
      enabled: existing?.enabled ?? true,
      isDefault: existing?.isDefault ?? !hasExistingSameProviderProfile,
      models: modelsForBuiltinProvider(providerId),
    },
  };
}

function transition(job: OAuthLoginJob, state: Partial<OAuthLoginJobPublic>, ready = true): void {
  Object.assign(job, state, { updatedAt: now() });
  if (ready) job.resolveReady();
}

function ask(job: OAuthLoginJob, prompt: string, selectPrompt?: OAuthLoginJobPublic["selectPrompt"]): Promise<string> {
  transition(job, { status: "awaiting_input", selectPrompt, prompt });
  return waitForOAuthInput(job);
}

function startOAuthLogin(job: OAuthLoginJob): void {
  void getOAuthLoginAdapter().login(job.providerId, {
    signal: job.abortController.signal,
    onAuth: info => {
      const deviceCode = parseDeviceCodeFromAuth(info);
      transition(job, {
        authUrl: info.url, selectPrompt: undefined,
        ...(deviceCode ? { status: "awaiting_device", deviceCode, userCode: deviceCode.userCode } : { status: "awaiting_input" }),
        prompt: info.instructions || "Complete login in the opened provider page, then paste the returned code if requested.",
      });
    },
    onPrompt: prompt => ask(job, prompt.message),
    onManualCodeInput: () => ask(job, "Paste the authorization code or full redirect URL."),
    onDeviceCode: deviceCode => transition(job, {
      status: "awaiting_device", selectPrompt: undefined, deviceCode, userCode: deviceCode.userCode,
      authUrl: deviceCode.verificationUri,
      prompt: "Open " + deviceCode.verificationUri + " and enter code " + deviceCode.userCode + ".",
    }),
    onSelect: prompt => ask(job, prompt.message + " (" + prompt.options.map(o => o.label).join(", ") + ")", prompt),
    onProgress: prompt => transition(job, { prompt }, false),
  }).then(credentials => {
    if (job.status === "cancelled") return;
    const saved = getDatabase().transaction(() => {
      if (job.profileId && credentialRevision(job.profileId, getDatabase()) !== job.profileRevision) {
        throw new Error("Model credential profile changed or was deleted during OAuth login. Start login again.");
      }
      return saveModelCredentialProfile({
        ...job.profileInput, id: job.profileId, authType: "oauth", oauthProviderId: job.providerId,
        oauthCredentials: credentials, apiKey: undefined,
      });
    });
    transition(job, { status: "completed", profileId: saved.id, authUrl: undefined, userCode: undefined,
      selectPrompt: undefined, prompt: "OAuth connected.", error: undefined });
  }).catch(error => {
    if (job.status === "cancelled") return;
    transition(job, { status: "failed", error: mapOAuthError(error), selectPrompt: undefined,
      prompt: "OAuth login failed. Retry from Start login." });
    logger.warn("model-credentials", "oauth login job failed", { job: job.id, provider: job.providerId, error: job.error });
  });
}


function createOAuthLoginJob(providerId: string, profileInput: ModelCredentialProfileInput & { id?: string }, profileId?: string): OAuthLoginJob {
  const profileRevision = profileId ? credentialRevision(profileId, getDatabase()) : null;
  if (profileId && profileRevision === null) throw new Error("profile not found");
  const nowTs = now();
  const ready = createDeferred();
  const job: OAuthLoginJob = {
    id: randomUUID().slice(0, 8),
    status: "starting",
    providerId,
    prompt: "Starting provider OAuth login...",
    profileId,
    createdAt: nowTs,
    updatedAt: nowTs,
    profileInput,
    profileRevision,
    abortController: new AbortController(),
    ready: ready.promise,
    resolveReady: ready.resolve,
  };
  oauthJobs.set(job.id, job);
  return job;
}

export async function startNativeOAuthConnection(input: StartOAuthConnectionRequest): Promise<OAuthLoginJobPublic> {
  const raw = input as StartOAuthConnectionRequest & Record<string, unknown>;
  for (const forbidden of ["profile", "baseUrl", "protocol", "models", "authType"] as const) {
    if (raw[forbidden] !== undefined) throw new Error(`OAuth connection accepts only providerId, profileId, name, and requestProfile; unexpected ${forbidden}`);
  }
  const job = getDatabase().transaction(() => {
    const { providerId, profileInput, profileId } = buildNativeOAuthProfileInput(input);
    validateInput(profileInput, profileId ? getModelCredentialProfile(profileId) || undefined : undefined, { allowIncompleteOAuth: true });
    return createOAuthLoginJob(providerId, profileInput, profileId);
  });
  return launch(job);
}

export function getOAuthLoginJob(id: string): OAuthLoginJobPublic | null {
  const job = oauthJobs.get(id);
  return job ? sanitizeOAuthJob(job) : null;
}

export function cancelOAuthLoginJob(id: string): OAuthLoginJobPublic | null {
  const job = oauthJobs.get(id);
  if (!job) return null;
  if (job.status !== "completed") {
    job.status = "cancelled";
    job.abortController.abort();
    job.inputWaiter?.reject(new Error("OAuth login job was cancelled"));
  }
  job.updatedAt = now();
  return sanitizeOAuthJob(job);
}

export function validateOAuthSubmitInput(job: { authUrl?: string }, raw: string): void {
  const text = String(raw || "").trim();
  if (!text) return; // blank-input prompts (select options etc.) pass through
  if (!job.authUrl) return; // no reference state to check against

  let query = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const qIdx = text.indexOf("?");
    if (qIdx >= 0) query = text.slice(qIdx + 1);
  } else if (/^[?#]/.test(text)) {
    query = text.slice(1);
  } else if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text)) {
    query = text;
  } else {
    return; // bare code (or code#state) — pi parses it; nothing to check here
  }
  if (!query) {
    throw new Error("No authorization code found in the pasted URL. Paste the bare code, or the full redirect URL (the localhost:... address after signing in).");
  }
  const params = new URLSearchParams(query.replace(/^[^?#]*[#?]/, ""));
  const code = params.get("code");
  if (!code) {
    throw new Error("No authorization code found in the pasted input. Paste the bare code, or the full redirect URL (the localhost:... address after signing in).");
  }
  const submittedState = params.get("state");
  if (submittedState) {
    let expectedState: string | null = null;
    try {
      const authQuery = job.authUrl.slice(job.authUrl.indexOf("?") + 1);
      expectedState = new URLSearchParams(authQuery).get("state");
    } catch { /* unparseable authUrl — skip the pre-check */ }
    if (expectedState && submittedState !== expectedState) {
      throw new Error(
        "This redirect URL is from a DIFFERENT login attempt (state mismatch). Click \"Open login page\" for THIS login, sign in, and paste the localhost:... URL the browser lands on.",
      );
    }
  }
}

export async function submitOAuthLoginJobInput(id: string, input: { code?: string }): Promise<OAuthLoginJobPublic | null> {
  const job = oauthJobs.get(id);
  if (!job) return null;
  if (job.status === "cancelled") throw new Error("OAuth login job was cancelled");
  if (job.status === "completed") return sanitizeOAuthJob(job);
  if (job.status === "failed") throw new Error(job.error || "OAuth login job failed");
  if (input.code === undefined || (!job.prompt.includes("blank") && !input.code.trim())) throw new Error("OAuth input is required");
  validateOAuthSubmitInput(job, input.code);
  const waiter = job.inputWaiter;
  if (!waiter) throw new Error("OAuth login job is not waiting for input");
  job.inputWaiter = undefined;
  // Acknowledge input without waiting for token exchange; GET owns progress.
  job.status = "starting";
  job.selectPrompt = undefined;
  job.prompt = "Input submitted. Waiting for the provider...";
  job.updatedAt = now();
  waiter.resolve(input.code);
  return sanitizeOAuthJob(job);
}

async function launch(job: OAuthLoginJob): Promise<OAuthLoginJobPublic> {
  startOAuthLogin(job);
  await Promise.race([job.ready, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
  return sanitizeOAuthJob(job);
}
