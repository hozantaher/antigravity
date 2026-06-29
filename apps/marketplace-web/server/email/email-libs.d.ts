// mjml v5 and html-to-text v10 ship no type declarations — declare only the surface we use.
declare module 'mjml' {
  interface MjmlParseResults {
    html: string
    errors: unknown[]
  }
  interface MjmlOptions {
    minify?: boolean
    validationLevel?: 'strict' | 'soft' | 'skip'
    [key: string]: unknown
  }
  const mjml2html: (mjml: string, options?: MjmlOptions) => MjmlParseResults | Promise<MjmlParseResults>
  export default mjml2html
}

declare module 'html-to-text' {
  interface HtmlToTextOptions {
    wordwrap?: number | false
    [key: string]: unknown
  }
  export const convert: (html: string, options?: HtmlToTextOptions) => string
}
