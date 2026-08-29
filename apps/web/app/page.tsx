import { ButtonLink } from "../components/ui/Button";
import { SiteHeader } from "../components/marketing/SiteHeader";
import { SiteFooter } from "../components/marketing/SiteFooter";
import { LiveBranches } from "../components/marketing/LiveBranches";
import { fetchSites } from "../components/marketing/sites";
import {
  CategoryCard,
  EmberBadge,
  PrimaryLink,
  SecondaryLink,
  Section,
} from "../components/marketing/primitives";
import { ui } from "../lib/theme";

export const revalidate = 60;

export const metadata = {
  title: "IT Sentinel - Ask what's broken. Fix it without leaving the room.",
  description:
    "Live health for every Windows machine across seven branches, a voice agent that answers and acts, and remote control — one policy check, one audit trail.",
};

const CAPABILITY_CARDS = [
  {
    title: "Talk to it",
    image:
      "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=800&h=1000&q=80",
    alt: "Quiet open office with long desks",
  },
  {
    title: "Take the machine",
    image:
      "https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?auto=format&fit=crop&w=800&h=1000&q=80",
    alt: "Hands on a laptop during a remote session",
  },
  {
    title: "See it happen",
    image:
      "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=800&h=1000&q=80",
    alt: "Operations room with screens in low light",
  },
];

const PAINS = [
  "Voice is an input. Not a bypass.",
  "Every action is typed, gated, and logged.",
  "T6 is refused before anyone’s role is considered.",
  "A logged-in tab is not a human.",
];



export default async function LandingPage() {
  const sites = await fetchSites(3_000);

  return (
    <div className={ui.canvas}>
      <SiteHeader />
      <main>
        <Hero />
        <CapabilityBand />
        <FleetSection sites={sites} />
        <GovernanceSection />
        <Breakthrough />
        <ClosingSection />
      </main>
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <div className={`${ui.page} pt-6 pb-12`}>
      <div className="bg-obsidian rounded-[48px] px-6 py-20 sm:py-32 flex flex-col items-center text-center mx-auto w-full relative overflow-hidden">
        <h1 className="mt-8 max-w-4xl text-pretty text-[44px] font-semibold leading-[1.08] text-snow sm:text-[64px] lg:text-[80px] lg:leading-[1.02]">
          The agentic command center for IT.
        </h1>
        <p className="mt-6 max-w-lg text-[18px] leading-[1.5] font-normal text-mist">
          Manage your entire fleet from one unified interface. Voice commands, remote desktop, and policy checks built for AI-native teams.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <ButtonLink href="/console" className="!bg-snow !text-obsidian hover:!bg-cloud border border-transparent">
            Open the console
          </ButtonLink>
          <ButtonLink href="/enroll" variant="secondary" className="!border-iron !text-snow hover:!bg-iron">
            Enroll a machine
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}

function CapabilityBand() {
  return (
    <div id="capabilities" className={`${ui.page} pb-section`}>
      <div className="grid min-w-0 w-full grid-cols-1 gap-4 sm:grid-cols-3">
        {CAPABILITY_CARDS.map((card) => (
          <CategoryCard key={card.title} {...card} />
        ))}
      </div>
    </div>
  );
}



function FleetSection({ sites }: { sites: Awaited<ReturnType<typeof fetchSites>> }) {
  return (
    <Section id="fleet">
      <h2 className={ui.heading}>The live fleet</h2>
      <LiveBranches initial={sites} />
    </Section>
  );
}

function GovernanceSection() {
  return (
    <Section id="governance">
      <div className={`${ui.cardDark} max-w-3xl`}>
        <h2 className={`${ui.headingSm} text-snow`}>Guards first</h2>
        <ul className="mt-8 space-y-4">
          {PAINS.map((line) => (
            <li key={line} className="flex items-baseline gap-3 text-[16px] font-medium leading-[1.5] text-snow">
              <span aria-hidden>→</span>
              {line}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function Breakthrough() {
  return (
    <div className={`${ui.page} pb-0`}>
      <div className="w-full min-w-0 overflow-clip rounded-t-[64px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=2000&h=900&q=80"
          alt=""
          className={ui.breakthrough}
        />
      </div>
    </div>
  );
}

function ClosingSection() {
  return (
    <Section>
      <h2 className={ui.heading}>See it on the fleet.</h2>
      <div className="mt-8">
        <PrimaryLink href="/console">Open the console</PrimaryLink>
      </div>
    </Section>
  );
}
