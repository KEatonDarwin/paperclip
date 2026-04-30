import type { LucideIcon } from "lucide-react";
import { Terminal, Wrench } from "lucide-react";

/**
 * Registry entry for a developer page in the Developers sidebar section.
 *
 * There are two kinds:
 * - "playground": uses the DevPlayground template component (tool catalog + runner).
 *   Supply `toolsModule` — a dynamic import pointing to a file that default-exports
 *   a DevPlaygroundProps-compatible config object.
 * - "custom": a standalone page component (like ApiRunner) that doesn't use the template.
 *   Supply `component` — a lazy-loadable React component.
 */

export interface DevPageEntry {
  slug: string;
  label: string;
  icon: LucideIcon;
  kind: "playground" | "custom";
}

export const DEV_PAGES: DevPageEntry[] = [
  {
    slug: "api-runner",
    label: "API Runner",
    icon: Terminal,
    kind: "custom",
  },
  {
    slug: "shim-runner",
    label: "SHIM Runner",
    icon: Wrench,
    kind: "playground",
  },
];
