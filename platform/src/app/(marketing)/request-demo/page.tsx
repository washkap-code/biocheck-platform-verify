import type { Metadata } from "next";
import { DemoRequestForm } from "@/components/marketing/DemoRequestForm";

export const metadata: Metadata = {
  title: "Request a Demo",
  description:
    "See BioVerify in action. Request a demonstration of BioCheck identity verification for your organisation.",
};

export default function RequestDemoPage() {
  return (
    <section className="section-dark">
      <div className="container-edge grid gap-14 py-28 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
        <div>
          <p className="eyebrow">Request a demo</p>
          <h1 className="mt-4 font-display text-4xl font-extrabold leading-tight text-cloud sm:text-5xl">
            See BioVerify in action.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-cloud/70">
            Tell us about your organisation and the environment you need to
            protect. Our team will arrange a tailored demonstration of BioCheck
            identity verification.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cloud/50">
            Demonstrations use simulated data — no biometric data is captured
            or stored during a demo. Prefer email? Reach us at{" "}
            <a href="mailto:hello@biochecktech.com" className="text-cyan hover:underline">
              hello@biochecktech.com
            </a>
            .
          </p>
        </div>
        <div className="rounded-2xl border border-cloud/10 bg-cloud/[0.03] p-8 sm:p-10">
          <DemoRequestForm />
        </div>
      </div>
    </section>
  );
}
