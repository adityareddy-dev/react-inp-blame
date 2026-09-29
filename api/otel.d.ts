export type InpBlameAttributes = Readonly<Record<`react_inp_blame.${string}`, string | number>>;
export interface InpMetricLike {
    readonly name?: string;
    readonly entries: readonly object[];
}
export interface InpLogRecordLike {
    readonly attributes?: {
        readonly [key: string]: unknown;
    };
    readonly hrTime?: readonly [
        number,
        number
    ];
    readonly timestamp?: unknown;
    setAttributes?(attributes: InpBlameAttributes): unknown;
}
export declare function inpBlameAttributes(source: InpMetricLike | InpLogRecordLike | number | null | undefined): InpBlameAttributes;
export declare class InpBlameLogRecordProcessor {
    onEmit(record: InpLogRecordLike): void;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
}
