import type { NextConfig } from "next";
import type { InstallOptions } from "./dist/index.js";
export interface WithInpBlameOptions {
    enabled?: "development" | "production" | boolean;
    runtime?: boolean | InstallOptions;
}
export interface NextConfigPhase {
    defaultConfig: NextConfig;
}
export type NextConfigFunction = (phase: string, context: NextConfigPhase) => NextConfig | Promise<NextConfig>;
export function withInpBlame(nextConfig: NextConfigFunction, options?: WithInpBlameOptions): NextConfigFunction;
export function withInpBlame(nextConfig: Promise<NextConfig>, options?: WithInpBlameOptions): Promise<NextConfig>;
export function withInpBlame(nextConfig?: NextConfig, options?: WithInpBlameOptions): NextConfig;
