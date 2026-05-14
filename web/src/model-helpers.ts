import type { ModelOption } from "./api/client";

export type ManualModelPayload = {
  model: string | null;
  credentialId: string | null;
};

export type MemberModelMode = "agent-default" | "saved-credential" | "manual-provider-model";

export type ModelCredentialProfileSummary = {
  id: string;
  name: string;
  providerSlug: string;
};

export function uniqueModelProfiles(models: ModelOption[]): ModelCredentialProfileSummary[] {
  const seen = new Map<string, ModelCredentialProfileSummary>();
  for (const model of models) {
    if (!seen.has(model.profileId)) {
      seen.set(model.profileId, {
        id: model.profileId,
        name: model.profileName,
        providerSlug: model.providerSlug,
      });
    }
  }
  return Array.from(seen.values());
}

export function composeManualModelPayload(rawModel: unknown, credentialId: string | null | undefined, models: ModelOption[]): ManualModelPayload {
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  const selectedCredential = credentialId || null;
  if (!model) return { model: null, credentialId: null };

  const profiles = uniqueModelProfiles(models);
  const profile = selectedCredential ? profiles.find((p) => p.id === selectedCredential) : undefined;

  if (profile) {
    const firstSegment = model.split("/")[0];
    const hasProviderPrefix = model.includes("/");
    if (!hasProviderPrefix) {
      return { model: `${profile.providerSlug}/${model}`, credentialId: profile.id };
    }
    if (firstSegment === profile.providerSlug) {
      return { model, credentialId: profile.id };
    }
    throw new Error(`Manual model provider ${firstSegment} does not match credential provider ${profile.providerSlug}`);
  }

  if (!model.includes("/")) throw new Error("Manual model without a credential profile must use provider/model format.");
  return { model, credentialId: null };
}

export function shouldUseManualModelInput(model: string | null | undefined, credentialId: string | null | undefined, models: ModelOption[]): boolean {
  if (!model) return false;
  if (!models.length) return true;
  if (credentialId) {
    return !models.some((m) => m.profileId === credentialId && m.ref === model);
  }
  return true;
}

export function inferMemberModelMode(
  model: string | null | undefined,
  credentialId: string | null | undefined,
  models: ModelOption[] = [],
): MemberModelMode {
  if (!model) return "agent-default";
  if (!credentialId) return "manual-provider-model";
  if (!models.length) return "manual-provider-model";
  const match = models.some((m) => m.profileId === credentialId && m.ref === model);
  return match ? "saved-credential" : "manual-provider-model";
}

export function getMemberModelBadge(
  model: string | null | undefined,
  credentialId: string | null | undefined,
  models: ModelOption[] = [],
): "Agent default" | "Saved credential" | "Manual model" {
  if (!model) return "Agent default";
  if (!credentialId) return "Manual model";
  if (!models.length) return "Manual model";
  const match = models.some((m) => m.profileId === credentialId && m.ref === model);
  return match ? "Saved credential" : "Manual model";
}
