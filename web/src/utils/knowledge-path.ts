export interface NormalizedKnowledgeRef {
  originalPath: string;
  path: string;
  changed: boolean;
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function normalizeKnowledgeMarkdownRef(ref: string): NormalizedKnowledgeRef {
  const originalPath = ref;
  const trimmed = ref.trim();
  if (!trimmed || URL_SCHEME_RE.test(trimmed) || trimmed.startsWith("/") || !/\.md$/i.test(trimmed)) {
    return { originalPath, path: trimmed, changed: trimmed !== originalPath };
  }
  const path = trimmed.replace(/^docs\//, "");
  return { originalPath, path, changed: path !== originalPath };
}
