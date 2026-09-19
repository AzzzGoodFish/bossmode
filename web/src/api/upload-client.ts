// XHR-based upload with progress + cancel support
// (fetch API doesn't support upload progress events)

export interface UploadResult {
  filename: string;
  originalFilename: string;
  /** Stored filename, kept as `path` for legacy caller compatibility. Never an absolute path. */
  path: string;
  size: number;
  url: string;
  previewType?: "image" | "markdown" | "html" | "download";
}

export interface UploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export class UploadError extends Error {
  status: number;
  isAbort: boolean;
  constructor(message: string, status = 0, isAbort = false) {
    super(message);
    this.status = status;
    this.isAbort = isAbort;
  }
}

const TOKEN_KEY = "bossmode_token";

export function uploadWithProgress(
  scope: string,
  file: File,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const sourceRef = /^(room|dm|mm):/.test(scope) ? scope : `room:${scope}`;
    const url = `/api/conversations/${encodeURIComponent(sourceRef)}/attachments?filename=${encodeURIComponent(file.name)}`;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      try {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          const errMsg = JSON.parse(xhr.responseText)?.error || `HTTP ${xhr.status}`;
          reject(new UploadError(errMsg, xhr.status));
        }
      } catch {
        reject(new UploadError("Invalid response", xhr.status));
      }
    };
    xhr.onerror = () => reject(new UploadError("Network error"));
    xhr.onabort = () => reject(new UploadError("Aborted", 0, true));

    if (opts.signal) {
      if (opts.signal.aborted) { reject(new UploadError("Aborted", 0, true)); return; }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.open("POST", url);
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.send(file);
  });
}
