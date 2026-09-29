import type { InteractionReport, Rating } from "./types.js";
export interface InpEstimate {
    value: number;
    rating: Rating;
    interactionId: number | null;
    interactionCount: number;
    report: InteractionReport | null;
}
export declare function rateInp(ms: number): Rating;
export interface TimedInteraction {
    entryType: string;
    interactionId: number;
    startTime: number;
    duration: number;
}
export declare function createInpTracker(nativeCount: (() => number) | null): {
    add(batch: readonly TimedInteraction[]): void;
    leaveOut(id: number, beganBefore?: boolean): void;
    update(): void;
    estimate(): {
        id: number | null;
        value: number;
        interactionCount: number;
    } | null;
    candidates(): (number | null)[];
    reset(cause: "navigation" | "clear"): void;
};
