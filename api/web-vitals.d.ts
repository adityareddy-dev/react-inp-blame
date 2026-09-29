import type { Blame, InteractionReport, RenderedComponent } from "./types.js";
declare const SCHEMA_VERSION = 3;
export interface InpMetric<Attribution extends object = Record<string, never>> {
    readonly entries: readonly object[];
    readonly attribution?: Attribution;
}
export interface InpMetricEntry {
    readonly interactionId?: number;
}
export interface ReactRenderSummary {
    readonly count: number;
    readonly rendered: number;
    readonly ms: number | null;
}
export interface ReactAttribution {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly interactionId: number;
    readonly blame: Blame;
    readonly handler: string | null;
    readonly hotPath: readonly string[];
    readonly components: readonly RenderedComponent[];
    readonly commits: ReactRenderSummary;
    readonly followUps: ReactRenderSummary;
    readonly reactBuild: InteractionReport["reactBuild"];
    readonly strictMode: boolean | null;
}
export type { Blame, RenderedComponent } from "./types.js";
export declare function generateTarget(node: Node | null): string | undefined;
export declare function attributeINP<Attribution extends object>(metric: InpMetric<Attribution>): Attribution & {
    readonly react: ReactAttribution | null;
};
