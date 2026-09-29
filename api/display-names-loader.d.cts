declare function loader(this: {
    resourcePath?: string;
} | void, source: string | Buffer): string;
declare namespace loader {
    function stamp(code: string): string;
}
export = loader;
