import { factoryActionRoutes, type FactoryPages } from "./factory.js";
import type { Route } from "./http.js";
import { overviewRoutes } from "./overview.js";
import { workRoutes } from "./work.js";

/** Every factory page and owner action. */
export function dashboardRoutes(factory: FactoryPages): Route[] {
  return [...overviewRoutes(factory), ...workRoutes(factory), ...factoryActionRoutes(factory)];
}
