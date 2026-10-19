// Vite loads these application styles as side effects; no runtime exports.
declare module '*.css' {}
// Vite raw imports load the reviewed Markdown guides as strings.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
