import { cn } from "../lib/utils";
import type { QuickActionPattern } from "./MobileQuickActions";

const patterns: { value: QuickActionPattern; label: string }[] = [
  { value: "side-drawer", label: "Drawer" },
  { value: "bottom-sheet", label: "Sheet" },
];

interface Props {
  current: QuickActionPattern;
  onChange: (pattern: QuickActionPattern) => void;
}

export function MobileQuickActionsPatternSwitcher({ current, onChange }: Props) {
  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[200] md:hidden">
      <div className="flex items-center gap-0.5 rounded-full bg-card border border-border shadow-lg px-1 py-1">
        {patterns.map((p) => (
          <button
            key={p.value}
            onClick={() => {
              onChange(p.value);
              try { localStorage.setItem("paperclip.mobileQuickActionPattern", p.value); } catch {}
            }}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
              current === p.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
