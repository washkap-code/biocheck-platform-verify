"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { primaryNav } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // lock body scroll when mobile menu open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300 ease-brand",
        scrolled || open
          ? "bg-midnight/95 backdrop-blur-md border-b border-white/10 shadow-[0_8px_30px_rgba(7,17,31,0.35)]"
          : "bg-transparent border-b border-transparent"
      )}
    >
      <nav className="container-edge flex h-16 items-center justify-between md:h-[72px]">
        <Logo className="w-[150px] sm:w-[168px] lg:w-[200px]" />

        {/* desktop nav */}
        <ul className="hidden items-center gap-1 lg:flex">
          {primaryNav.map((item) => (
            <li
              key={item.label}
              className="relative"
              onMouseEnter={() => setActiveMenu(item.children ? item.label : null)}
              onMouseLeave={() => setActiveMenu(null)}
            >
              <Link
                href={item.href}
                className="flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-cloud/80 transition-colors hover:text-cloud"
              >
                {item.label}
                {item.children && <ChevronDown className="h-3.5 w-3.5 opacity-60" />}
              </Link>
              {item.children && activeMenu === item.label && (
                <div className="absolute left-0 top-full min-w-[260px] pt-2">
                  <div className="rounded-lg border border-white/10 bg-graphite p-2 shadow-card-dark">
                    {item.children.map((c) => (
                      <Link
                        key={c.label}
                        href={c.href}
                        className="block rounded-md px-3 py-2 text-sm text-cloud/75 transition-colors hover:bg-white/5 hover:text-cloud"
                      >
                        {c.label}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-2 lg:flex">
          <Link
            href="/login"
            className="rounded-md px-3 py-2 text-sm font-medium text-cloud/80 transition-colors hover:text-cloud"
          >
            Sign in
          </Link>
          <ButtonLink href="/request-demo" variant="primary" size="sm">
            Request a Demo
          </ButtonLink>
        </div>

        {/* mobile toggle */}
        <button
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-cloud lg:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </nav>

      {/* mobile panel */}
      {open && (
        <div className="lg:hidden">
          <div className="container-edge max-h-[calc(100vh-4rem)] overflow-y-auto pb-8 pt-2">
            <ul className="flex flex-col gap-1">
              {primaryNav.map((item) => (
                <li key={item.label} className="border-b border-white/5 py-1">
                  <Link
                    href={item.href}
                    className="block px-1 py-2.5 text-base font-semibold text-cloud"
                    onClick={() => setOpen(false)}
                  >
                    {item.label}
                  </Link>
                  {item.children && (
                    <div className="flex flex-col gap-0.5 pb-2 pl-3">
                      {item.children.map((c) => (
                        <Link
                          key={c.label}
                          href={c.href}
                          className="py-1.5 text-sm text-cloud/70"
                          onClick={() => setOpen(false)}
                        >
                          {c.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-col gap-2">
              <ButtonLink href="/request-demo" variant="primary" size="md" onClick={() => setOpen(false)}>
                Request a Demo
              </ButtonLink>
              <ButtonLink href="/login" variant="secondary" size="md" onClick={() => setOpen(false)}>
                Sign in
              </ButtonLink>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
