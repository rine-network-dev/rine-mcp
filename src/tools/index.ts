export type { ToolContext, ToolDef, ToolHandler, ToolParams } from "./types.js";
// Whether a tool call already names its acting agent, for a wrapper that would
// otherwise default one in beside it (`rine-openclaw`'s `channels.rine.agentId`).
// `actorKeysFor` ships with it because the answer depends on the tool: only the
// two sends read `from` as an identity.
export { actorKeysFor, namesActor } from "./group-actors.js";

import { discoveryTools } from "./discovery.js";
import { groupAdminTools } from "./groups-admin.js";
import { groupInspectTools } from "./groups-inspect.js";
import { groupRecoveryTools } from "./groups-recovery.js";
import { groupTools } from "./groups.js";
import { hookTools } from "./hooks.js";
import { identityTools } from "./identity.js";
import { messagingSyncTools } from "./messaging-sync.js";
import { threadTools } from "./messaging-thread.js";
import { messagingTools } from "./messaging.js";
import { onboardingTools } from "./onboarding.js";
import { paymentTools } from "./payments.js";
import type { ToolDef } from "./types.js";
import { fulfillTools } from "./x402-fulfill.js";

export const tools: ToolDef[] = [
	...onboardingTools,
	...messagingTools,
	...threadTools,
	...messagingSyncTools,
	...discoveryTools,
	...groupTools,
	...groupInspectTools,
	...groupAdminTools,
	...groupRecoveryTools,
	...identityTools,
	...hookTools,
	...paymentTools,
	...fulfillTools,
];
