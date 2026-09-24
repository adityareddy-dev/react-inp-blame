/** Webpack-style loader: appends `Foo.displayName = "Foo"` for each React component in the file. */
declare function loader(this: { resourcePath?: string } | void, source: string | Buffer): string;
declare namespace loader {
  /** Returns the source with a displayName assignment per component, or the source untouched. */
  function stamp(code: string): string;
}
export = loader;
