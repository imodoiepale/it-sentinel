"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SentinelMark } from "../../components/marketing/SiteHeader";
import { BranchPicker } from "../../components/enroll/BranchPicker";
import { CommandBlock } from "../../components/enroll/CommandBlock";
import { FALLBACK_BRANCHES, type Branch } from "../../components/enroll/branches";
import { Callout, Card, DownloadRow, Mono, Section, TextLink } from "../../components/enroll/ui";

/**
 * Self-service enrollment.
 *
 * The job of this page is narrow: get a teammate from "I have a laptop" to
 * "my laptop is in the fleet" with one branch choice and one paste. Three
 * numbered steps are the whole path; everything below them is reference for
 * somebody who wants to know what they are agreeing to before they agree.
 *
 * ── Why this page is public, when it used to be behind operator login ──
 *
 * It was gated on the argument that the branch slugs plus the hub URL are the
 * reconnaissance needed to push an unwanted machine into the fleet
 * (docs/19-enrollment.md §5.2). That argument no longer survives contact:
 *
 *   1. The repo is public. Every script, every one of the seven slugs and the
 *      hub URL are already readable by anyone who opens GitHub. The login
 *      withheld nothing that was not published elsewhere.
 *   2. `/v1/enroll/bootstrap.ps1` and `/v1/enroll/branches` are deliberately
 *      unauthenticated and have to stay that way — a laptop with nothing on
 *      it has no credential to present. The gate stood in front of the
 *      instructions while the thing they instruct you to run stayed open.
 *   3. The people who need this page are the ones without operator accounts.
 *      Gating it meant the person who has to install could not reach the
 *      instructions, and the landing page's own "Enroll a machine" button
 *      bounced every anonymous visitor to /login.
 *
 * So the gate cost real usability and bought nothing. What it never fixed,
 * and what is unchanged by removing it: `POST /v1/heartbeat`,
 * `GET /v1/commands/poll` and `POST /v1/commands/:msgId/result` have no
 * authentication, so any machine posting a well-formed heartbeat that names
 * an existing slug is auto-provisioned, and the same caller can drain another
 * machine's command queue or report a fabricated result. That is the real
 * gap. It is written up in docs/19-enrollment.md §5.2 along with the shape of
 * the fix — per-machine enrollment tokens gating all three routes — and it
 * needs a schema change, not a login prompt on a page of instructions.
 */

const CONTROL_PLANE =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? "https://it-sentinel-control-plane.onrender.com";

const REPO_URL = "https://github.com/imodoiepale/it-sentinel";

/**
 * preflight.ps1 locates the checkout it is inspecting through `$PSScriptRoot`,
 * so unlike the installer it cannot be piped in from the hub — `irm | iex`
 * leaves that variable empty. It has to be the copy on disk the install left
 * behind, at the installer's default root.
 */
const PREFLIGHT = '& "$env:USERPROFILE\\it-sentinel\\scripts\\preflight.ps1"';

const SCRIPTS = [
  {
    file: "bootstrap.ps1",
    title: "Bootstrap",
    blurb: "What the one-liner fetches. Downloads the code, then hands over to the installer.",
  },
  {
    file: "install-sentinel-agent.ps1",
    title: "Installer",
    blurb:
      "The script that does the work. Prints a full disclosure and waits for you to type INSTALL.",
  },
  {
    file: "preflight.ps1",
    title: "Preflight check",
    blurb: "Read-only. Tells you what state the machine is in and changes nothing.",
  },
  {
    file: "uninstall-sentinel-agent.ps1",
    title: "Uninstaller",
    blurb: "Removes the agent, the startup entry, the firewall rule and TightVNC. Run it any time.",
  },
];

/**
 * Whether this control plane can actually hand out each launcher, from
 * `GET /v1/enroll`.
 *
 * Asked rather than assumed because `SentinelSetup.exe` is compiled by
 * csc.exe on Windows and is deliberately not committed, so a deployment that
 * builds on Linux may not have one. Rendering a download button that 503s is
 * worse than rendering no button, and worse still on the one day somebody is
 * standing at a strange laptop.
 */
interface Installer {
  file: string;
  url: string;
  description: string;
  available: boolean;
}

export default function EnrollPage() {
  const [branches, setBranches] = useState<Branch[]>(FALLBACK_BRANCHES);
  const [installers, setInstallers] = useState<Installer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
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
        // Silent for the same reason: the section this feeds simply does not
        // render, and the PowerShell command — the path that always works —
        // is already on screen above it.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const cmdInstaller = installers.find((i) => i.file === "SentinelSetup.cmd" && i.available);
  const exeInstaller = installers.find((i) => i.file === "SentinelSetup.exe" && i.available);

  const chosen = branches.find((b) => b.slug === selected) ?? null;

  /**
   * The scriptblock form rather than plain `irm | iex`, because `iex` on a
   * piped string has no way to pass arguments — and the whole point of this
   * page is that the branch and the hub arrive already filled in.
   */
  const command = useMemo(() => {
    const base = `& ([scriptblock]::Create((irm ${CONTROL_PLANE}/v1/enroll/bootstrap.ps1)))`;
    if (!selected) return `${base} -ControlPlaneUrl ${CONTROL_PLANE}`;
    return `${base} -BranchSlug ${selected} -ControlPlaneUrl ${CONTROL_PLANE}`;
  }, [selected]);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between gap-4 px-5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <SentinelMark />
            <span className="text-sm font-semibold tracking-tight">IT Sentinel</span>
          </Link>
          <Link
            href="/console"
            className="text-sm text-muted transition-colors hover:text-ink"
          >
            Open the console
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-6 sm:py-14">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-healthy-ink">
          Sentinel Global
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          Put IT Sentinel on this laptop
        </h1>
        <p className="mt-4 max-w-2xl text-base text-ink-soft">
          Pick your branch, copy one command, paste it into Windows PowerShell. About ten minutes,
          most of it downloads. You do not need an account here to do it.
        </p>

        {/*
          Three expectations set before anybody scrolls, because each one is a
          reason people stop halfway: the wrong operating system, an
          unexplained administrator prompt, and the fear that having pasted
          the command they have already changed something.
        */}
        <ul className="mt-7 grid gap-2 sm:grid-cols-3">
          {[
            ["Windows 10 or 11", "Not macOS or Linux."],
            ["One administrator prompt", "It asks when it needs to, not before."],
            ["Nothing changes until you type INSTALL", "The installer stops and waits for you."],
          ].map(([title, detail]) => (
            <li key={title} className="rounded-lg border border-line bg-surface px-3.5 py-3">
              <span className="block text-sm font-medium">{title}</span>
              <span className="mt-0.5 block text-xs text-muted">{detail}</span>
            </li>
          ))}
        </ul>

        <main className="mt-14 space-y-14">
          {/* ---------------------------------------------- 1. branch --- */}
          <Section
            id="branch"
            index={1}
            title="Which branch is this laptop?"
            lede={
              <>
                This is the branch the machine reports into. Pick the wrong one and it turns up in
                somebody else&apos;s fleet — re-run the installer to change it.
              </>
            }
          >
            <BranchPicker branches={branches} selected={selected} onSelect={setSelected} />
          </Section>

          {/* --------------------------------------------- 2. command --- */}
          <Section
            id="command"
            index={2}
            title="Run this in Windows PowerShell"
            lede={
              chosen ? (
                <>
                  Open PowerShell on the laptop — no need to Run as administrator, it asks when it
                  needs to — and paste this. It is filled in for <Mono>{chosen.slug}</Mono>,{" "}
                  {chosen.name}.
                </>
              ) : (
                <>
                  Pick a branch above and it gets filled in for you. Paste it as-is and the
                  installer shows a numbered menu instead.
                </>
              )
            }
          >
            <CommandBlock command={command} prominent describedBy="command-note" />

            <p id="command-note" className="mt-4 max-w-2xl text-sm text-muted">
              It asks for administrator once, and changes nothing until you type <Mono>INSTALL</Mono>{" "}
              at the prompt. Want to know exactly what you are agreeing to first?{" "}
              <TextLink href="#what">Read what it installs</TextLink>, or open{" "}
              <TextLink href={`${CONTROL_PLANE}/v1/enroll/install-sentinel-agent.ps1`}>
                the installer itself
              </TextLink>
              .
            </p>
          </Section>

          {/* ------------------------------------------- 3. confirm it --- */}
          <Section
            id="confirm"
            index={3}
            title="Check it worked"
            lede="Three things should be true within a minute of the installer finishing."
          >
            <ul className="space-y-2.5 text-sm text-ink-soft">
              {[
                <>
                  The console prints <Mono>SETUP COMPLETE</Mono> with your branch name and the hub
                  URL. If it prints <Mono>SETUP INCOMPLETE</Mono> instead, it lists exactly which
                  checks failed and it is safe to run again.
                </>,
                <>
                  A TightVNC tray icon appears in the notification area. Remote desktop is not
                  silent — that icon is there the whole time the server is running.
                </>,
                <>
                  The machine appears in the <TextLink href="/console">Command Center</TextLink>{" "}
                  under {chosen ? <Mono>{chosen.name}</Mono> : "your branch"}, with a healthy
                  status dot. Heartbeats go out every 15 seconds, so it should not take long.
                </>,
              ].map((item, i) => (
                <li key={i} className="flex gap-3">
                  <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-healthy" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <div className="mt-6">
              <h3 className="text-sm font-semibold">If it did not turn up</h3>
              <p className="mt-1.5 max-w-2xl text-sm text-muted">
                Run the preflight check on the laptop. It is read-only, it changes nothing, and it
                names the thing that is wrong — nearly always a hub URL that does not match or a
                branch slug the installer rejected.
              </p>
              <div className="mt-3">
                <CommandBlock command={PREFLIGHT} label="Copy preflight command" />
              </div>
            </div>
          </Section>

          <hr className="border-line" />

          {/* ---------------------------------------- other launchers --- */}
          {/*
            Rendered only when the control plane says it has something to give;
            see the Installer interface for why that is asked and not assumed.
            Unnumbered on purpose — this is an alternative to step 2, not a
            fourth thing to do.
          */}
          {(cmdInstaller || exeInstaller) && (
            <Section
              id="download"
              title="Or download something and double-click it"
              lede={
                <>
                  For anybody who would rather not paste into PowerShell. Both launchers do exactly
                  what the command above does — fetch <Mono>bootstrap.ps1</Mono> from this hub and
                  run it. Neither makes a decision of its own, and the installer still waits for a
                  typed <Mono>INSTALL</Mono>.
                  {!selected && " Pick a branch above first, or the launcher will ask you."}
                </>
              }
            >
              <ul className="grid gap-2">
                {cmdInstaller && (
                  <DownloadRow
                    href={cmdInstaller.url}
                    title="Download the launcher"
                    file="SentinelSetup.cmd"
                    badge="Recommended"
                  >
                    Plain text — open it in Notepad and read every line before you run it. Windows
                    asks once whether to run a downloaded file; that is the only warning.
                  </DownloadRow>
                )}

                {exeInstaller && (
                  <DownloadRow
                    href={exeInstaller.url}
                    title="Download the setup program"
                    file="SentinelSetup.exe"
                  >
                    A console app with a numbered branch menu. Read the warning below before you
                    send this to anyone.
                  </DownloadRow>
                )}
              </ul>

              {/*
                Said here rather than left for somebody to discover on the
                laptop. A teammate who hits a full-screen blue "Windows
                protected your PC" panel with no warning concludes the download
                was malicious and stops — which is the correct instinct, and
                exactly why it has to be pre-empted in writing.
              */}
              {exeInstaller && (
                <div className="mt-3">
                  <Callout tone="warn" title="Windows will warn about the .exe">
                    <p>
                      It is not code signed — there is no certificate for this project — so
                      SmartScreen shows a full-screen blue <Mono>Windows protected your PC</Mono>{" "}
                      panel whose only visible button is <Mono>Don&apos;t run</Mono>. The way
                      forward is the small <Mono>More info</Mono> link above that button, then{" "}
                      <Mono>Run anyway</Mono>. Chrome may flag the download first, with{" "}
                      <Mono>Keep</Mono> hidden behind the ⋮ menu on the download chip.
                    </p>
                    <p>
                      Some Defender and most third-party antivirus configurations quarantine it
                      outright. The file vanishes from Downloads and nothing you click brings it
                      back. That is correct behaviour on a machine you do not administer, not a bug
                      to work around.
                    </p>
                    <p>
                      The <Mono>.cmd</Mono> above has none of this and does the same job. Reach for
                      the <Mono>.exe</Mono> only if you specifically want the branch menu.
                    </p>
                  </Callout>
                </div>
              )}

              <p className="mt-3 text-sm text-muted">
                Neither launcher needs administrator to start — they ask when they need it, at the
                same point the pasted command does.
              </p>
            </Section>
          )}

          {/* --------------------------------------- what it installs --- */}
          <Section
            id="what"
            title="What this installs, and what it can do"
            lede={
              <>
                The short version. The installer prints the full disclosure on screen before it
                touches anything and that one is authoritative — read it there, above the{" "}
                <Mono>INSTALL</Mono> prompt.
              </>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Card title="It installs">
                <ul className="list-inside list-disc space-y-1">
                  <li>Node.js LTS, PowerShell 7, Git and pnpm — what the agent runs on</li>
                  <li>Google Chrome</li>
                  <li>TightVNC Server, for remote desktop</li>
                  <li>A startup entry, so the agent runs when you sign in</li>
                </ul>
                <p>Anything already on the machine is left alone.</p>
              </Card>

              <Card title="It changes">
                <ul className="list-inside list-disc space-y-1">
                  <li>
                    One inbound firewall rule, TCP 5900. Any machine on the network this laptop is
                    joined to can then reach its remote-desktop port — on venue Wi-Fi, that is
                    everyone in the room
                  </li>
                  <li>Sets the TightVNC service to start automatically</li>
                  <li>
                    Writes the hub URL and branch slug to a local <Mono>.env</Mono>, keeping the
                    previous one as <Mono>.env.bak</Mono>
                  </li>
                </ul>
              </Card>

              <Card title="It sends, every 15 seconds">
                <p>
                  Hostname, LAN IP, MAC, serial and model. CPU, memory and the top processes by
                  memory. Disk space and SMART health. Windows version, uptime and pending updates.
                  Network reachability and this machine&apos;s public IP. Antivirus and firewall
                  state. Printers, installed applications and monitored services. Recent critical
                  and error entries from the event log, including their message text. Who is signed
                  in, and whether the session is active, locked or idle.
                </p>
              </Card>

              <Card title="It does not send">
                <p>
                  Email message contents — the heartbeat contract has no field for them. It does
                  not log keystrokes, read your files, or capture the screen on a timer. The
                  TightVNC password is typed by whoever is at the keyboard and never travels
                  through this page.
                </p>
              </Card>
            </div>

            {/*
              The one thing here somebody might not expect, so it is said
              plainly rather than left to be inferred from "TightVNC" in the
              list above.
            */}
            <div className="mt-3">
              <Callout tone="warn" title="An operator can watch and control this desktop">
                <p>
                  Once TightVNC is running, an operator in the Command Center can view the screen,
                  take over the mouse and keyboard, and dispatch commands that run on the machine.
                  Every session and every command is written to the audit log with that
                  operator&apos;s name against it, and the tray icon is visible throughout — but
                  assume somebody can watch this screen.
                </p>
                <p>
                  This is a work-machine tool. Sign out of anything personal first, and do not
                  enroll a laptop you would not want an operator to see.
                </p>
              </Callout>
            </div>

            <div className="mt-3">
              <Callout tone="note" title="Changed your mind?">
                <p>
                  Run the uninstaller below. It removes the agent, the startup entry, the firewall
                  rule and TightVNC. The applications stay — they are yours to keep or remove.
                </p>
              </Callout>
            </div>
          </Section>

          {/* --------------------------------------------- the scripts --- */}
          <Section
            id="scripts"
            title="The scripts themselves"
            lede={
              <>
                Served by the control plane, so they always match the deployed version rather than
                whatever is on <Mono>main</Mono>. Read any of them before you run it — that is why
                they are here, and they are all in the{" "}
                <TextLink href={REPO_URL}>public repository</TextLink> too.
              </>
            }
          >
            <ul className="grid gap-2">
              {SCRIPTS.map((item) => (
                <DownloadRow
                  key={item.file}
                  href={`${CONTROL_PLANE}/v1/enroll/${item.file}`}
                  title={item.title}
                  file={item.file}
                >
                  {item.blurb}
                </DownloadRow>
              ))}
            </ul>

            <p className="mt-4 max-w-2xl text-sm text-muted">
              On a network that blocks github.com? The bootstrap script falls back to{" "}
              <Mono>/v1/enroll/repo.zip</Mono> on this hub automatically, so the same command still
              works. And if the first request hangs for the better part of a minute, that is the
              free-tier host waking from idle, not a failure.
            </p>
          </Section>
        </main>

        <footer className="mt-16 border-t border-line pt-6 text-sm text-muted">
          This laptop will report to{" "}
          <span className="break-all font-mono text-xs text-ink-soft">{CONTROL_PLANE}</span>
        </footer>
      </div>
    </div>
  );
}
