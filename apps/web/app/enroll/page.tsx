"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../lib/useAuth";
import { ui } from "../../lib/theme";
import { Button } from "../../components/ui/Button";

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
      <div className={`flex min-h-screen items-center justify-center ${ui.canvas} ${ui.muted}`}>
        Loading…
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${ui.canvas}`}>
      <header className="border-b border-cloud bg-snow">
        <div className={`${ui.page} flex items-center justify-between py-6`}>
          <div>
            <div className={ui.eyebrow}>Sentinel Global</div>
            <h1 className={`mt-1 ${ui.subheading}`}>Enroll a machine</h1>
          </div>
          <a href="/console" className={ui.navLink}>
            Back to Command Center
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-10 px-6 py-section">
        <section aria-labelledby="step-branch">
          <h2 id="step-branch" className={`${ui.subheading} mb-1`}>
            <span className="mr-2 text-fog">1.</span>Which branch is this laptop?
          </h2>
          <p className={`${ui.caption} mb-4`}>
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
                  className={`flex items-start gap-3 rounded-buttons border px-3 py-2.5 text-left text-[14px] transition-opacity duration-200 ${
                    isSelected
                      ? "border-obsidian bg-snow"
                      : "border-cloud bg-quiet hover:opacity-80"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] leading-none ${
                      isSelected ? "border-obsidian text-obsidian" : "border-mist text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span>
                    <span className="block text-obsidian">
                      {branch.name}
                      {isSelected && <span className="sr-only"> (selected)</span>}
                    </span>
                    <span className="block font-mono text-[12px] text-fog">
                      {branch.slug}
                      {branch.region ? ` · ${branch.region}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="step-command">
          <h2 id="step-command" className={`${ui.subheading} mb-1`}>
            <span className="mr-2 text-fog">2.</span>Run this in Windows PowerShell
          </h2>
          <p className={`${ui.caption} mb-4`}>
            {selected ? (
              <>
                Open PowerShell on the laptop (no need to Run as administrator — it asks when it
                needs to) and paste this. It is filled in for{" "}
                <span className="font-mono text-graphite">{selected}</span>.
              </>
            ) : (
              <>
                Pick a branch above to have it filled in, or paste this as-is and the installer
                will show you a numbered menu.
              </>
            )}
          </p>

          <div className="overflow-hidden rounded-cards border border-cloud bg-snow">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all p-card font-mono text-[12px] text-graphite">
              {command}
            </pre>
            <div className="flex items-center gap-3 border-t border-cloud px-card py-3">
              <Button type="button" onClick={copy}>
                Copy command
              </Button>
              <span aria-live="polite" className={ui.caption}>
                {copied && <span className="text-obsidian">Copied to clipboard</span>}
                {copyFailed && (
                  <span>
                    This browser blocked the clipboard — select the command above and copy it.
                  </span>
                )}
              </span>
            </div>
          </div>

          <p className={`${ui.caption} mt-3`}>
            Takes about ten minutes on a fresh laptop, most of it downloads. It asks for
            administrator once, and will not change anything until you type{" "}
            <span className="font-mono text-graphite">INSTALL</span>. When it finishes, the machine
            appears in the Command Center within a minute.
          </p>
        </section>

        {(cmdInstaller || exeInstaller) && (
          <section aria-labelledby="step-download">
            <h2 id="step-download" className={`${ui.subheading} mb-1`}>
              <span className="mr-2 text-fog">3.</span>Or download a launcher and double-click it
            </h2>
            <p className={`${ui.caption} mb-4`}>
              Same thing as the command above, for anybody who would rather not paste into
              PowerShell. Both of these download <span className="font-mono">bootstrap.ps1</span>{" "}
              from this hub and run it — they make no decisions of their own, and the installer
              still waits for you to type <span className="font-mono text-graphite">INSTALL</span>.
              {selected ? null : " Pick a branch above first, or the launcher will ask you."}
            </p>

            <ul className="grid gap-2">
              {cmdInstaller && (
                <li>
                  <a
                    href={cmdInstaller.url}
                    className="flex items-baseline justify-between gap-4 rounded-cards border border-obsidian bg-snow px-card py-3 hover:bg-quiet"
                  >
                    <span>
                      <span className="block text-[14px] text-obsidian">
                        Download the launcher
                        <span className="ml-2 text-[12px] font-medium text-steel">Recommended</span>
                      </span>
                      <span className="mt-1 block text-[12px] text-fog">
                        Plain text — open it in Notepad and read every line before you run it.
                        Windows asks once whether to run a downloaded file; that is the only
                        warning.
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[12px] text-steel">
                      SentinelSetup.cmd
                    </span>
                  </a>
                </li>
              )}

              {exeInstaller && (
                <li>
                  <a
                    href={exeInstaller.url}
                    className="flex items-baseline justify-between gap-4 rounded-cards border border-cloud bg-snow px-card py-3 hover:bg-quiet"
                  >
                    <span>
                      <span className="block text-[14px] text-obsidian">
                        Download the setup program
                      </span>
                      <span className="mt-1 block text-[12px] text-fog">
                        A proper console app with a numbered branch menu. Read the warning below
                        before you send this to anyone.
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[12px] text-steel">
                      SentinelSetup.exe
                    </span>
                  </a>
                </li>
              )}
            </ul>

            {exeInstaller && (
              <div className={`mt-3 ${ui.cardDark}`}>
                <h3 className="mb-1 text-[14px] font-medium text-snow">
                  <span className="sr-only">Important: </span>Windows will warn about the .exe
                </h3>
                <p className="text-[13px] leading-[1.64] text-mist">
                  It is not code signed — we have no certificate — so SmartScreen shows a blue{" "}
                  <span className="font-mono">Windows protected your PC</span> panel with only a{" "}
                  <span className="font-mono">Don&apos;t run</span> button visible. Click{" "}
                  <span className="font-mono">More info</span>, then{" "}
                  <span className="font-mono">Run anyway</span>. Some Defender configurations
                  quarantine it outright, in which case nothing you click will help.
                </p>
                <p className="mt-2 text-[13px] leading-[1.64] text-ash">
                  The <span className="font-mono">.cmd</span> above does not have this problem and
                  does the same job. Reach for the <span className="font-mono">.exe</span> only if
                  you specifically want the branch menu.
                </p>
              </div>
            )}

            <p className={`${ui.caption} mt-3`}>
              Neither launcher needs administrator to start — they ask when they need it, at the
              same point the pasted command does.
            </p>
          </section>
        )}

        <section aria-labelledby="step-disclosure">
          <h2 id="step-disclosure" className={`${ui.subheading} mb-1`}>
            <span className="mr-2 text-fog">{cmdInstaller || exeInstaller ? "4." : "3."}</span>
            What this installs, and what it can do
          </h2>
          <p className={`${ui.caption} mb-4`}>
            The short version. The installer itself shows the full disclosure on screen before it
            touches anything, and that is the authoritative one — read it there.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className={ui.card}>
              <h3 className="mb-2 text-[14px] font-medium text-obsidian">It installs</h3>
              <ul className="list-inside list-disc space-y-1 text-[13px] text-steel">
                <li>Node.js, PowerShell 7 and Git (to run the agent)</li>
                <li>Google Chrome</li>
                <li>TightVNC server, for remote desktop</li>
                <li>A scheduled task that starts the agent at sign-in</li>
              </ul>
            </div>

            <div className={ui.card}>
              <h3 className="mb-2 text-[14px] font-medium text-obsidian">It changes</h3>
              <ul className="list-inside list-disc space-y-1 text-[13px] text-steel">
                <li>Opens TCP port 5900 inbound on the Windows firewall</li>
                <li>Writes the hub URL and branch to a local .env file</li>
                <li>Starts sending a heartbeat to the hub every minute</li>
              </ul>
            </div>
          </div>

          <div className={`mt-3 ${ui.cardDark}`}>
            <h3 className="mb-1 text-[14px] font-medium text-snow">
              <span className="sr-only">Important: </span>An operator can watch and control this
              desktop
            </h3>
            <p className="text-[13px] leading-[1.64] text-mist">
              Once TightVNC is running, an operator in the Command Center can view the screen and
              take over the mouse and keyboard, and can run remediation scripts on the machine.
              Every session and every command is written to the audit log with the operator&apos;s
              name against it. This is a work machine tool: do not enroll a personal laptop you
              would not want an operator to see.
            </p>
          </div>

          <p className={`${ui.caption} mt-3`}>
            Changed your mind later? Download the uninstaller below and run it. It removes all of
            the above except the applications, which are yours to keep or remove.
          </p>
        </section>

        <section aria-labelledby="step-downloads">
          <h2 id="step-downloads" className={`${ui.subheading} mb-1`}>
            <span className="mr-2 text-fog">{cmdInstaller || exeInstaller ? "5." : "4."}</span>
            The scripts themselves
          </h2>
          <p className={`${ui.caption} mb-4`}>
            Served by the control plane, so they always match the deployed version. Read any of
            them before you run it — that is why they are here.
          </p>

          <ul className="grid gap-2">
            {DOWNLOADS.map((item) => (
              <li key={item.file}>
                <a
                  href={`${CONTROL_PLANE}/v1/enroll/${item.file}`}
                  className="flex items-baseline justify-between gap-4 rounded-cards border border-cloud bg-snow px-card py-3 hover:bg-quiet"
                >
                  <span>
                    <span className="block text-[14px] text-obsidian">{item.title}</span>
                    <span className="block text-[12px] text-fog">{item.blurb}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[12px] text-steel">{item.file}</span>
                </a>
              </li>
            ))}
          </ul>

          <p className={`${ui.caption} mt-3`}>
            Enrolling a machine that cannot reach github.com? The bootstrap script falls back to{" "}
            <span className="font-mono text-steel">{CONTROL_PLANE}/v1/enroll/repo.zip</span>{" "}
            automatically, so the same command still works.
          </p>
        </section>
      </main>
    </div>
  );
}
