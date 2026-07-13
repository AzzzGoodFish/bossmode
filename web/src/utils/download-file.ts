export function downloadFilename(input: string | undefined | null, fallback = "download"): string {
  const raw = (input || "").split(/[?#]/)[0].split(/[\\/]/).pop() || fallback;
  const safe = raw.replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_").trim();
  return safe || fallback;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadFilename(filename);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function triggerTextDownload(content: string, filename: string, type = "text/plain;charset=utf-8"): void {
  triggerBlobDownload(new Blob([content], { type }), filename);
}
