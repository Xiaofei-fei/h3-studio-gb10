import type { ReactNode } from 'react';

export interface DisclosureSectionProps {
  id: string;
  label: string;
  summary: ReactNode;
  icon?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

function ChevronIcon() {
  return (
    <svg className="disclosure-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

export function DisclosureSection({
  id,
  label,
  summary,
  icon,
  open,
  onOpenChange,
  children,
  className,
}: DisclosureSectionProps) {
  const contentId = `${id}-content`;
  const headingId = `${id}-label`;
  const classes = ['disclosure-section', open ? 'is-open' : '', className || ''].filter(Boolean).join(' ');

  return (
    <section className={classes} aria-labelledby={headingId}>
      <button
        type="button"
        className="disclosure-trigger"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
      >
        {icon && <span className="disclosure-icon" aria-hidden="true">{icon}</span>}
        <span className="disclosure-copy">
          <strong id={headingId}>{label}</strong>
          <small>{summary}</small>
        </span>
        <ChevronIcon />
      </button>
      <div id={contentId} className="disclosure-content" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
