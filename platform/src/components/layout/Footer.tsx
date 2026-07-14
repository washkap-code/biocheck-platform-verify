import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { footerNav } from "@/lib/navigation";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="section-dark border-t border-white/10">
      <div className="container-edge py-16">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_repeat(5,1fr)]">
          <div className="max-w-xs">
            <Logo className="w-[210px]" />
            <p className="mt-5 text-sm leading-relaxed text-cloud/60">
              Trusted identity infrastructure for Africa. Founded in Zimbabwe, built for
              African operating environments and international scale.
            </p>
            <p className="mt-4 font-display text-sm font-semibold text-cyan">
              Trust who&rsquo;s there.
            </p>
          </div>

          {footerNav.map((col) => (
            <div key={col.title}>
              <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-cloud/40">
                {col.title}
              </h3>
              <ul className="mt-4 flex flex-col gap-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-cloud/70 transition-colors hover:text-cyan"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-white/10 pt-8 text-xs text-cloud/45 md:flex-row md:items-center md:justify-between">
          <p>&copy; {year} BioCheck Technologies. All rights reserved.</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/trust-centre" className="hover:text-cloud/80">
              Trust Centre
            </Link>
            <Link href="/security" className="hover:text-cloud/80">
              Security
            </Link>
            <Link href="/trust-centre#privacy" className="hover:text-cloud/80">
              Privacy
            </Link>
            <Link href="/contact" className="hover:text-cloud/80">
              Contact
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
