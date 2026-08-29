import Link from "next/link";
import { SiteHeader } from "../components/marketing/SiteHeader";
import { SiteFooter } from "../components/marketing/SiteFooter";
import { LiveBranches } from "../components/marketing/LiveBranches";
import { fetchSites } from "../components/marketing/sites";
import {
  Card,
  Eyebrow,
  LivePip,
  PrimaryLink,
  SecondaryLink,
  Section,
  SectionHeading,
} from "../components/marketing/primitives";

/**
 * Revalidate rather than render per-request: the branch roster changes when
 * someone enrols a site, not between page views, and a cached HTML response
 * is the difference between a judge seeing the headline immediately and
 * watching a spinner while a sleeping API wakes up.
 */
export const revalidate = 60;

export const metadata = {
  title: "IT Sentinel - Ask what's broken. Fix it without leaving the room.",
  description:
    "Live health for every Windows machine across seven branches on five continents, a voice agent that answers and acts, and remote control of a branch machine - all through one policy check and one audit trail.",
};

export default async function LandingPage() {
  /*
   * A short SSR budget on purpose. If the control plane is cold this returns
   * null and LiveBranches finishes the job in the browser; blocking the whole
   * page on a sleeping free-tier service to fill in one grid is the wrong
   * trade for a first impression.
   */
  const sites = await fetchSites(3_000);

  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <FleetSection sites={sites} />
        <CapabilitiesSection />
        <GovernanceSection />
        <MemorySection />
        <LoopSection />
        <ClosingSection />
      </main>
      <SiteFooter />
    </>
  );
}

function Hero() {
  return (
    <div className="relative overflow-hidden">
      {/*
        One soft radial wash, not a gradient background. It exists to lift the
        headline off a flat #0b0f14 field and stops well above the fold so the
        rest of the page stays the same ground colour as the console.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[32rem] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(13,148,136,0.16),transparent_70%)]"
      />
      <div className="relative mx-auto w-full max-w-6xl px-6 pb-20 pt-20 sm:pt-28 lg:px-8">
        <LivePip label="Seven branches, five continents, monitored live" />
        <h1 className="mt-6 max-w-3xl text-pretty text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
          Ask what&rsquo;s broken. Fix it without leaving the room.
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-gray-400">
          IT Sentinel watches every Windows machine across your branches and answers out loud. Say{" "}
          <Spoken>What&rsquo;s wrong in Lagos?</Spoken> and it tells you. Say{" "}
          <Spoken>Restart the print spooler there</Spoken> and it does &mdash; through the same
          policy check, the same tier ceiling and the same audit trail as every click.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <PrimaryLink href="/console">Open the console</PrimaryLink>
          <SecondaryLink href="/enroll">Enroll a machine</SecondaryLink>
        </div>
      </div>
    </div>
  );
}

/* Spoken commands are quoted, not styled as code -- they are things a person says. */
function Spoken({ children }: { children: React.ReactNode }) {
  return <q className="text-gray-200">{children}</q>;
}

function FleetSection({ sites }: { sites: Awaited<ReturnType<typeof fetchSites>> }) {
  return (
    <Section id="fleet">
      <SectionHeading
        eyebrow="The fleet"
        title="This list is not a mockup."
        lede="Every branch below comes from the control plane's own roster, re-read at least once a minute. Enrol a site today and it appears here without anyone editing this page."
      />
      <LiveBranches initial={sites} />
    </Section>
  );
}

const CAPABILITIES = [
  {
    title: "Talk to it",
    body: "A voice agent that knows the fleet. Ask what is wrong at a branch and it reads back the failing checks. Ask it to restart a service and a signed playbook runs on that machine. Ask it to open a machine and the remote session comes up on your screen.",
    detail: "Clicking a row and saying \"open Lagos\" land on the same panel. One seam, two entry points.",
  },
  {
    title: "Take the machine",
    body: "Remote desktop into a branch machine from the browser, with full keyboard and mouse control or view-only. Every session shows a notice that it is being audited, and it cannot be dismissed. There is no covert mode.",
    detail:
      "The machine's password is decrypted server-side for one handshake and never reaches the browser.",
  },
  {
    title: "See it happen",
    body: "Agents report in every fifteen seconds, so the board is never more than one heartbeat behind the estate. A machine that stops reporting flips to a distinct stale state instead of quietly staying green.",
    detail: "Staleness is not health, and the console never lets the two look alike.",
  },
];

function CapabilitiesSection() {
  return (
    <Section id="capabilities">
      <SectionHeading
        eyebrow="Capabilities"
        title="Three ways into the same machine."
        lede="Monitoring that only tells you something is wrong leaves the hard part to you. Every signal on the board leads somewhere you can act."
      />
      <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
        {CAPABILITIES.map((c) => (
          <Card key={c.title} className="flex flex-col">
            <h3 className="text-base font-semibold text-white">{c.title}</h3>
            <p className="mt-3 flex-1 text-sm leading-6 text-gray-400">{c.body}</p>
            <p className="mt-5 border-t border-white/[0.07] pt-4 text-xs leading-5 text-muted">
              {c.detail}
            </p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

const TIERS = [
  { tier: "T0", name: "Observe", gate: "Automatic, audited" },
  { tier: "T1", name: "Inspect", gate: "Automatic, within site scope" },
  { tier: "T2", name: "Diagnose", gate: "Sandboxed, timeout-bounded" },
  { tier: "T3", name: "Remediate", gate: "Operator confirmation, re-checked server-side" },
  { tier: "T4", name: "Modify", gate: "Password re-authentication, named approver, ticket" },
  { tier: "T5", name: "Impact", gate: "Dual approval, canary, rollback" },
  { tier: "T6", name: "Denied", gate: "Refused unconditionally, under every role" },
];

const GUARANTEES = [
  {
    title: "Nothing gets to name its own tier",
    body: "Every action becomes a typed request that a separate executor validates before anything runs. The request carries no authority. A caller claiming a low tier does not get past a deny-list match.",
  },
  {
    title: "It cannot edit its own guards",
    body: "The deny list matches the executor, the deny list itself, the tier resolver and the app launcher by filename. The agent is structurally unable to rewrite the code that constrains it.",
  },
  {
    title: "A logged-in tab is not a human",
    body: "Arbitrary execution requires the operator to enter their password again. A session left open on an unlocked workstation is the realistic threat against a console that can run PowerShell on a till.",
  },
  {
    title: "Refusals are recorded too",
    body: "Every refusal is written to the audit log with its reason. Nothing is silently dropped, so the record shows what was attempted, not only what succeeded.",
  },
];

function GovernanceSection() {
  return (
    <Section id="governance">
      <SectionHeading
        eyebrow="Governance"
        title="Voice is an input method, not a bypass."
        lede="A spoken command gets the identical policy check, the identical tier ceiling and the identical audit-log entry as a typed one. That is the whole point of putting a microphone in front of a system that can execute on the machines it monitors."
      />

      <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-5 lg:gap-12">
        <div className="lg:col-span-2">
          <h3 className="text-sm font-medium text-white">Seven action tiers</h3>
          <p className="mt-2 text-sm leading-6 text-muted">
            Each role has a fixed ceiling. Reaching a tier is a property of the operator, never of
            the request.
          </p>
          <ul className="mt-6 divide-y divide-white/[0.07] rounded-xl border border-white/[0.09]">
            {TIERS.map((t) => (
              /*
                A three-column grid, not a flex row: the longer gates wrap,
                and under flex the overflow starts back at the row's left edge
                and sits under the tier badge. Columns keep every wrapped line
                aligned with the gate above it.
              */
              <li
                key={t.tier}
                className="grid grid-cols-[1.75rem_5rem_1fr] items-baseline gap-x-4 px-4 py-3"
              >
                <span
                  className={`font-mono text-xs font-semibold ${
                    t.tier === "T6" ? "text-critical-ink" : "text-healthy-ink"
                  }`}
                >
                  {t.tier}
                </span>
                <span className="text-sm font-medium text-gray-200">{t.name}</span>
                <span className="text-xs leading-5 text-muted">{t.gate}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="lg:col-span-3">
          <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {GUARANTEES.map((g) => (
              <div key={g.title}>
                <dt className="text-base font-semibold text-white">{g.title}</dt>
                <dd className="mt-2.5 text-sm leading-6 text-gray-400">{g.body}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 rounded-xl border border-critical/25 bg-critical/[0.06] p-6">
            <h3 className="text-sm font-semibold text-white">
              T6 is checked first, before tier logic
            </h3>
            <p className="mt-2.5 text-sm leading-6 text-gray-400">
              Disabling endpoint protection. Editing the audit log or a session recording. Reading a
              vault secret. Exposing a machine to the public internet. Granting itself privileges.
              Destroying user data or backups. These are not permissions anyone can be granted, and
              they are refused before the executor considers who is asking.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}

function MemorySection() {
  return (
    <Section id="memory">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center">
        <div>
          <SectionHeading
            eyebrow="Cross-branch intelligence"
            title="The fleet remembers what fixed it last time."
            lede="When a fault comes up, Sentinel looks it up across every branch rather than only the machine in front of you. A technician starts from the estate's history instead of from zero."
          />
          <p className="mt-6 max-w-xl text-sm leading-6 text-muted">
            It also will not overstate what it knows. Below four graded attempts it reports the raw
            counts instead of a percentage, because a success rate drawn from two data points is a
            number you would act on and should not.
          </p>
        </div>

        <figure className="rounded-xl border border-white/[0.09] bg-white/[0.02] p-7">
          <Eyebrow>What it says</Eyebrow>
          <blockquote className="mt-4 text-pretty text-lg leading-8 text-gray-200">
            &ldquo;This isn&rsquo;t new: the printer check has been resolved 11 times across 7
            branches. The previous fix was restart-spooler, which succeeded 78% of the time. Ask me
            for the history if you want the detail.&rdquo;
          </blockquote>
          <figcaption className="mt-5 border-t border-white/[0.07] pt-4 text-xs leading-5 text-muted">
            Illustrative phrasing. The count, the branch spread and the success rate are all read
            from the incident record at the moment you ask.
          </figcaption>
        </figure>
      </div>
    </Section>
  );
}

const LOOP = [
  {
    step: "Monitor",
    body: "Agents on every branch machine report health on a fifteen-second heartbeat.",
  },
  {
    step: "Detect",
    body: "The control plane derives status, raises the alert and opens an incident.",
  },
  {
    step: "Diagnose",
    body: "Read-only tools answer what is failing, on which machine, and since when.",
  },
  {
    step: "Recommend",
    body: "Recurrence across the fleet surfaces the fix that actually worked before.",
  },
  {
    step: "Remediate",
    body: "A signed, hash-pinned playbook runs, gated by the operator's tier ceiling.",
  },
  {
    step: "Remote control",
    body: "When a playbook is not enough, take the keyboard and mouse yourself.",
  },
  {
    step: "Verify",
    body: "The next heartbeat either clears the fault or it does not. Nobody guesses.",
  },
  {
    step: "Document",
    body: "The action, the operator, the outcome and the policy decision are all recorded.",
  },
];

function LoopSection() {
  return (
    <Section id="loop">
      <SectionHeading
        eyebrow="How it works"
        title="One loop, end to end."
        lede="Remote control is a step in this loop, not the product. The product is a continuously-updated picture of the estate that tells you which machine is broken, what is probably wrong, whether it has happened before, and what fixed it last time."
      />
      <ol className="mt-12 grid grid-cols-1 gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        {LOOP.map((s, i) => (
          <li key={s.step} className="border-t border-white/[0.12] pt-4">
            <span className="font-mono text-xs text-muted">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-2 text-sm font-semibold text-white">{s.step}</h3>
            <p className="mt-2 text-sm leading-6 text-gray-400">{s.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function ClosingSection() {
  return (
    <Section className="bg-white/[0.015]">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-pretty text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          See it on the live fleet.
        </h2>
        <p className="mt-4 text-pretty text-base leading-7 text-gray-400">
          The console is the same screen a technician uses: branch sidebar, fleet table, voice bar,
          and a remote session one click from any row.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <PrimaryLink href="/console">Open the console</PrimaryLink>
          <SecondaryLink href="/enroll">Enroll a machine</SecondaryLink>
        </div>
        <p className="mt-6 text-xs text-muted">
          Machine data needs a signed-in operator.{" "}
          <Link href="/login" className="text-gray-400 underline underline-offset-4 hover:text-white">
            Sign in
          </Link>
          .
        </p>
      </div>
    </Section>
  );
}
