import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [index("routes/home.tsx"), route("second", "routes/second.tsx")] satisfies RouteConfig;
