import type { UIAdapterModule } from "../types";
import { parseAuggieLocalStdoutLine } from "./parse-stdout";
import { AuggieLocalConfigFields } from "./config-fields";
import { buildAuggieLocalConfig } from "./build-config";

export const auggieLocalUIAdapter: UIAdapterModule = {
  type: "auggie_local",
  label: "Augment Code (local)",
  parseStdoutLine: parseAuggieLocalStdoutLine,
  ConfigFields: AuggieLocalConfigFields,
  buildAdapterConfig: buildAuggieLocalConfig,
};
