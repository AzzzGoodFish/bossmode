export type LibraryFileFormat = "md" | "html" | "png" | "json" | "txt" | "file";

export interface LibraryFileFormatInfo {
  kind: LibraryFileFormat;
  label: string;
  description: string;
}

export function getLibraryFileFormat(path: string): LibraryFileFormatInfo {
  const lower = path.toLowerCase();
  if (/\.markdown$|\.md$/.test(lower)) return { kind: "md", label: "MD", description: "Markdown" };
  if (/\.html?$/.test(lower)) return { kind: "html", label: "HTML", description: "HTML" };
  if (/\.png$/.test(lower)) return { kind: "png", label: "PNG", description: "PNG image" };
  if (/\.json$/.test(lower)) return { kind: "json", label: "JSON", description: "JSON" };
  if (/\.txt$/.test(lower)) return { kind: "txt", label: "TXT", description: "Text" };
  return { kind: "file", label: "FILE", description: "File" };
}
