#!/usr/bin/env node
// Preflight for `pnpm dev` / paperclip-dev.service: verifies the hoisted root
// `tsx` module actually resolves before anything tries to `exec tsx ...`.
//
// This must run under plain `node`, not tsx — the whole point is to recover
// from tsx itself being unresolvable (DAR-760: a dangling `node_modules/tsx`
// symlink left the dev server crash-looping on every restart because the
// watchdog can only restart hung processes, not repair a missing module).
import { existsSync, lstatSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nodeModules = path.join(repoRoot, "node_modules");
const tsxLink = path.join(nodeModules, "tsx");
const tsxEntrypoint = path.join(tsxLink, "dist", "cli.mjs");
const pnpmStore = path.join(nodeModules, ".pnpm");

function resolvesEntrypoint() {
  try {
    return existsSync(tsxEntrypoint);
  } catch {
    return false;
  }
}

function findStoredTsx() {
  if (!existsSync(pnpmStore)) return null;
  const candidates = readdirSync(pnpmStore).filter((name) => name.startsWith("tsx@"));
  if (candidates.length === 0) return null;
  // Prefer the newest version if multiple are hoisted.
  candidates.sort();
  const chosen = candidates[candidates.length - 1];
  const target = path.join(pnpmStore, chosen, "node_modules", "tsx");
  return existsSync(path.join(target, "dist", "cli.mjs")) ? target : null;
}

if (resolvesEntrypoint()) {
  process.exit(0);
}

console.warn(
  `[ensure-dev-deps] node_modules/tsx/dist/cli.mjs did not resolve (broken or dangling symlink?) — attempting repair`,
);

let linkInfo = "absent";
try {
  const stat = lstatSync(tsxLink);
  linkInfo = stat.isSymbolicLink() ? `symlink -> ${readlinkSync(tsxLink)}` : "regular file/dir";
} catch {
  linkInfo = "absent";
}
console.warn(`[ensure-dev-deps] node_modules/tsx is currently: ${linkInfo}`);

const storedTsx = findStoredTsx();
if (!storedTsx) {
  console.error(
    "[ensure-dev-deps] FATAL: no usable tsx package found under node_modules/.pnpm either. " +
      "The dev-only tsx dependency is genuinely missing (e.g. a NODE_ENV=production install pruned it). " +
      "Run `pnpm install` at the repo root (without NODE_ENV=production) to restore it. Refusing to start.",
  );
  process.exit(1);
}

try {
  if (existsSync(tsxLink) || lstatSync(tsxLink)) {
    unlinkSync(tsxLink);
  }
} catch {
  // tsxLink didn't exist — nothing to remove.
}

const relativeTarget = path.relative(nodeModules, storedTsx);
symlinkSync(relativeTarget, tsxLink, "dir");

if (!resolvesEntrypoint()) {
  console.error(
    `[ensure-dev-deps] FATAL: repaired symlink (node_modules/tsx -> ${relativeTarget}) still does not resolve cli.mjs. Manual investigation required.`,
  );
  process.exit(1);
}

console.warn(`[ensure-dev-deps] repaired: node_modules/tsx -> ${relativeTarget}`);
process.exit(0);
