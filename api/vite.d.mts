import type { Plugin } from "vite";
import type { InstallOptions } from "./dist/index.js";
export interface InpBlameOptions {
    enabled?: "development" | "production" | boolean;
    runtime?: boolean | InstallOptions;
    pages?: (path: string) => boolean;
    entry?: string;
}
export function inpBlame(options?: InpBlameOptions): Plugin[];
