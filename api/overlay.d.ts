import type { InpEstimate } from "./inp.js";
import type { CommitSummary, HookInfo, InteractionReport, OverlayOptions, Stats } from "./types.js";
interface Source {
    reports(): InteractionReport[];
    inp(): InpEstimate | null;
    onInteraction(fn: (r: InteractionReport) => void): () => void;
    clear(): void;
    stats(): Stats;
    debug: {
        hook(): HookInfo;
    };
}
export interface OverlayHandle {
    open(): void;
    close(): void;
    toggle(): void;
    refresh(): void;
    dispose(): void;
}
export declare function createOverlay(source: Source, opts?: OverlayOptions, onHide?: () => void): OverlayHandle;
type Child = Node | string | null | undefined | false;
export declare const laterDetail: (c: CommitSummary) => string;
export declare const laterWhen: (r: Pick<InteractionReport, "end">, c: CommitSummary) => string;
export declare const laterLead: (r: Pick<InteractionReport, "end">, c: CommitSummary) => string;
export declare function blameLine(r: InteractionReport): Child[];
export declare function titleFor(r: InteractionReport): string;
export {};
