// Collapse the www host onto the apex with a 301 so www.auction24.cz and auction24.cz don't
// serve duplicate content. Only touches `www.` hosts → localhost and preview domains are untouched.
export default defineEventHandler(event => {
  const host = getRequestHost(event, { xForwardedHost: true })
  if (!host?.startsWith('www.')) return

  const url = getRequestURL(event, { xForwardedHost: true })
  return sendRedirect(event, `https://${host.slice(4)}${url.pathname}${url.search}`, 301)
})
