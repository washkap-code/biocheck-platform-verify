import { ButtonLink } from "@/components/ui/Button";
import { BioCheckMark } from "@/components/brand/Logo";
import {
  Fingerprint,
  ScanFace,
  Eye,
  FileCheck2,
  KeyRound,
  Smartphone,
  MapPin,
  Workflow,
  HeartPulse,
  Users,
  Landmark,
  Banknote,
  ShieldCheck,
  Lock,
  Server,
  Code2,
  Cpu,
  ArrowRight,
  Layers,
} from "lucide-react";

/* ---------- shared bits ---------- */

function Eyebrow({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <p className="eyebrow">{children}</p>;
}

function SectionHeading({
  eyebrow,
  title,
  lede,
  dark = false,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: string;
  dark?: boolean;
}) {
  return (
    <div className="max-w-3xl">
      <p className="eyebrow">{eyebrow}</p>
      <h2
        className={`mt-4 font-display text-3xl font-bold leading-tight sm:text-4xl ${
          dark ? "text-cloud" : "text-midnight"
        }`}
      >
        {title}
      </h2>
      {lede && (
        <p className={`mt-5 text-lg leading-relaxed ${dark ? "text-cloud/70" : "text-slate"}`}>
          {lede}
        </p>
      )}
    </div>
  );
}

/* ---------- 1. Core capabilities ---------- */

const capabilities = [
  { icon: Fingerprint, name: "Fingerprint", desc: "Fast, familiar verification for everyday high-volume checks." },
  { icon: ScanFace, name: "Face", desc: "Contactless facial verification for member and workforce identity." },
  { icon: Eye, name: "Liveness", desc: "Presentation-attack checks designed to confirm a real, present person." },
  { icon: FileCheck2, name: "Documents", desc: "Identity-document capture and validation for onboarding and KYC." },
  { icon: KeyRound, name: "PIN & OTP", desc: "Knowledge and one-time-code factors for step-up verification." },
  { icon: Smartphone, name: "Device trust", desc: "Recognise known devices and flag unfamiliar ones." },
  { icon: MapPin, name: "Location context", desc: "Add where a verification happened to every decision." },
  { icon: Workflow, name: "Orchestration", desc: "Combine factors by risk and use case with a configurable rules engine." },
];

export function CapabilitiesSection() {
  return (
    <section className="section-light border-t border-line">
      <div className="container-edge py-24">
        <SectionHeading
          eyebrow="Core verification capabilities"
          title="Every factor you need to know who's really there."
          lede="BioVerify brings the modalities of trusted identity into one platform — used on their own, or combined into layered verification for higher-risk moments."
        />
        <div className="mt-14 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {capabilities.map(({ icon: Icon, name, desc }) => (
            <div key={name} className="bg-cloud p-6 transition-colors hover:bg-white">
              <Icon className="h-6 w-6 text-cyan" strokeWidth={1.6} />
              <h3 className="mt-4 font-display text-lg font-semibold text-midnight">{name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- 2. Identity Cloud architecture ---------- */

const architecture = [
  { label: "BioCheck Identity Cloud", note: "One multi-tenant identity platform" },
  { label: "BioVerify engine", note: "Enrolment · matching · workflows · audit" },
  { label: "Verification modalities", note: "Fingerprint · Face · Liveness · Documents · PIN/OTP · Device · Location" },
  { label: "Industry solutions", note: "Configured for healthcare, workforce, access, government, financial services" },
];

export function IdentityCloudSection() {
  return (
    <section className="section-dark relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-0 h-[520px] w-[520px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(118,87,255,0.10), transparent 70%)" }}
      />
      <div className="container-edge relative py-24">
        <SectionHeading
          dark
          eyebrow="One platform"
          title="The BioCheck Identity Cloud."
          lede="One identity platform, one verification engine, configured for every critical environment — instead of disconnected point tools."
        />
        <div className="mt-14 grid gap-4 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div className="flex flex-col gap-3">
            {architecture.map((row, i) => (
              <div
                key={row.label}
                className="rounded-lg border border-white/10 bg-white/[0.03] p-5"
                style={{ marginLeft: `${i * 16}px` }}
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-cyan">{String(i + 1).padStart(2, "0")}</span>
                  <span className="font-display font-semibold text-cloud">{row.label}</span>
                </div>
                <p className="mt-1 pl-7 text-sm text-cloud/60">{row.note}</p>
              </div>
            ))}
          </div>
          <div className="flex justify-center">
            <div className="relative flex aspect-square w-full max-w-[380px] items-center justify-center rounded-[28px] border border-white/10 bg-white/[0.02]">
              <Layers className="absolute left-6 top-6 h-5 w-5 text-cyan/70" />
              <BioCheckMark className="h-36 w-36" />
              <span className="absolute bottom-6 font-mono text-[11px] uppercase tracking-[0.2em] text-cloud/40">
                Identity orchestration
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- 3. See BioVerify in action (teaser) ---------- */

export function DemoTeaserSection() {
  return (
    <section className="section-graphite">
      <div className="container-edge py-20">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div className="max-w-2xl">
            <p className="eyebrow">See BioVerify in action</p>
            <h2 className="mt-4 font-display text-3xl font-bold text-cloud sm:text-4xl">
              Feel the verification work: Detect → Scan → Confirm → Match.
            </h2>
            <p className="mt-4 text-cloud/65">
              Try an interactive product simulation of face and fingerprint verification.{" "}
              <span className="text-cloud/50">
                Interactive product simulation. No biometric data is captured or stored.
              </span>
            </p>
          </div>
          <ButtonLink href="/platform#demo" variant="primary" size="lg" className="shrink-0">
            Launch the demo <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

/* ---------- 4. Priority industry solutions ---------- */

const solutions = [
  { icon: HeartPulse, tag: "BioHealth", title: "Healthcare & medical aid", outcome: "Stop paying for care delivered to the wrong person.", href: "/solutions/healthcare" },
  { icon: Users, tag: "BioWork", title: "Workforce identity", outcome: "Know who is actually at work, and when.", href: "/solutions/workforce" },
  { icon: ShieldCheck, tag: "BioAccess", title: "Secure access", outcome: "Know who entered, when, and whether they were authorised.", href: "/solutions/access" },
  { icon: Landmark, tag: "Government", title: "Public services", outcome: "Confirm the authorised person for high-trust services.", href: "/solutions/government" },
  { icon: Banknote, tag: "BioKYC", title: "Financial services & KYC", outcome: "Make verified identity part of high-risk transactions.", href: "/solutions/financial-services" },
];

export function SolutionsSection() {
  return (
    <section className="section-light border-t border-line">
      <div className="container-edge py-24">
        <SectionHeading
          eyebrow="Priority solutions"
          title="One platform. Every critical environment."
          lede="BioCheck sells outcomes, not biometric technology. Each solution is BioVerify, configured for the trust decisions that matter in that sector."
        />
        <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {solutions.map(({ icon: Icon, tag, title, outcome, href }) => (
            <a
              key={title}
              href={href}
              className="group flex flex-col rounded-lg border border-line bg-cloud p-7 transition-all hover:-translate-y-0.5 hover:border-slate/40 hover:shadow-card"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-midnight/[0.04]">
                  <Icon className="h-5 w-5 text-cyan" strokeWidth={1.6} />
                </span>
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-slate">{tag}</span>
              </div>
              <h3 className="mt-5 font-display text-xl font-semibold text-midnight">{title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-slate">{outcome}</p>
              <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-cyan">
                Explore <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- 5. Enterprise platform + console preview ---------- */

const platformFeatures = [
  "Identity enrolment & matching",
  "Configurable verification workflows",
  "Organisation, tenant & location management",
  "Device management & API keys",
  "Rules engine & review queues",
  "Immutable audit trails & analytics",
  "Role-based access control",
  "Configurable retention & data residency",
];

export function EnterprisePlatformSection() {
  return (
    <section className="section-dark">
      <div className="container-edge py-24">
        <SectionHeading
          dark
          eyebrow="BioVerify enterprise platform"
          title="Operational identity infrastructure — not a black box."
          lede="Every verification event records who, when, where, method, result and risk signals. BioVerify is designed to show its work, so teams can trust and audit every decision."
        />
        <div className="mt-14 grid gap-10 lg:grid-cols-2 lg:items-start">
          <ul className="grid gap-3 sm:grid-cols-2">
            {platformFeatures.map((f) => (
              <li key={f} className="flex items-start gap-3 rounded-md border border-white/10 bg-white/[0.03] p-4">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green" />
                <span className="text-sm text-cloud/80">{f}</span>
              </li>
            ))}
          </ul>

          {/* console preview mock */}
          <div className="overflow-hidden rounded-xl border border-white/10 bg-graphite shadow-card-dark">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
              <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
              <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
              <span className="ml-3 font-mono text-xs text-cloud/50">Enterprise Console — Overview</span>
            </div>
            <div className="grid grid-cols-3 gap-3 p-5">
              {[
                { k: "Verifications today", v: "—" },
                { k: "Successful matches", v: "—" },
                { k: "Flagged events", v: "—" },
                { k: "Active locations", v: "—" },
                { k: "Active devices", v: "—" },
                { k: "Avg. verify time", v: "—" },
              ].map((c) => (
                <div key={c.k} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="data text-xl font-semibold text-cloud">{c.v}</div>
                  <div className="mt-1 text-[11px] leading-tight text-cloud/50">{c.k}</div>
                </div>
              ))}
            </div>
            <p className="px-5 pb-5 font-mono text-[11px] text-cloud/40">
              Illustrative console preview · seeded demo data
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- 6. Hardware (BioGate) ---------- */

const bioGate = [
  "BioGate One — desktop fingerprint terminal",
  "BioGate Face — facial verification tablet",
  "BioGate Access — wall-mounted access device",
  "BioGate Mobile — rugged mobile kit",
  "BioGate Station — enrolment workstation",
];

export function HardwareSection() {
  return (
    <section className="section-light border-t border-line">
      <div className="container-edge py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionHeading
              eyebrow="BioGate hardware"
              title="The intelligence is BioCheck. The device is an endpoint."
              lede="BioCheck certifies and integrates trusted hardware rather than manufacturing it — so the same verification intelligence runs across terminals, tablets and access points."
            />
            <p className="mt-6 font-mono text-xs text-slate">
              Concept hardware family. Specifications and availability confirmed once OEM devices are selected and tested.
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            {bioGate.map((d) => (
              <li key={d} className="flex items-center gap-3 rounded-lg border border-line bg-cloud p-4">
                <Cpu className="h-5 w-5 shrink-0 text-cyan" strokeWidth={1.6} />
                <span className="text-sm text-midnight">{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ---------- 7. Developers / API ---------- */

export function DevelopersSection() {
  return (
    <section className="section-dark">
      <div className="container-edge py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionHeading
              dark
              eyebrow="Developers & API"
              title="Build verified identity into any system."
              lede="BioAPI is designed to let integrators and product teams add BioVerify to onboarding, access and transaction flows through clean APIs, SDKs and webhooks."
            />
            <div className="mt-8">
              <ButtonLink href="/developers" variant="secondary" size="md">
                Explore the developer platform <ArrowRight className="h-4 w-4" />
              </ButtonLink>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-graphite">
            <div className="border-b border-white/10 px-4 py-3 font-mono text-xs text-cloud/50">
              POST /v1/verify
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-cloud/80">
{`{
  "subject_id": "mbr_2Y…",
  "factors": ["face", "liveness"],
  "context": { "location": "harare-cbd" }
}

→ 200 OK
{
  "result": "verified",   // illustrative
  "factors_passed": ["face", "liveness"],
  "audit_id": "evt_…"
}`}
            </pre>
            <p className="px-5 pb-5 font-mono text-[11px] text-cloud/40">
              Illustrative request/response · not production data
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- 8. Trust & privacy ---------- */

const trustPrinciples = [
  { icon: Lock, t: "Protected templates", d: "Biometric data handled as protected templates, not raw images, by design." },
  { icon: ShieldCheck, t: "Privacy by design", d: "Purpose limitation, data minimisation and configurable retention built in." },
  { icon: Server, t: "Tenant isolation & residency", d: "Designed for tenant isolation and data-residency controls for sovereign needs." },
  { icon: Eye, t: "Human review", d: "Disputed outcomes can route to human review — verification supports people, not surveillance." },
];

export function TrustSection() {
  return (
    <section className="section-light border-t border-line">
      <div className="container-edge py-24">
        <SectionHeading
          eyebrow="Trust & privacy"
          title="Trust is product architecture — not a footer page."
          lede="BioCheck treats consent, privacy and auditability as core parts of the platform. The Trust Centre separates implemented controls, planned controls and independent certifications."
        />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {trustPrinciples.map(({ icon: Icon, t, d }) => (
            <div key={t} className="rounded-lg border border-line bg-cloud p-6">
              <Icon className="h-6 w-6 text-violet" strokeWidth={1.6} />
              <h3 className="mt-4 font-display text-base font-semibold text-midnight">{t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate">{d}</p>
            </div>
          ))}
        </div>
        <div className="mt-10">
          <ButtonLink href="/trust-centre" variant="outline" size="md">
            Visit the Trust Centre <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

/* ---------- 9. Founded in Zimbabwe ---------- */

export function ZimbabweSection() {
  return (
    <section className="section-dark">
      <div className="container-edge py-24">
        <div className="max-w-3xl">
          <p className="eyebrow">Founded in Zimbabwe</p>
          <h2 className="mt-4 font-display text-3xl font-bold leading-tight text-cloud sm:text-4xl">
            Built for African operating environments — designed for the world.
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-cloud/70">
            BioCheck Technologies is a standalone identity-technology company founded in Zimbabwe. We build for
            the realities of African infrastructure — intermittent connectivity, diverse devices, high-trust
            public and enterprise environments — with an architecture ready to scale across the continent and
            internationally.
          </p>
          <p className="mt-5 font-display text-lg font-semibold text-cyan">
            The identity trust layer for Africa.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ---------- 10. Final CTA ---------- */

export function FinalCtaSection() {
  return (
    <section className="section-dark relative overflow-hidden border-t border-white/10">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[820px] -translate-x-1/2 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(24,215,232,0.10), transparent 70%)" }}
      />
      <div className="container-edge relative py-28 text-center">
        <BioCheckMark className="mx-auto h-14 w-14" />
        <h2 className="mx-auto mt-8 max-w-3xl font-display text-4xl font-extrabold leading-tight text-cloud sm:text-5xl">
          Know who&rsquo;s really there.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-cloud/70">
          See how BioCheck can bring trusted identity verification to your organisation.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/request-demo" variant="primary" size="lg">
            Request a Demo
          </ButtonLink>
          <ButtonLink href="/platform#demo" variant="secondary" size="lg">
            See BioVerify in Action
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
