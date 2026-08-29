"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../lib/useAuth";

/**
 * Self-service enrollment.
 *
 * The job of this page is narrow: get a teammate from "I have a laptop" to
 * "my laptop is in the fleet" with one branch choice and one paste. Anything
 * that is not a branch, a command, or an honest account of what the command
 * does has been left off it.
 *
 * Behind operator login, like every other screen. That is not because the
 * scripts are secret — the control plane serves them to anyone, deliberately,
 * since a machine with nothing on it cannot present a credential — but
 * because knowing which branch slugs exist and which hub to point at is
 * exactly the reconnaissance an attacker would need to push an unwanted
 * machine into the fleet. See docs/19-enrollment.md for where that gap
 * actually lives (POST /v1/heartbeat) and what closing it looks like.
 */

const CONTROL_PLANE =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? "https://it-sentinel-control-plane.onrender.com";

interface Branch {
  slug: string;
  name: string;
  region: string | null;
  criticality: string | null;
}

/**
 * Shown before the branch list arrives, and kept if it never does. The list
 * is a constant in the control plane too (it has to match the installer's
 * hardcoded slugs), so a slow cold start on a free dyno should not leave
 * somebody staring at an empty page.
 */
const FALLBACK_BRANCHES: Branch[] = [
  { slug: "nairobi-hq", name: "Nairobi HQ", region: "Africa", criticality: "critical" },
  { slug: "lagos", name: "Lagos", region: "Africa", criticality: "standard" },
  { slug: "dubai", name: "Dubai", region: "Middle East", criticality: "standard" },
  { slug: "london", name: "London", region: "Europe", criticality: "standard" },
  { slug: "singapore", name: "Singapore", region: "APAC", criticality: "standard" },
  { slug: "sao-paulo", name: "Sao Paulo", region: "LATAM", criticality: "standard" },
  { slug: "new-york", name: "New York", region: "Americas", criticality: "critical" },
];

const DOWNLOADS = [
  {
    file: "preflight.ps1",
    title: "Preflight check",
    blurb: "Run first if you want to see what the installer will find. Changes nothing.",
  },
  {
    file: "install-sentinel-agent.ps1",
    title: "Installer",
    blurb: "What the command below ends up running. Shows a full disclosure and waits for you to type INSTALL.",
  },
  {
    file: "uninstall-sentinel-agent.ps1",
    title: "Uninstaller",
    blurb: "Removes the agent, the scheduled task, the firewall rule and TightVNC. Run it any time.",
  },
  {
    file: "bootstrap.ps1",
    title: "Bootstrap",
    blurb: "The script the one-liner fetches. Downloads the code, then hands over to the installer.",
  },
];

/**
 * Whether this control plane can actually hand out each launcher, from
 * `GET /v1/enroll`.
 *
 * Asked rather than assumed because `SentinelSetup.exe` is compiled by
 * csc.exe on Windows and is deliberately not committed, so the hosted
 * deployment — which builds on Linux — usually does not have one. Rendering
 * a download button that 503s is worse than rendering no button, and worse
 * still on the one day somebody is standing at a strange laptop.
 */
interface Installer {
  file: string;
  url: string;
  description: string;
  available: boolean;
}

export default function EnrollPage() {
  const router = useRouter();
  const { session, loading: authLoading } = useAuth();

  const [branches, setBranches] = useState<Branch[]>(FALLBACK_BRANCHES);
  const [installers, setInstallers] = useState<Installer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!authLoading && !session) router.push("/login");
  }, [authLoading, session, router]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    fetch(`${CONTROL_PLANE}/v1/enroll/branches`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body?.branches?.length) return;
        setBranches(body.branches);
      })
      .catch(() => {
        // Deliberately silent: FALLBACK_BRANCHES is already on screen and is
        // the same list, so an error banner here would report a problem the
        // person reading it does not have.
      });

    fetch(`${CONTROL_PLANE}/v1/enroll`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !Array.isArray(body?.installers)) return;
        setInstallers(body.installers);
      })
      .catch(() => {
        // Silent, like the branch fetch above and for the same reason: the
        // section this feeds simply does not render, and the PowerShell
        // command — which is the path that always works — is already on
        // screen. An error banner would report a problem the reader does
        // not have.
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  const cmdInstaller = installers.find((i) => i.file === "SentinelSetup.cmd" && i.available);
  const exeInstaller = installers.find((i) => i.file === "SentinelSetup.exe" && i.available);

  /**
   * The scriptblock form rather than plain `irm | iex`, because `iex` on a
   * piped string has no way to pass arguments — and the whole point of this
   * page is that the branch and the hub are already filled in.
   */
  const command = useMemo(() => {
    const base = `& ([scriptblock]::Create((irm ${CONTROL_PLANE}/v1/enroll/bootstrap.ps1)))`;
    if (!selected) return `${base} -ControlPlaneUrl ${CONTROL_PLANE}`;
    return `${base} -BranchSlug ${selected} -ControlPlaneUrl ${CONTROL_PLANE}`;
  }, [selected]);

  const copy = useCallback(async () => {
    setCopied(false);
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      // Clipboard access is refused outside a secure context and in some
      // locked-down browsers. Saying so beats a button that silently does
      // nothing; the command is selectable on screen either way.
      setCopyFailed(true);
    }
  }, [command]);

  if (authLoading || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0b0f14] text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0f14]">
      <header className="p-4 border-b border-white/10 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-400">Sentinel Global</div>
          <h1 className="text-lg font-semibold">Enroll a machine</h1>
        </div>
        <a href="/console" className="text-xs text-gray-500 hover:text-white">
          Back to Command Center
        </a>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-10">
        {/* ------------------------------------------------ 1. branch --- */}
        <section aria-labelledby="step-branch">
          <h2 id="step-branch" className="text-sm font-semibold mb-1">
            <span className="text-gray-500 mr-2">1.</span>Which branch is this laptop?
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            This is the branch the machine reports into. Pick the wrong one and it shows up in
            somebody else&apos;s fleet — re-run the installer to change it.
          </p>

          <div role="radiogroup" aria-label="Branch" className="grid gap-2 sm:grid-cols-2">
            {branches.map((branch) => {
              const isSelected = branch.slug === selected;
              return (
                <button
                  key={branch.slug}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setSelected(branch.slug)}
                  className={`flex items-start gap-3 text-left px-3 py-2.5 rounded border text-sm transition-colors ${
                    isSelected
                      ? "border-healthy-ink bg-healthy/10"
                      : "border-white/10 bg-white/5 hover:bg-white/10"
                  }`}
                >
                  {/*
                    A drawn mark, not a colour change. Selection has to survive
                    a monochrome screen and a colour-blind reader, which the
                    tinted border alone would not — same rule StatusDot.tsx
                    follows for status.
                  */}
                  <span
                    aria-hidden
                    className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border grid place-items-center text-[10px] leading-none ${
                      isSelected ? "border-healthy-ink text-healthy-ink" : "border-white/25 text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span>
                    <span className="block">
                      {branch.name}
                      {isSelected && <span className="sr-only"> (selected)</span>}
                    </span>
                    <span className="block text-xs text-gray-500 font-mono">
                      {branch.slug}
                      {branch.region ? ` · ${branch.region}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ----------------------------------------------- 2. command --- */}
        <section aria-labelledby="step-command">
          <h2 id="step-command" className="text-sm font-semibold mb-1">
            <span className="text-gray-500 mr-2">2.</span>Run this in Windows PowerShell
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            {selected ? (
              <>
                Open PowerShell on the laptop (no need to Run as administrator — it asks when it
                needs to) and paste this. It is filled in for{" "}
                <span className="text-gray-300 font-mono">{selected}</span>.
              </>
            ) : (
              <>
                Pick a branch above to have it filled in, or paste this as-is and the installer
                will show you a numbered menu.
              </>
            )}
          </p>

          <div className="rounded border border-white/10 bg-black/40">
            <pre className="p-3 text-xs font-mono text-gray-200 overflow-x-auto whitespace-pre-wrap break-all">
              {command}
            </pre>
            <div className="flex items-center gap-3 px-3 py-2 border-t border-white/10">
              <button
                type="button"
                onClick={copy}
                className="px-3 py-1.5 rounded bg-healthy/90 hover:bg-healthy text-black text-xs font-medium"
              >
                Copy command
              </button>
              {/*
                aria-live so a screen-reader user is told the copy happened.
                The visible confirmation is a word, not a colour change.
              */}
              <span aria-live="polite" className="text-xs">
                {copied && <span className="text-healthy-ink">Copied to clipboard</span>}
                {copyFailed && (
                  <span className="text-warning">
                    This browser blocked the clipboard — select the command above and copy it.
                  </span>
                )}
              </span>
            </div>
          </div>

          <p className="text-xs text-gray-500 mt-3">
            Takes about ten minutes on a fresh laptop, most of it downloads. It asks for
            administrator once, and will not change anything until you type{" "}
            <span className="font-mono text-gray-300">INSTALL</span>. When it finishes, the machine
            appears in the Command Center within a minute.
          </p>
        </section>

        {/* ---------------------------------------- 3. or double-click --- */}
        {/*
          Only rendered when the control plane says it has something to give.
          See the Installer interface for why that is asked rather than
          assumed.
        */}
        {(cmdInstaller || exeInstaller) && (
          <section aria-labelledby="step-download">
            <h2 id="step-download" className="text-sm font-semibold mb-1">
              <span className="text-gray-500 mr-2">3.</span>Or download a launcher and double-click
              it
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              Same thing as the command above, for anybody who would rather not paste into
              PowerShell. Both of these download <span className="font-mono">bootstrap.ps1</span>{" "}
              from this hub and run it — they make no decisions of their own, and the installer
              still waits for you to type <span className="font-mono text-gray-300">INSTALL</span>.
              {selected ? null : " Pick a branch above first, or the launcher will ask you."}
            </p>

            <ul className="grid gap-2">
              {cmdInstaller && (
                <li>
                  <a
                    href={cmdInstaller.url}
                    className="flex items-baseline justify-between gap-4 px-3 py-2.5 rounded border border-healthy-ink/40 bg-healthy/10 hover:bg-healthy/20"
                  >
                    <span>
                      <span className="block text-sm">
                        Download the launcher
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-healthy-ink">
                          Recommended
                        </span>
                      </span>
                      <span className="block text-xs text-gray-400">
                        Plain text — open it in Notepad and read every line before you run it.
                        Windows asks once whether to run a downloaded file; that is the only
                        warning.
                      </span>
                    </span>
                    <span className="text-xs font-mono text-healthy-ink shrink-0">
                      SentinelSetup.cmd
                    </span>
                  </a>
                </li>
              )}

              {exeInstaller && (
                <li>
                  <a
                    href={exeInstaller.url}
                    className="flex items-baseline justify-between gap-4 px-3 py-2.5 rounded border border-white/10 bg-white/5 hover:bg-white/10"
                  >
                    <span>
                      <span className="block text-sm">Download the setup program</span>
                      <span className="block text-xs text-gray-400">
                        A proper console app with a numbered branch menu. Read the warning below
                        before you send this to anyone.
                      </span>
                    </span>
                    <span className="text-xs font-mono text-gray-300 shrink-0">
                      SentinelSetup.exe
                    </span>
                  </a>
                </li>
              )}
            </ul>

            {/*
              Said here rather than left for somebody to discover on the
              laptop. A teammate who hits a full-screen blue "Windows
              protected your PC" panel with no warning concludes the download
              was malicious and stops — which is the correct instinct, and
              exactly why it has to be pre-empted in writing.

              Border plus heading, never colour alone, matching the operator
              warning below.
            */}
            {exeInstaller && (
              <div className="mt-3 rounded border border-warning/60 bg-warning/10 p-3">
                <h3 className="text-xs font-semibold mb-1 text-warning">
                  <span className="sr-only">Important: </span>Windows will warn about the .exe
                </h3>
                <p className="text-xs text-gray-300">
                  It is not code signed — we have no certificate — so SmartScreen shows a blue{" "}
                  <span className="font-mono">Windows protected your PC</span> panel with only a{" "}
                  <span className="font-mono">Don&apos;t run</span> button visible. Click{" "}
                  <span className="font-mono">More info</span>, then{" "}
                  <span className="font-mono">Run anyway</span>. Some Defender configurations
                  quarantine it outright, in which case nothing you click will help.
                </p>
                <p className="text-xs text-gray-400 mt-2">
                  The <span className="font-mono">.cmd</span> above does not have this problem and
                  does the same job. Reach for the <span className="font-mono">.exe</span> only if
                  you specifically want the branch menu.
                </p>
              </div>
            )}

            <p className="text-xs text-gray-500 mt-3">
              Neither launcher needs administrator to start — they ask when they need it, at the
              same point the pasted command does.
            </p>
          </section>
        )}

        {/* ------------------------------------------ 4. what it does --- */}
        <section aria-labelledby="step-disclosure">
          <h2 id="step-disclosure" className="text-sm font-semibold mb-1">
            <span className="text-gray-500 mr-2">4.</span>What this installs, and what it can do
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            The short version. The installer itself shows the full disclosure on screen before it
            touches anything, and that is the authoritative one — read it there.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-white/10 bg-white/5 p-3">
              <h3 className="text-xs font-semibold mb-2">It installs</h3>
              <ul className="text-xs text-gray-400 space-y-1 list-disc list-inside">
                <li>Node.js, PowerShell 7 and Git (to run the agent)</li>
                <li>Google Chrome</li>
                <li>TightVNC server, for remote desktop</li>
                <li>A scheduled task that starts the agent at sign-in</li>
              </ul>
            </div>

            <div className="rounded border border-white/10 bg-white/5 p-3">
              <h3 className="text-xs font-semibold mb-2">It changes</h3>
              <ul className="text-xs text-gray-400 space-y-1 list-disc list-inside">
                <li>Opens TCP port 5900 inbound on the Windows firewall</li>
                <li>Writes the hub URL and branch to a local .env file</li>
                <li>Starts sending a heartbeat to the hub every minute</li>
              </ul>
            </div>
          </div>

          {/*
            The one thing on this page somebody might not expect, so it is
            said plainly and not buried in the list above. Border plus a
            heading, never colour alone, so it reads the same in monochrome.
          */}
          <div className="mt-3 rounded border border-warning/60 bg-warning/10 p-3">
            <h3 className="text-xs font-semibold mb-1 text-warning">
              <span className="sr-only">Important: </span>An operator can watch and control this
              desktop
            </h3>
            <p className="text-xs text-gray-300">
              Once TightVNC is running, an operator in the Command Center can view the screen and
              take over the mouse and keyboard, and can run remediation scripts on the machine.
              Every session and every command is written to the audit log with the operator&apos;s
              name against it. This is a work machine tool: do not enroll a personal laptop you
              would not want an operator to see.
            </p>
          </div>

          <p className="text-xs text-gray-500 mt-3">
            Changed your mind later? Download the uninstaller below and run it. It removes all of
            the above except the applications, which are yours to keep or remove.
          </p>
        </section>

        {/* --------------------------------------------- 5. downloads --- */}
        <section aria-labelledby="step-downloads">
          <h2 id="step-downloads" className="text-sm font-semibold mb-1">
            <span className="text-gray-500 mr-2">5.</span>The scripts themselves
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Served by the control plane, so they always match the deployed version. Read any of
            them before you run it — that is why they are here.
          </p>

          <ul className="grid gap-2">
            {DOWNLOADS.map((item) => (
              <li key={item.file}>
                <a
                  href={`${CONTROL_PLANE}/v1/enroll/${item.file}`}
                  className="flex items-baseline justify-between gap-4 px-3 py-2.5 rounded border border-white/10 bg-white/5 hover:bg-white/10"
                >
                  <span>
                    <span className="block text-sm">{item.title}</span>
                    <span className="block text-xs text-gray-500">{item.blurb}</span>
                  </span>
                  <span className="text-xs font-mono text-healthy-ink shrink-0">{item.file}</span>
                </a>
              </li>
            ))}
          </ul>

          <p className="text-xs text-gray-500 mt-3">
            Enrolling a machine that cannot reach github.com? The bootstrap script falls back to{" "}
            <span className="font-mono text-gray-400">{CONTROL_PLANE}/v1/enroll/repo.zip</span>{" "}
            automatically, so the same command still works.
          </p>
        </section>
      </main>
    </div>
  );
}
