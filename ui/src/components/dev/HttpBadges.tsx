import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: "text-green-700 dark:text-green-400",
  POST: "text-blue-700 dark:text-blue-400",
  PATCH: "text-amber-700 dark:text-amber-400",
  PUT: "text-purple-700 dark:text-purple-400",
  DELETE: "text-red-700 dark:text-red-400",
};

export function MethodBadge({ method }: { method: HttpMethod }) {
  return <span className={`text-xs font-mono font-bold ${METHOD_COLORS[method]}`}>{method}</span>;
}

export function HttpStatusBadge({ status }: { status: number | null }) {
  if (status === null)
    return (
      <span className="text-xs text-muted-foreground flex items-center gap-1">
        <AlertCircle className="h-3.5 w-3.5" /> Error
      </span>
    );
  const ok = status >= 200 && status < 300;
  const warn = status >= 300 && status < 500;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
          : warn
            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
      }`}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {status}
    </span>
  );
}

export { METHOD_COLORS };
