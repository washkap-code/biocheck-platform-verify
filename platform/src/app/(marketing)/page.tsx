import { ButtonLink } from "@/components/ui/Button";
import { BioCheckMark } from "@/components/brand/Logo";
import { Fingerprint, ScanFace, ShieldCheck } from "lucide-react";
import {
  CapabilitiesSection,
  IdentityCloudSection,
  DemoTeaserSection,
  SolutionsSection,
  EnterprisePlatformSection,
  HardwareSection,
  DevelopersSection,
  TrustSection,
  ZimbabweSection,
  FinalCtaSection,
} from "@/components/sections/HomeSections";

const industryQuestions = [
  { sector: "Healthcare", question: "Is this the registered member?" },
  { sector: "Workplace", question: "Is this employee actually here?" },
  { sector: "Government", question: "Is this the authorised visitor?" },
  { sector: "Financial services", question: "Is this the account holder?" },
  { sector: "Elections", question: "Is this the registered voter?" },
];

const capabilities = [
  { icon: Fingerprint, label: "Fingerprint" },
  { icon: ScanFace, label: "Face & liveness" },
  { icon: ShieldCheck, label: "Identity intelligence" },
];

export default function HomePage() {
  return (
    <>
      {/* ---------------------------------------------------------- HERO */}
      <section className="section-dark relative overflow-hidden">
        {/* ambient light, no random gradients — restrained radial glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 h-[640px] w-[640px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(24,215,232,0.10), transparent 70%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-52 -left-40 h-[560px] w-[560px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(118,87,255,0.08), transparent 70%)",
          }}
        />

        <div className="container-edge relative grid min-h-[92vh] items-center gap-12 pt-28 pb-20 lg:grid-cols-[1.1fr_0.9fr] lg:pt-24">
          <div className="animate-fade-up">
            <p className="eyebrow">Trusted identity infrastructure for Africa</p>
            <h1 className="mt-5 font-display text-5xl font-extrabold leading-[1.02] tracking-tight text-cloud sm:text-6xl lg:text-7xl">
              Trust who&rsquo;s <span className="text-cyan">there.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-cloud/75">
              Biometric identity infrastructure for a world where knowing who is
              really there matters.
            </p>
            <p className="mt-4 font-display font-semibold text-cloud/90">
              Fingerprint. Face. Liveness. Identity intelligence.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <ButtonLink href="/request-demo" variant="primary" size="lg">
                Request a Demo
              </ButtonLink>
              <ButtonLink href="/platform#demo" variant="secondary" size="lg">
                See BioVerify in Action
              </ButtonLink>
            </div>

            <ul className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-3">
              {capabilities.map(({ icon: Icon, label }) => (
                <li
                  key={label}
                  className="flex items-center gap-2 text-sm text-cloud/60"
                >
                  <Icon className="h-4 w-4 text-cyan" />
                  {label}
                </li>
              ))}
            </ul>
          </div>

          {/* scanning-frame motif around the approved mark */}
          <div className="hidden justify-center lg:flex">
            <div className="relative aspect-square w-full max-w-[440px]">
              <div className="absolute inset-0 rounded-[28px] border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent" />
              {/* scan-frame corner brackets */}
              <span aria-hidden className="absolute left-5 top-5 h-9 w-9 rounded-tl-xl border-l-2 border-t-2 border-cyan/70" />
              <span aria-hidden className="absolute right-5 top-5 h-9 w-9 rounded-tr-xl border-r-2 border-t-2 border-cyan/70" />
              <span aria-hidden className="absolute bottom-5 left-5 h-9 w-9 rounded-bl-xl border-b-2 border-l-2 border-cyan/70" />
              <span aria-hidden className="absolute bottom-5 right-5 h-9 w-9 rounded-br-xl border-b-2 border-r-2 border-cyan/70" />
              {/* soft scan line */}
              <div
                aria-hidden
                className="absolute inset-x-10 h-px bg-gradient-to-r from-transparent via-cyan to-transparent animate-scanline"
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <BioCheckMark className="h-44 w-44" />
              </div>
              <span className="absolute bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.24em] text-cloud/45">
                Detect · Scan · Confirm · Match
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ THE CENTRAL QUESTION */}
      <section className="section-light">
        <div className="container-edge py-24">
          <div className="max-w-3xl">
            <p className="eyebrow text-cyan">The question behind everything</p>
            <h2 className="mt-4 font-display text-3xl font-bold leading-tight text-midnight sm:text-4xl">
              Every critical interaction begins with one question:{" "}
              <span className="text-slate">Is this really the right person?</span>
            </h2>
          </div>

          <div className="mt-14 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
            {industryQuestions.map((item) => (
              <div
                key={item.sector}
                className="bg-cloud p-6 transition-colors hover:bg-white"
              >
                <p className="font-mono text-xs uppercase tracking-[0.14em] text-cyan">
                  {item.sector}
                </p>
                <p className="mt-3 font-display text-lg font-semibold leading-snug text-midnight">
                  {item.question}
                </p>
              </div>
            ))}
          </div>

          <p className="mt-12 font-display text-2xl font-bold text-midnight">
            BioCheck provides the answer.{" "}
            <span className="font-normal text-slate">
              One identity platform. Every critical environment.
            </span>
          </p>
        </div>
      </section>

      {/* -------------------------------------------------- HOMEPAGE SEQUENCE */}
      <CapabilitiesSection />
      <IdentityCloudSection />
      <DemoTeaserSection />
      <SolutionsSection />
      <EnterprisePlatformSection />
      <HardwareSection />
      <DevelopersSection />
      <TrustSection />
      <ZimbabweSection />
      <FinalCtaSection />
    </>
  );
}
