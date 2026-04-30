import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === "boolean")
    return <span className={value ? "text-green-500" : "text-red-500"}>{String(value)}</span>;
  if (typeof value === "number")
    return <span className="text-blue-500 dark:text-blue-400">{String(value)}</span>;
  if (typeof value === "string")
    return <span className="text-amber-600 dark:text-amber-400">"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">[]</span>;
    return (
      <span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-0.5 hover:text-foreground text-muted-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          [{value.length}]
        </button>
        {open && (
          <div className="ml-4 border-l border-border pl-2">
            {value.map((v, i) => (
              <div key={i} className="flex gap-1">
                <span className="text-muted-foreground text-xs shrink-0">{i}</span>
                <span className="text-muted-foreground">:</span>
                <JsonNode value={v} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return <span className="text-muted-foreground">{"{}"}</span>;
    return (
      <span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-0.5 hover:text-foreground text-muted-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {"{" + keys.length + "}"}
        </button>
        {open && (
          <div className="ml-4 border-l border-border pl-2">
            {keys.map((k) => (
              <div key={k} className="flex gap-1 flex-wrap">
                <span className="text-foreground font-medium text-xs shrink-0">"{k}"</span>
                <span className="text-muted-foreground">:</span>
                <JsonNode value={(value as Record<string, unknown>)[k]} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}
