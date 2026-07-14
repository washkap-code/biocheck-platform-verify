import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * BioCheck logo — APPROVED Concept 1 assets, used VERBATIM from the supplied SVG files.
 * Do NOT redraw, recolour, add glow/shadow/border, or substitute an icon-library glyph.
 * Source files live in /public/brand (copied from BioCheck_Brand_Asset_Kit_Revised_Concept_1).
 */

/** Full horizontal lockup for dark backgrounds (BIOCHECK + TECHNOLOGIES). Links to home. */
export function Logo({
  href = "/",
  className,
}: {
  href?: string | null;
  className?: string;
}) {
  // eslint-disable-next-line @next/next/no-img-element
  const img = (
    <img
      src="/brand/biocheck-primary-dark.svg"
      alt="BioCheck Technologies"
      className={cn("block h-auto w-auto select-none", className)}
      draggable={false}
    />
  );
  if (href) {
    return (
      <Link
        href={href}
        aria-label="BioCheck Technologies — home"
        className="inline-flex shrink-0"
      >
        {img}
      </Link>
    );
  }
  return img;
}

/** Full lockup for light backgrounds. */
export function LogoLight({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src="/brand/biocheck-primary-light.svg"
      alt="BioCheck Technologies"
      className={cn("block h-auto w-auto select-none", className)}
      draggable={false}
    />
  );
}

/** Approved symbol only (transparent) for compact placements. Size via className (h-/w-). */
export function BioCheckMark({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src="/brand/biocheck-icon.svg"
      alt="BioCheck"
      className={cn("select-none", className)}
      draggable={false}
    />
  );
}
