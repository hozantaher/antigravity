// Anonymous-friendly: returns the User for a valid Bearer token, else null.
export default defineEventHandler(event => getSessionUser(event))
