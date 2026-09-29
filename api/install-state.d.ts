import type { OverlayHandle } from "./overlay.js";
import type { Api, InstallOptions, InteractionReport } from "./types.js";
export type Listener = (report: InteractionReport) => void;
export interface Installation {
    api: Api;
    reapply(opts: InstallOptions): void;
}
export interface InstallState {
    installed: Installation | null;
    sampledOut: Api | null;
    listeners: Set<Listener>;
    overlay: Promise<OverlayHandle | null> | null;
    installMs: number;
}
export declare const page: InstallState;
export declare const unexplainedReports: WeakSet<InteractionReport>;
