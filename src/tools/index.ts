export type { ToolContext, ToolDef, ToolHandler } from "./types.js";

import { discoveryTools } from "./discovery.js";
import { groupTools } from "./groups.js";
import { hookTools } from "./hooks.js";
import { identityTools } from "./identity.js";
import { messagingTools } from "./messaging.js";
import { onboardingTools } from "./onboarding.js";
import { paymentTools } from "./payments.js";
import type { ToolDef } from "./types.js";

export const tools: ToolDef[] = [
	...onboardingTools,
	...messagingTools,
	...discoveryTools,
	...groupTools,
	...identityTools,
	...hookTools,
	...paymentTools,
];
