import { ui } from "../../lib/theme";
import { ButtonLink } from "../ui/Button";

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className={ui.eyebrow}>{children}</p>;
}

export function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={className}>
      <div className={`${ui.page} ${ui.section}`}>{children}</div>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <div className="max-w-2xl">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className={`mt-3 text-pretty ${ui.heading}`}>{title}</h2>
      {lede && <p className={`mt-4 text-pretty ${ui.lede}`}>{lede}</p>}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`${ui.card} ${className}`}>{children}</div>;
}

export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <ButtonLink href={href} variant="primary">
      {children}
    </ButtonLink>
  );
}

export function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <ButtonLink href={href} variant="secondary">
      {children}
    </ButtonLink>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return <span className={ui.tag}>{children}</span>;
}

export function EmberBadge({ children }: { children: React.ReactNode }) {
  return <span className={ui.tagEmber}>{children}</span>;
}

export function CategoryCard({
  title,
  tags = [],
  image,
  alt,
  badge,
}: {
  title: string;
  tags?: string[];
  image: string;
  alt: string;
  badge?: string;
}) {
  return (
    <article className={ui.cardFlush}>
      <div className={ui.photoWell}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt={alt} className={ui.photo} />
        {badge ? (
          <span className="pointer-events-none absolute left-4 top-4">
            <EmberBadge>{badge}</EmberBadge>
          </span>
        ) : null}
      </div>
      <div className="px-card py-5">
        <h3 className={ui.subheading}>{title}</h3>
        {tags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function LivePip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <EmberBadge>Live</EmberBadge>
      <span className={ui.caption}>{label}</span>
    </span>
  );
}
