import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/Button";

export const metadata: Metadata = {
  title: "Request a Demo",
  description:
    "See BioVerify in action. Request a demonstration of BioCheck identity verification for your organisation.",
};

export default function RequestDemoPage() {
  return (
    <section className="section-dark">
      <div className="container-edge grid min-h-[80vh] items-center py-28">
        <div className="max-w-2xl">
          <p className="eyebrow">Request a demo</p>
          <h1 className="mt-4 font-display text-4xl font-extrabold leading-tight text-cloud sm:text-5xl">
            See BioVerify in action.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-cloud/70">
            Tell us about your organisation and the environment you need to
            protect. Our team will arrange a tailored demonstration of BioCheck
            identity verification.
          </p>
          <p className="mt-4 text-sm text-cloud/50">
            The full qualified-demo request form is being built (Phase 6). In the
            meantime, reach us directly and we&rsquo;ll respond.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="mailto:hello@biochecktech.com" variant="primary" size="lg">
              Contact the team
            </ButtonLink>
            <ButtonLink href="/" variant="secondary" size="lg">
              Back to home
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
