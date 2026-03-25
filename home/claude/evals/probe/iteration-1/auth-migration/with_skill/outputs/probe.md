## 1. How will you handle token revocation when users need to be immediately logged out (security breach, account termination)?

**Recommended:** Implement a token blocklist (JWT blacklist) stored in Redis with expiration matching token TTL. Check blocklist on every request for access tokens, and maintain a separate revoked refresh token list. This accepts the performance overhead of Redis lookups but provides immediate revocation capability that pure stateless JWT lacks.

## 2. What happens when a user's refresh token expires while they're actively using the application?

**Recommended:** Implement automatic token refresh in the client with exponential backoff retry. When an API call returns 401, attempt to refresh the token once before redirecting to login. Log the user out gracefully if refresh fails. This accepts occasional brief service interruptions but prevents jarring logout experiences during active sessions.

## 3. How will you migrate existing sessions during the rollout without forcing all users to re-authenticate?

**Recommended:** Run dual authentication systems during migration. Accept both session cookies and JWTs, with middleware that can validate either. Gradually convert sessions to JWTs on successful authentication. Provide a migration endpoint that converts valid sessions to JWTs. This accepts increased complexity during the transition period but avoids mass user disruption.

## 4. How will you handle concurrent refresh token usage when a user has multiple browser tabs open?

**Recommended:** Implement refresh token rotation - issue a new refresh token with each access token refresh and invalidate the old one. Use a short grace period (30 seconds) where both old and new refresh tokens are valid to handle race conditions. This accepts some complexity in token management but prevents refresh token reuse attacks.

## 5. What's your strategy for JWT signing key rotation and compromise recovery?

**Recommended:** Use multiple signing keys (key rotation) with key IDs in JWT headers. Rotate keys every 30 days and maintain 2-3 active keys to handle tokens signed with previous keys. Store keys in a secure key management system. This accepts operational complexity but provides crypto-agility and compromise recovery.

## 6. How will you handle CSRF attacks when storing refresh tokens in httpOnly cookies?

**Recommended:** Implement SameSite=Strict cookies and require a CSRF token in a custom header for refresh operations. The refresh endpoint should validate both the httpOnly cookie and the CSRF token from the request header. This accepts the complexity of CSRF token management but prevents cross-site request forgery.

## 7. Where will you store user session data that doesn't belong in JWT claims (cart contents, UI preferences)?

**Recommended:** Continue using server-side storage (Redis/database) keyed by user ID from JWT claims. JWTs should only contain authentication/authorization data, not application state. Use the JWT subject claim to look up session data. This accepts hybrid storage complexity but keeps JWTs lightweight and avoids security issues with large tokens.

## 8. How will you handle different JWT expiration needs across API endpoints (admin vs user actions)?

**Recommended:** Use a single access token type but implement endpoint-specific validation middleware that checks token age. For sensitive operations (admin actions, financial transactions), require tokens issued within the last 5 minutes. This accepts some UX friction for high-security operations but avoids multiple token types.

## 9. What happens if the refresh token cookie is lost or corrupted while the user is still active?

**Recommended:** Detect missing/invalid refresh tokens and provide a seamless re-authentication flow. Show a modal prompting for password to issue new tokens without full page redirect. Log security events for forensics. This accepts occasional user friction but maintains security boundaries.

## 10. How will you validate JWT integrity and prevent algorithm confusion attacks?

**Recommended:** Use a strong algorithm (RS256 or ES256) and explicitly validate the algorithm in token verification. Never accept algorithm="none" tokens. Use a JWT library that defaults to secure validation. Store algorithm allowlists in configuration. This accepts slightly more CPU overhead for cryptographic operations but prevents signature bypass attacks.

## Summary

### Resolved
- **Token revocation**: Redis blocklist with TTL expiration
- **Migration strategy**: Dual authentication during transition period
- **Refresh token security**: Token rotation with grace period
- **Key management**: Multi-key rotation every 30 days
- **CSRF protection**: SameSite cookies with CSRF tokens
- **Session data**: Server-side storage keyed by JWT subject
- **Algorithm security**: RS256/ES256 with explicit validation

### Unresolved
- **Rollout timeline**: Need specific phases for session-to-JWT migration
- **Key storage infrastructure**: Choice of key management system (HSM, cloud KMS, etc.)
- **Client-side token refresh**: JavaScript implementation strategy for SPAs vs server-rendered pages
- **Monitoring and alerting**: What metrics will indicate successful migration and detect security issues