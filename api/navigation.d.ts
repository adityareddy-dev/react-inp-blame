import type { CommitSummary, NavigationType, StartedNavigation } from "./types.js";
export interface PageNavigation {
    readonly url: string;
    readonly type: NavigationType;
    readonly start: number;
    readonly router: {
        readonly type: StartedNavigation["type"];
        readonly input: Pick<CommitSummary, "inputTs" | "inputType" | "gestureTs"> | null;
    } | null;
}
export declare const MAX_NAVIGATIONS = 20;
export interface RouterNavigation {
    readonly url: string;
    readonly type: StartedNavigation["type"];
    readonly at: number;
}
export declare function pageURL(href: string): string;
export declare function routerNavigated(navigation: RouterNavigation): void;
export declare function announceNavigation(url: string | URL): void;
export declare function onRouterNavigation(fn: (navigation: RouterNavigation) => void): () => void;
export declare function documentNavigation(): PageNavigation;
