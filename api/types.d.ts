import type { InpEstimate } from "./inp.js";
export interface RenderedComponent {
    readonly name: string;
    readonly count: number;
    readonly self: number | null;
    readonly total: number | null;
}
export interface CommitSummary {
    readonly at: number;
    readonly sinceInput: number;
    readonly inputTs: number;
    readonly gestureTs: number;
    readonly inputType: string;
    readonly inDispatch?: boolean;
    readonly joinedBy?: "exact" | "overlap";
    readonly rendered: number;
    readonly mounted?: number;
    readonly effectMounts?: number;
    readonly effectRuns?: number;
    readonly effectMountName?: string | null;
    readonly hydrated: boolean;
    readonly hydratedTarget: HydrationBoundary | null;
    readonly truncated: boolean;
    readonly roots: readonly string[];
    readonly hotPath: readonly string[];
    readonly pathStart?: "only-root" | "heaviest-root" | "unknown-root" | "no-root";
    readonly startRendered?: number;
    readonly pathRendered?: number;
    readonly strictMode?: boolean;
    readonly components: readonly RenderedComponent[];
    readonly hasDurations: boolean;
    readonly coarseClock: boolean;
    readonly total: number;
    readonly startedAt: number | null;
    readonly effectsStartedAt: number | null;
    readonly effectsEndedAt: number | null;
    readonly walkMs: number;
    readonly priority: number | undefined;
    readonly didError: boolean;
}
export interface RendererInfo {
    readonly id: number;
    readonly version: string | null;
    readonly bundleType: number | null;
    readonly rendererPackageName: string | null;
}
export interface Stats {
    mode: "shim" | "chained" | "none" | "unsupported" | "sampled-out";
    unsupportedReason: UnsupportedReason | null;
    walks: number;
    walkTotalMs: number;
    reportTotalMs: number;
    installMs: number;
    react: ReactStatus;
}
export type ReactStatus = "reading" | "waiting" | "installed-late" | "unreadable";
export interface UnsupportedReason {
    kind: "browser" | "another-copy" | "hook-disabled" | "react-version" | "fiber-shape" | "walk-threw";
    message: string;
}
export interface HookInfo {
    owner: string;
    renderers: RendererInfo[];
    devtoolsLockedOut: boolean;
}
export interface Api {
    reports(): InteractionReport[];
    last(): InteractionReport | null;
    inp(): InpEstimate | null;
    clear(): void;
    onInteraction(fn: (report: InteractionReport) => void): () => void;
    stats(): Stats;
    readonly debug: DebugApi;
    dispose(): void;
}
export interface DebugApi {
    commits(): CommitSummary[];
    hook(): HookInfo;
}
export interface ScriptSummary {
    readonly invoker: string;
    readonly name: string;
    readonly source: string;
    readonly start: number;
    readonly duration: number;
    readonly forcedLayout: number;
}
export interface FrameSummary {
    readonly start: number;
    readonly duration: number;
    readonly blocking: number;
    readonly forcedLayout: number;
    readonly scripts: readonly ScriptSummary[];
    readonly styleAndLayoutStart: number | null;
}
export interface TargetInfo {
    readonly selector: string | null;
    readonly label: string | null;
    readonly component: string | null;
    readonly owners: readonly string[];
    readonly handler: string | null;
}
export interface Phase {
    readonly label: string;
    readonly ms: number;
    readonly hint: string;
    readonly parts?: readonly Phase[];
}
export interface HydrationBoundary {
    readonly scope: "root" | "boundary";
    readonly owner: string | null;
}
export interface Hydration extends HydrationBoundary {
    readonly kind: "waited" | "not-hydrated";
    readonly ms: number | null;
}
export interface Blame {
    readonly kind: "render" | "handler" | "hydration" | "layout" | "waiting" | "painting" | "script" | "none";
    readonly name: string | null;
    readonly detail: string | null;
    readonly ms: number | null;
    readonly confidence: "measured" | "inferred";
}
export type Rating = "good" | "needs-improvement" | "poor";
export interface Explanation {
    readonly headline: string;
    readonly blame: Blame;
    readonly rating: Rating;
    readonly where: string | null;
    readonly cause: string;
    readonly notes: readonly string[];
    readonly phases: readonly Phase[];
}
export type NavigationType = "navigate" | "reload" | "back-forward" | "back-forward-cache" | "prerender" | "restore" | "soft-navigation";
export interface StartedNavigation {
    readonly url: string;
    readonly type: "push" | "replace" | "traverse";
}
export interface EventEntrySummary {
    readonly name: string;
    readonly startTime: number;
    readonly duration: number;
    readonly processingStart: number;
    readonly processingEnd: number;
}
export interface InteractionReport {
    readonly schemaVersion: 4;
    readonly interactionId: number;
    readonly type: string;
    readonly reactStatus: ReactStatus;
    readonly reactBuild: "development" | "production" | "profiling" | null;
    readonly strictMode: boolean | null;
    readonly pointerType: string | null;
    readonly start: number;
    readonly end: number;
    readonly duration: number;
    readonly holdMs: number;
    readonly entries: readonly EventEntrySummary[];
    readonly inputDelay: number;
    readonly processing: number;
    readonly walkMs: number;
    readonly presentation: number;
    readonly nextInput: {
        readonly type: string;
        readonly pointerType: string | null;
        readonly start: number;
        readonly endedAt: number | null;
    } | null;
    readonly target: TargetInfo | null;
    readonly hydration: Hydration | null;
    readonly navigationURL: string;
    readonly navigationType: NavigationType;
    readonly startedNavigation: StartedNavigation | null;
    readonly commits: readonly CommitSummary[];
    readonly followUps: readonly CommitSummary[];
    readonly unjoinedCommits: number;
    readonly frames: readonly FrameSummary[] | null;
    readonly laterFrames: readonly FrameSummary[] | null;
    readonly revision: number;
    readonly explanation: Explanation;
    readonly verdict: string;
    readonly overheadMs: number;
}
export interface OverlayOptions {
    position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    open?: boolean;
    max?: number;
}
export interface InstallOptions {
    overlay?: boolean | "query" | OverlayOptions;
    threshold?: number;
    devtoolsTrack?: boolean | "auto";
    walkBudget?: number;
    inputWindow?: number;
    debugGlobal?: boolean | string;
    labels?: "auto" | "text" | "attributes";
    hook?: "auto" | "chain" | "shim";
    sampleRate?: number;
}
