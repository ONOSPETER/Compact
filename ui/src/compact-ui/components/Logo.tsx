/** The Compact mark. It inverts with the theme: a black tile with a white mark, or the reverse. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Compact">
      <rect width="100" height="100" rx="26" fill="var(--inv)" />
      <g fill="none" stroke="var(--inv-ink)" strokeLinecap="round">
        <path d="M70.3 33A26.5 26.5 0 1 0 70.3 67" strokeWidth="10" />
        <path d="M60.9 40.8A14.25 14.25 0 1 0 60.9 59.2" strokeWidth="4.5" />
      </g>
      <circle cx="74.5" cy="50" r="4.5" fill="var(--inv-ink)" />
    </svg>
  );
}
