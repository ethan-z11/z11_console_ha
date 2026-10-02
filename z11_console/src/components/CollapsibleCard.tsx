import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface CollapsibleCardProps {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  description?: ReactNode;
}

/** 设置页可折叠板块：默认收起只显示标题行，点标题行展开内容。 */
export function CollapsibleCard({ icon: Icon, title, children, defaultOpen = false, description }: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`settings-card settings-card--collapse${open ? ' settings-card--open' : ''}`}>
      <button type="button" className="settings-card__bar" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="tile__chip"><Icon size={20} /></span>
        <h3>{title}</h3>
        <ChevronDown size={18} className="settings-card__chevron" aria-hidden />
      </button>
      {open && <div className="settings-card__panel">{description}{children}</div>}
    </section>
  );
}
