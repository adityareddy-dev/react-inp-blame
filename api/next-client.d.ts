import type { StartedNavigation } from "./types.js";
interface RouterTransitionStartEvent {
    readonly timestamp: number;
}
export declare function onRouterTransitionStart(url: string, navigationType: StartedNavigation["type"], event?: RouterTransitionStartEvent | null): void;
export {};
