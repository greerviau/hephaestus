import { updateRoutes } from "./update.js";
import { factoryActionRoutes, type FactoryPages } from "./factory.js";
import type { Route } from "./http.js";
import { overviewRoutes } from "./overview.js";
import { workRoutes } from "./work.js";
import { activityRoutes } from "./activity.js";
import { analyticsRoutes } from "./analytics.js";
import { improvementRoutes } from "./improvement.js";
import { projectsRoutes } from "./projects.js";
import { messagingRoutes } from "./messaging.js";
import { configRoutes } from "./settings.js";
import { shellRoutes } from "./shell.js";

/** Every factory page and owner action. */
export function dashboardRoutes(factory: FactoryPages): Route[] {
  return [
    ...overviewRoutes(factory),
    ...workRoutes(factory),
    ...activityRoutes(factory),
    ...analyticsRoutes(factory),
    ...improvementRoutes(factory),
    ...projectsRoutes(factory),
    ...messagingRoutes(factory),
    ...configRoutes(factory),
    ...factoryActionRoutes(factory),
    ...shellRoutes(factory),
    ...updateRoutes(factory),
  ];
}
