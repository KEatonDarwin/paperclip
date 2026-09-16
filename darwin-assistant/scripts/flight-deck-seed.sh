#!/usr/bin/env bash
set -euo pipefail

API="${FLIGHT_DECK_API:-http://localhost:3201/api/v1}"
ENV_FILE="${JARVIS_COCKPIT_ENV:-/home/kevin/paperclip/jarvis-command-center/.env}"

KEY="$(grep -E '^JARVIS_COCKPIT_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
if [[ -z "${KEY}" ]]; then
  echo "JARVIS_COCKPIT_KEY not found in ${ENV_FILE}" >&2
  exit 1
fi

AUTH=(-H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json")

get_id_by_title() {
  local title="$1"
  curl -fsS "${AUTH[@]}" "${API}/workstreams?include_done=1" \
    | node -e '
      const title = process.argv[1];
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const data = JSON.parse(input || "{}");
        const item = (data.workstreams || []).find((w) => w.title === title);
        if (item) process.stdout.write(String(item.id));
      });
    ' "$title"
}

make_payload() {
  node -e '
    const [title, turn, nextAction, smartRoot, groupId] = process.argv.slice(1);
    const obj = { title, turn };
    if (nextAction) obj.next_action = nextAction;
    if (turn === "jarvis" || turn === "kevin" || turn === "external") obj.next_owner = turn;
    if (smartRoot) obj.smart_todo_root_id = Number(smartRoot);
    if (groupId) obj.group_id = Number(groupId);
    process.stdout.write(JSON.stringify(obj));
  ' "$@"
}

create_workstream() {
  local title="$1"
  local turn="$2"
  local next_action="${3:-}"
  local smart_root="${4:-}"
  local group_id="${5:-}"
  local id

  id="$(get_id_by_title "$title")"
  if [[ -n "$id" ]]; then
    echo "$id"
    return
  fi

  local payload
  payload="$(make_payload "$title" "$turn" "$next_action" "$smart_root" "$group_id")"
  curl -fsS -X POST "${API}/workstreams" "${AUTH[@]}" -d "$payload" \
    | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const data = JSON.parse(input || "{}");
        if (!data.workstream?.id) {
          console.error(input);
          process.exit(1);
        }
        process.stdout.write(String(data.workstream.id));
      });
    '
}

add_link() {
  local id="$1"
  local kind="$2"
  local ref="$3"
  local label="${4:-}"
  local payload
  payload="$(
    node -e '
      const [kind, ref, label] = process.argv.slice(1);
      const obj = { kind, ref };
      if (label) obj.label = label;
      process.stdout.write(JSON.stringify(obj));
    ' "$kind" "$ref" "$label"
  )"
  curl -fsS -X POST "${API}/workstreams/${id}/links" "${AUTH[@]}" -d "$payload" >/dev/null
}

perclickity_id="$(create_workstream \
  "Perclickity media buy + clearinghouse" \
  "kevin" \
  "Deploy the reviewed code-rules branch on the intake box, then tell JARVIS" \
  "25")"
add_link "$perclickity_id" thread "cockpit:ed03234c-7b5a-4152-9a1c-59b6ffa99f84" "Perclickity thread"
add_link "$perclickity_id" thread "cockpit:4d438c70-4c56-4fac-bfef-65594d677bb6" "Clearinghouse thread"
add_link "$perclickity_id" thread "cockpit:5904f93e-df2a-4f19-9b9c-7004fa75cbfc" "Review thread"
add_link "$perclickity_id" tree "tree-4b5433d5" "Clearinghouse tree"
add_link "$perclickity_id" todo_root "25" "Perclickity todo root"
add_link "$perclickity_id" todo_root "20" "Clearinghouse todo root"

active_response_id="$(create_workstream \
  "Active Response non-human opens" \
  "kevin" \
  "Eyeball the verification thread and green-light rollout" \
  "13")"
add_link "$active_response_id" thread "cockpit:2d638a76-48d5-41d1-bb03-41b061e5019b" "Verification thread"
add_link "$active_response_id" thread "cockpit:monitor-1" "Monitor"
add_link "$active_response_id" todo_root "13" "Active Response todo root"

jarvis_nudge_id="$(create_workstream "JARVIS Nudge" "jarvis")"
add_link "$jarvis_nudge_id" tree "tree-4f8bb8b7" "JARVIS Nudge tree"

smart_unblocker_id="$(create_workstream "Smart Unblocker" "jarvis")"
add_link "$smart_unblocker_id" tree "tree-e8e8750a" "Smart Unblocker tree"

hub1_tagging_id="$(create_workstream "Hub 1.0 tagging automation" "parked" "" "20")"
add_link "$hub1_tagging_id" todo_root "20" "Hub 1.0 tagging todo root"

hub2_microservices_id="$(create_workstream "Hub 2.0 microservices roadmap" "parked" "" "1")"
add_link "$hub2_microservices_id" todo_root "1" "Hub 2.0 roadmap todo root"

brand_recipe_id="$(create_workstream "Design new brand recipe" "parked" "" "5" "27")"
add_link "$brand_recipe_id" todo_root "5" "Brand recipe todo root"

echo "Seeded Flight Deck workstreams:"
printf '  %s %s\n' "$perclickity_id" "Perclickity media buy + clearinghouse"
printf '  %s %s\n' "$active_response_id" "Active Response non-human opens"
printf '  %s %s\n' "$jarvis_nudge_id" "JARVIS Nudge"
printf '  %s %s\n' "$smart_unblocker_id" "Smart Unblocker"
printf '  %s %s\n' "$hub1_tagging_id" "Hub 1.0 tagging automation"
printf '  %s %s\n' "$hub2_microservices_id" "Hub 2.0 microservices roadmap"
printf '  %s %s\n' "$brand_recipe_id" "Design new brand recipe"
