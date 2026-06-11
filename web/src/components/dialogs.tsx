/**
 * Shared dialog system — replaces all browser native prompt/confirm/alert.
 *
 * Usage:
 *   1. Wrap app with <DialogProvider>
 *   2. const { toast, confirm, prompt } = useDialog();
 *   3. toast("Saved!") / toast("Error", "error")
 *   4. if (await confirm("Delete?")) { ... }
 *   5. const name = await prompt("New name:");
 */
import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { AlertCircle, CheckCircle, Info, X } from "lucide-react";
import { Sheet } from "./Sheet";

// ── Types ──

type ToastType = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ConfirmState {
  message: string;
  resolve: (ok: boolean) => void;
}

interface PromptState {
  message: string;
  defaultValue: string;
  resolve: (value: string | null) => void;
}

interface DialogContextValue {
  toast: (message: string, type?: ToastType) => void;
  confirm: (message: string) => Promise<boolean>;
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within <DialogProvider>");
  return ctx;
}

// ── Provider ──

let nextToastId = 0;

export function DialogProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++nextToastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);

  const confirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({ message, resolve });
    });
  }, []);

  const prompt = useCallback((message: string, defaultValue = ""): Promise<string | null> => {
    return new Promise((resolve) => {
      setPromptState({ message, defaultValue, resolve });
    });
  }, []);

  const handleConfirm = (ok: boolean) => {
    confirmState?.resolve(ok);
    setConfirmState(null);
  };

  const handlePrompt = (value: string | null) => {
    promptState?.resolve(value);
    setPromptState(null);
  };

  return (
    <DialogContext.Provider value={{ toast, confirm, prompt }}>
      {children}

      {/* Toast stack */}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} />
        ))}
      </div>

      {/* Confirm dialog */}
      {confirmState && (
        <Sheet open={!!confirmState} onClose={() => handleConfirm(false)} size="sm">
          <div className="p-5">
            <p className="text-sm text-ink-1 mb-5 whitespace-pre-wrap">{confirmState.message}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => handleConfirm(false)}
                className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer transition-colors">
                Cancel
              </button>
              <button onClick={() => handleConfirm(true)} autoFocus
                className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 text-sm font-medium rounded-lg cursor-pointer transition-colors">
                Confirm
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {/* Prompt dialog */}
      {promptState && <PromptDialog state={promptState} onClose={handlePrompt} />}
    </DialogContext.Provider>
  );
}

// ── Toast component ──

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = item.type === "error" ? AlertCircle : item.type === "success" ? CheckCircle : Info;
  const colors = item.type === "error"
    ? "border-blocked/30 bg-blocked-dim text-blocked"
    : item.type === "success"
    ? "border-onair/30 bg-onair-dim text-onair"
    : "border-line-strong bg-surface-1/90 text-ink-1";

  return (
    <div className={`pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-lg border shadow-lg text-sm backdrop-blur-sm animate-slide-in ${colors}`}>
      <Icon size={14} className="shrink-0" />
      <span className="flex-1">{item.message}</span>
      <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100 cursor-pointer transition-opacity">
        <X size={12} />
      </button>
    </div>
  );
}

// ── Prompt dialog component ──

function PromptDialog({ state, onClose }: { state: PromptState; onClose: (value: string | null) => void }) {
  const [value, setValue] = useState(state.defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus + select on mount
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);

  const handleSubmit = () => {
    if (value.trim()) onClose(value.trim());
  };

  return (
    <Sheet open onClose={() => onClose(null)} size="sm" closeOnOverlayClick={false}>
      <div className="p-5">
        <p className="text-sm text-ink-1 mb-3">{state.message}</p>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onClose(null); }}
          className="w-full bg-inset border border-line rounded px-3 py-2 text-base md:text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={() => onClose(null)}
            className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer transition-colors">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!value.trim()}
            className="px-4 py-2 bg-accent hover:opacity-90 disabled:opacity-40 text-accent-contrast text-sm font-semibold rounded-lg cursor-pointer transition-opacity">
            OK
          </button>
        </div>
      </div>
    </Sheet>
  );
}
