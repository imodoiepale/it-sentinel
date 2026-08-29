"use client";

import type { Branch } from "./branches";

/**
 * Native radios rather than `role="radio"` on buttons.
 *
 * A hand-rolled radiogroup has to reimplement roving tabindex and arrow keys
 * to behave the way a screen-reader user expects, and the previous version of
 * this page did not — it left seven tab stops and no arrow navigation. Real
 * inputs get all of that from the platform, including the browser's own
 * "3 of 7" announcement. The input is `sr-only`; the label carries the visuals
 * and `has-[:focus-visible]` lifts the focus ring onto it.
 */
export function BranchPicker({
  branches,
  selected,
  onSelect,
}: {
  branches: Branch[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  return (
    <fieldset>
      <legend className="sr-only">Branch this laptop belongs to</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {branches.map((branch) => {
          const isSelected = branch.slug === selected;
          return (
            <label
              key={branch.slug}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                isSelected
                  ? "border-healthy-ink bg-healthy/10"
                  : "border-line bg-surface hover:bg-surface-2"
              }`}
            >
              <input
                type="radio"
                name="branch"
                value={branch.slug}
                checked={isSelected}
                onChange={() => onSelect(branch.slug)}
                className="sr-only"
              />
              {/*
                A drawn mark, not a colour change. Selection has to survive a
                monochrome screen and a colour-blind reader, which the tinted
                border alone would not.
              */}
              <span
                aria-hidden
                className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] leading-none ${
                  isSelected
                    ? "border-healthy-ink text-healthy-ink"
                    : "border-line-strong text-transparent"
                }`}
              >
                ✓
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{branch.name}</span>
                <span className="mt-0.5 block truncate font-mono text-xs text-muted">
                  {branch.slug}
                  {branch.region ? ` · ${branch.region}` : ""}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
