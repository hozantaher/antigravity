import { z } from 'zod'
import { registry } from '../registry'
import { errorResponses, json, jsonBody } from '../schemas/common'
import { UserSchema } from '../schemas/users'
import { LoginRequestSchema, PasswordResetRequestSchema } from '../schemas/misc'

export const registerAuthPaths = () => {
  registry.registerPath({
    method: 'post',
    path: '/api/auth/login',
    tags: ['auth'],
    summary: 'Exchange a Firebase ID token for a session',
    description: 'Verifies the Firebase ID token and upserts the user. On first login, `profile` seeds the account.',
    request: { body: jsonBody(LoginRequestSchema) },
    responses: {
      200: json(UserSchema, 'Logged in'),
      400: { description: 'Missing idToken' },
      401: { description: 'Invalid Firebase ID token' },
    },
    security: [],
  })

  registry.registerPath({
    method: 'post',
    path: '/api/auth/logout',
    tags: ['auth'],
    summary: 'Logout (advance the token revocation cutoff)',
    responses: {
      200: json(z.object({ ok: z.boolean(), revoked: z.boolean() }), 'Logged out'),
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/auth/request-email-verification',
    tags: ['auth'],
    summary: 'Send an e-mail verification link to the current user',
    responses: {
      200: json(z.object({ sent: z.boolean() }), 'Result (sent=false if already verified)'),
      401: errorResponses[401],
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/auth/request-password-reset',
    tags: ['auth'],
    summary: 'Send a password reset e-mail',
    description: 'Always returns ok regardless of whether the e-mail exists (no account enumeration).',
    request: { body: jsonBody(PasswordResetRequestSchema) },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Accepted'),
    },
    security: [],
  })
}
