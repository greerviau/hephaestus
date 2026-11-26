import { factoryActionRoutes, type FactoryPages } from "./factory.js";
import type { Route } from "./http.js";
import { overviewRoutes } from "./overview.js";
import { workRoutes } from "./work.js";
import { pipelineRoutes } from "./pipeline.js";
import { activityRoutes } from "./activity.js";
import { analyticsRoutes } from "./analytics.js";
import { improvementRoutes } from "./improvement.js";
import { projectsRoutes } from "./projects.js";

/** Every factory page and owner action. */
export function dashboardRoutes(factory: FactoryPages): Route[] {
  return [
    ...overviewRoutes(factory),
    ...workRoutes(factory),
    ...pipelineRoutes(factory),
    ...activityRoutes(factory),
    ...analyticsRoutes(factory),
    ...improvementRoutes(factory),
    ...projectsRoutes(factory),
    ...factoryActionRoutes(factory),
  ];
}
