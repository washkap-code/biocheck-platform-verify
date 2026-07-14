/**
 * BioCheck route + navigation map.
 * Routes are architected now; not every page is built yet (see PRODUCT_REALITY_MATRIX).
 */

export type NavLink = { label: string; href: string; note?: string };

export const primaryNav: { label: string; href: string; children?: NavLink[] }[] = [
  {
    label: "Platform",
    href: "/platform",
    children: [
      { label: "BioCheck Identity Cloud", href: "/platform" },
      { label: "BioVerify engine", href: "/platform#bioverify" },
      { label: "See BioVerify in action", href: "/platform#demo" },
    ],
  },
  {
    label: "Products",
    href: "/products/face",
    children: [
      { label: "BioFace — face & liveness", href: "/products/face" },
      { label: "Fingerprint verification", href: "/products/fingerprint" },
      { label: "BioAccess — access control", href: "/products/access" },
      { label: "BioGate — hardware", href: "/products/hardware" },
    ],
  },
  {
    label: "Solutions",
    href: "/solutions/healthcare",
    children: [
      { label: "Healthcare", href: "/solutions/healthcare" },
      { label: "Insurance & medical aid", href: "/solutions/insurance" },
      { label: "Government", href: "/solutions/government" },
      { label: "Workforce", href: "/solutions/workforce" },
      { label: "Financial services", href: "/solutions/financial-services" },
      { label: "Elections", href: "/solutions/elections" },
      { label: "Education", href: "/solutions/education" },
      { label: "Telecommunications", href: "/solutions/telecommunications" },
    ],
  },
  { label: "Developers", href: "/developers" },
  { label: "Security", href: "/security" },
  { label: "Company", href: "/company" },
];

export const footerNav: { title: string; links: NavLink[] }[] = [
  {
    title: "Platform",
    links: [
      { label: "BioCheck Identity Cloud", href: "/platform" },
      { label: "BioVerify engine", href: "/platform#bioverify" },
      { label: "Developers & API", href: "/developers" },
      { label: "Hardware — BioGate", href: "/products/hardware" },
    ],
  },
  {
    title: "Products",
    links: [
      { label: "BioFace", href: "/products/face" },
      { label: "Fingerprint", href: "/products/fingerprint" },
      { label: "BioAccess", href: "/products/access" },
    ],
  },
  {
    title: "Solutions",
    links: [
      { label: "Healthcare", href: "/solutions/healthcare" },
      { label: "Workforce", href: "/solutions/workforce" },
      { label: "Government", href: "/solutions/government" },
      { label: "Financial services", href: "/solutions/financial-services" },
    ],
  },
  {
    title: "Trust",
    links: [
      { label: "Trust Centre", href: "/trust-centre" },
      { label: "Security", href: "/security" },
      { label: "Privacy", href: "/trust-centre#privacy" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/company" },
      { label: "Case studies", href: "/case-studies" },
      { label: "Resources", href: "/resources" },
      { label: "Contact", href: "/contact" },
    ],
  },
];

/** The ten BioCheck product-family names (for lockups / reference). */
export const productFamily = [
  "BioVerify",
  "BioFace",
  "BioAccess",
  "BioHealth",
  "BioWork",
  "BioVote",
  "BioKYC",
  "BioID",
  "BioGate",
  "BioAPI",
] as const;
