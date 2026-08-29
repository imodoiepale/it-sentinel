/**
 * Awesomic register: zinc grid, hairline borders, ember used only as
 * punctuation. Import these class strings instead of restating hex or
 * radii in components.
 */

export const colors = {
  obsidian: "#09090b",
  graphite: "#18181b",
  slate: "#27272a",
  iron: "#3f3f46",
  steel: "#52525b",
  fog: "#71717a",
  ash: "#a1a1aa",
  mist: "#d4d4d8",
  cloud: "#ececee",
  paper: "#f4f4f5",
  snow: "#ffffff",
  ember: "#ff5a00",
  magentaSpark: "#fe45e2",
  quiet: "#fafafa",
  buttonRing: "#2c2e34",
} as const;

export const radii = {
  cards: "36px",
  icons: "40px",
  pills: "10000px",
  badges: "12px",
  inputs: "14px",
  buttons: "14px",
  breakthrough: "64px",
} as const;

export const type = {
  caption: "text-[12px] leading-[1.64] font-normal",
  body: "text-[15px] leading-[1.45] font-normal",
  bodyLg: "text-[18px] leading-[1.5] font-normal",
  subheading: "text-[20px] leading-[1.4] font-semibold",
  headingSm: "text-[28px] leading-[1.25] font-semibold sm:text-[32px]",
  heading: "text-[32px] leading-[1.2] font-semibold sm:text-[40px]",
  headingLg: "text-[40px] leading-[1.15] font-semibold sm:text-[56px]",
  display: "text-[44px] leading-[1.08] font-semibold sm:text-[64px] lg:text-[80px] lg:leading-[1.02]",
} as const;

export const shadows = {
  subtle:
    "rgba(255, 255, 255, 0.5) 0px 0.5px 0px 0px inset, rgba(117, 123, 133, 0.4) 0px 9px 14px -5px inset, rgb(44, 46, 52) 0px 0px 0px 1.5px, rgba(0, 0, 0, 0.14) 0px 4px 6px 0px",
  subtle2: "rgb(228, 228, 231) 0px 1px 0px 0px inset",
  subtle3: "rgb(255, 255, 255) 0px 0.5px 0px 0px inset",
  subtle4: "rgb(255, 255, 255) 0px -0.5px 0px 0px",
  subtle5: "rgb(228, 228, 231) 0px -1px 0px 0px",
  md: "rgba(0, 0, 0, 0.04) 0px 4px 12px 0px",
} as const;

/** Layout and component class constants — reuse these, do not duplicate. */
export const ui = {
  canvas: "bg-paper text-graphite font-sans antialiased",
  page: "mx-auto w-full min-w-0 max-w-page dummy-test-class-999 px-6 lg:px-8",
  section: "py-section",
  header:
    "sticky top-0 z-50 bg-snow/90 backdrop-blur-md",
  navLink: "text-[14px] font-normal text-graphite transition-opacity duration-200 hover:opacity-70",
  card: "rounded-cards border border-cloud bg-snow p-card",
  cardFlush:
    "min-w-0 w-full overflow-clip rounded-[36px] border border-cloud bg-snow",
  photo: "block aspect-[4/5] w-full max-w-full object-cover object-center",
  photoWell: "relative w-full overflow-clip bg-mist",
  breakthrough: "block h-36 w-full max-w-full object-cover object-center sm:h-40",
  cardDark: "rounded-cards bg-slate p-6 text-snow",
  cardQuiet: "rounded-cards border border-cloud bg-quiet p-card",
  input:
    "w-full rounded-inputs border border-transparent bg-snow px-4 py-3 text-[14px] text-graphite placeholder:text-ash shadow-[inset_0_1px_0_0_rgb(228,228,231)]",
  tag: "inline-flex items-center rounded-badges border border-cloud px-2 py-1 text-[13px] font-normal text-graphite",
  tagFilled: "inline-flex items-center rounded-badges bg-iron px-2 py-1 text-[12px] font-normal text-quiet",
  tagEmber: "inline-flex items-center rounded-badges bg-ember px-2 py-1 text-[12px] font-medium text-snow",
  eyebrow: "text-[12px] font-normal text-fog",
  display:
    "text-[44px] leading-[1.08] font-semibold text-obsidian sm:text-[64px] lg:text-[80px] lg:leading-[1.02]",
  heading: "text-[32px] leading-[1.2] font-semibold text-obsidian sm:text-[40px]",
  headingSm: "text-[28px] leading-[1.25] font-semibold text-obsidian sm:text-[32px]",
  subheading: "text-[20px] leading-[1.4] font-semibold text-obsidian",
  body: "text-[15px] leading-[1.45] font-normal text-graphite",
  muted: "text-[15px] leading-[1.45] font-normal text-steel",
  caption: "text-[12px] leading-[1.64] font-normal text-fog",
  lede: "text-[18px] leading-[1.5] font-normal text-steel",
  stat: "text-[56px] font-semibold leading-[1.28] text-obsidian max-sm:text-[40px]",
  statLabel: "text-[14px] font-normal leading-[1.45] text-steel",
} as const;
