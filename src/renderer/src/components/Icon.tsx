import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  History,
  Minus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
  ArrowLeftRight,
  FileText,
  Lock,
  Settings,
  SquarePen,
  Users,
  type LucideIcon,
} from "lucide-react";

// One place to change an icon: swap the lucide import here and every screen follows.
const ICONS = {
  add: Plus,
  minus: Minus,
  close: X,
  edit: Pencil,
  delete: Trash2,
  history: History,
  check: Check,
  up: ChevronUp,
  down: ChevronDown,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  search: Search,
  entry: SquarePen,
  accounts: Users,
  transactions: ArrowLeftRight,
  templates: FileText,
  settings: Settings,
  lock: Lock,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** Size comes from --icon-size (CSS), colour from currentColor, so density and light/dark just work. */
export default function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  const C = ICONS[name];
  return (
    <C
      className={className ? `ic ${className}` : "ic"}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}
