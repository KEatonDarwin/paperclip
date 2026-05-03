import { useMemo } from "react";
import { NavLink } from "@/lib/router";
import {
  House,
  CircleDot,
  Mic,
  Users,
  Inbox,
  Youtube,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { cn } from "../lib/utils";
import { useInboxBadge } from "../hooks/useInboxBadge";

interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavItem {
  to: string;
  label: string;
  icon: typeof House;
  badge?: number;
}

export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const { selectedCompanyId } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);

  const items = useMemo<MobileNavItem[]>(
    () => [
      { to: "/dashboard", label: "Home", icon: House },
      { to: "/issues", label: "Issues", icon: CircleDot },
      { to: "/voice", label: "Voice", icon: Mic },
      { to: "/youtube", label: "YouTube", icon: Youtube },
      { to: "/agents/all", label: "Agents", icon: Users },
      { to: "/inbox", label: "Inbox", icon: Inbox, badge: inboxBadge.inbox },
    ],
    [inboxBadge.inbox],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 transition-transform duration-200 ease-out md:hidden pb-[env(safe-area-inset-bottom)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-16 grid-cols-6 px-1">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", isActive && "stroke-[2.3]")} />
                    {item.badge != null && item.badge > 0 && (
                      <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
