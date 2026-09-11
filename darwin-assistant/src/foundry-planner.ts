import { markProjectPlannerFailed } from './foundry.js';

// Node 4 wires the real one-shot local `claude` planner. This stub keeps the
// route contract alive without making model calls or writing partial blueprints.
export async function planProject(id: string): Promise<void> {
  markProjectPlannerFailed(id, 'planner not wired yet');
}
