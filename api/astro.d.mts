import type { AstroIntegration } from "astro";
import type { InstallOptions } from "./dist/index.js";
export interface InpBlameOptions {
    enabled?: "development" | "production" | boolean;
    runtime?: boolean | InstallOptions;
}
export function inpBlame(options?: InpBlameOptions): AstroIntegration;
