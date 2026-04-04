export type { ToolContext, ToolDef, ToolHandler } from "./types.js";

import { discoveryTools } from "./discovery.js";
import { groupTools } from "./groups.js";
import { identityTools } from "./identity.js";
import { messagingTools } from "./messaging.js";
import type { ToolDef } from "./types.js";

export const tools: ToolDef[] = [
	...messagingTools,
	...discoveryTools,
	...groupTools,
	...identityTools,
];
