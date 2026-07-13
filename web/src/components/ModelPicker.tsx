import type { AvailableModelOption, ModelOption } from "../api/client";

type PickerModel = AvailableModelOption | ModelOption;

export interface ModelPickerValue {
  model: string | null;
  credentialId: string | null;
}

function formatTokens(value?: number): string {
  if (!value) return "?";
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}

function optionValue(model: PickerModel): string {
  return `${model.profileId}::${model.ref}`;
}

export function modelProfileLabel(model: Pick<PickerModel, "profileName" | "providerSlug" | "profileBaseUrl">): string {
  const endpoint = model.profileBaseUrl || "official default";
  return `${model.profileName || model.providerSlug} · ${model.providerSlug} · ${endpoint}`;
}

function isAvailableModel(model: PickerModel): model is AvailableModelOption {
  return "images" in model;
}

function optionLabel(model: PickerModel): string {
  const name = model.displayName || model.modelId;
  const caps = `${formatTokens(model.contextWindow)} / ${formatTokens(model.maxTokens)}`;
  const flags = [model.reasoning ? "thinking" : null, isAvailableModel(model) && model.images ? "images" : null].filter(Boolean).join(", ");
  return `${name}   ${caps}${flags ? `   ${flags}` : ""}`;
}

export function ModelPicker({ value, models, onChange, disabled }: {
  value: ModelPickerValue;
  models: PickerModel[];
  onChange: (value: ModelPickerValue) => void;
  disabled?: boolean;
}) {
  const matched = value.model
    ? models.find((m) => (value.credentialId ? m.profileId === value.credentialId && m.ref === value.model : m.ref === value.model))
    : undefined;
  const selectedValue = value.model ? (matched ? optionValue(matched) : `legacy::${value.model}`) : "";
  const grouped = models.reduce<Record<string, PickerModel[]>>((acc, model) => {
    const key = modelProfileLabel(model);
    (acc[key] ||= []).push(model);
    return acc;
  }, {});

  return (
    <div className="space-y-1.5">
      <select
        value={selectedValue}
        disabled={disabled}
        onChange={(e) => {
          const selected = e.target.value;
          if (!selected) { onChange({ model: null, credentialId: null }); return; }
          if (selected.startsWith("legacy::")) { onChange(value); return; }
          const [profileId, ...refParts] = selected.split("::");
          onChange({ credentialId: profileId, model: refParts.join("::") });
        }}
        className="w-full bg-surface-3 border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
      >
        <option value="">Follow agent default</option>
        {value.model && !matched && <option value={`legacy::${value.model}`}>{value.model} · unavailable</option>}
        {Object.entries(grouped).map(([group, items]) => (
          <optgroup key={group} label={group}>
            {items.map((model) => <option key={optionValue(model)} value={optionValue(model)}>{optionLabel(model)}</option>)}
          </optgroup>
        ))}
        {models.length === 0 && <option disabled value="__none">No models available</option>}
      </select>
      {models.length === 0 && <p className="text-xs text-think">Connect a model provider before this member can work. Go to Settings → Models.</p>}
      {models.length > 0 && value.model && !matched && <p className="text-xs text-think">This model is not available from your connected providers. Choose another model or connect its provider in Settings → Models.</p>}
    </div>
  );
}
