"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A copyable command.
 *
 * The one thing on this page that has to be impossible to miss is the copy
 * button, so it is a filled primary control on its own row rather than a link
 * tucked into the corner of the code panel — and it is a real `<button>`, so
 * Enter and Space work and the confirmation goes out through a live region
 * rather than only as a colour change.
 *
 * Colours are semantic tokens throughout: `on-solid` exists precisely for
 * text sitting on a status fill, and is near-black in dark mode and white in
 * light, which is the pair a hand-written `text-black` would get wrong.
 */
export function CommandBlock({
  command,
  label = "Copy command",
  prominent = false,
  describedBy,
}: {
  command: string;
  /** The one-liner in step 2. Everything else on the page is quieter than it. */
  prominent?: boolean;
  label?: string;
  describedBy?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A changed command means the confirmation on screen refers to text that is
  // no longer there — somebody who picks a second branch after copying must
  // not be told their clipboard is current.
  useEffect(() => setState("idle"), [command]);

  const copy = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
      timer.current = window.setTimeout(() => setState("idle"), 5000);
    } catch {
      // Clipboard access is refused outside a secure context and in some
      // locked-down browsers. Saying so beats a button that silently does
      // nothing; the command is selectable on screen either way.
      setState("failed");
    }
  }, [command]);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-ink sm:text-[13px]">
        <code>{command}</code>
      </pre>

      <div className="flex flex-col gap-2.5 border-t border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
        <button
          type="button"
          onClick={copy}
          aria-describedby={describedBy}
          className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold transition-colors ${
            prominent
              ? "w-full bg-healthy px-5 py-2.5 text-sm text-on-solid hover:bg-healthy-ink sm:w-auto"
              : "w-full border border-line-strong bg-surface-2 px-3.5 py-2 text-xs text-ink hover:bg-surface-3 sm:w-auto"
          }`}
        >
          {/*
            The icon flips with the label so the confirmation is not carried by
            colour alone. Both are hidden from assistive tech — the live region
            beside them is the announcement, and hearing it twice is worse than
            hearing it once.
          */}
          <span aria-hidden>{state === "copied" ? <CheckIcon /> : <ClipboardIcon />}</span>
          {state === "copied" ? "Copied" : label}
        </button>

        <p role="status" aria-live="polite" className="text-xs">
          {state === "copied" && (
            <span className="text-healthy-ink">
              Copied to clipboard. Paste it into Windows PowerShell.
            </span>
          )}
          {state === "failed" && (
            <span className="text-warning-ink">
              This browser blocked the clipboard — select the command above and copy it by hand.
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4.5" y="2.5" width="7" height="2.5" rx="0.75" />
      <path d="M11.5 3.75h1.25v9.75H3.25V3.75H4.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
