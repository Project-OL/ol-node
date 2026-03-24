/**
 * Generates postman/Auth-API.postman_collection.json
 * Run: node scripts/generate-auth-postman-collection.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const out = path.join(root, 'postman', 'Auth-API.postman_collection.json')

function req(name, method, relPath, body, description, testLines) {
  const request = {
    method,
    header: [{ key: 'Content-Type', value: 'application/json' }],
    url: `{{baseUrl}}/api/v1/auth${relPath}`,
    description,
  }
  if (method !== 'GET' && body != null) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    request.body = { mode: 'raw', raw }
  }
  const item = { name, request }
  if (testLines?.length) {
    item.event = [{ listen: 'test', script: { exec: testLines, type: 'text/javascript' } }]
  }
  return item
}

const bearerAuth = {
  type: 'bearer',
  bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }],
}

function folder(name, description, subItems, withBearer) {
  const f = { name, description, item: subItems }
  if (withBearer) f.auth = bearerAuth
  return f
}

const saveTokensOn200 = [
  'if (pm.response.code === 200) {',
  '  try {',
  '    const j = pm.response.json();',
  "    if (j.accessToken) pm.collectionVariables.set('accessToken', j.accessToken);",
  "    if (j.refreshToken) pm.collectionVariables.set('refreshToken', j.refreshToken);",
  "    if (j.sessionId) pm.collectionVariables.set('sessionId', j.sessionId);",
  "    if (j.userId) pm.collectionVariables.set('userId', j.userId);",
  '  } catch (e) {}',
  '}',
]

const expect = (code) => [
  `pm.test('HTTP ${code}', function () { pm.expect(pm.response.code).to.eql(${code}); });`,
  "try { const j = pm.response.json(); if (j.code) console.log('API code:', j.code); } catch (e) {}",
]

const infoDesc = `## Auth API — scenarios for mobile / QA

### Base path
\\\`POST {{baseUrl}}/api/v1/auth/...\\\`

### Response shapes
- **Zod validation (routes):** \\\`400\\\` body: \\\`{ code: "INVALID_REQUEST", message, details? }\\\`
- **AppError (service):** \\\`statusCode\\\` body: \\\`{ statusCode, code?, error? (non-production), details? }\\\`  
  Production may omit \\\`error\\\` (human message); clients should use \\\`code\\\`.

### Login (primary): POST /login/password
No OTP. Flow: **check-availability** → if \\\`exists\\\` && \\\`passwordSet\\\` → **login/password** with same \\\`deviceId\\\` / \\\`deviceName\\\` as signup.

### Rate limits (per IP, Redis)
Exceeded → **429** \\\`RATE_LIMITED\\\`, \\\`Retry-After\\\` header, \\\`details.retryAfter\\\` (seconds).  
Endpoints: signup OTP, login OTP, **login/password** (10 / 10 min), password reset send/confirm, provider bind/unbind, etc.

### Device limit
Login links account to \\\`deviceId\\\`. If device already has **3** linked accounts and this user is new → **400** \\\`DEVICE_ACCOUNT_LIMIT_REACHED\\\`.

### POST /login/password — \\\`code\\\` reference (email | phone | publicId)
| code | HTTP | Notes |
|------|------|--------|
| USER_NOT_FOUND | 404 | Unknown identifier |
| INVALID_CREDENTIALS | 401 | Wrong password |
| PASSWORD_NOT_SET | 401 | OAuth/social-only user (no AuthPassword row) |
| INVALID_PUBLIC_ID | 400 | publicId path only: bad number |
| INVALID_EMAIL / INVALID_PHONE | 400 | check-availability & identifier validation |
| ACCOUNT_SUSPENDED | 403 | |
| ACCOUNT_DEACTIVATING | 403 | \\\`details.canReactivate: true\\\` |
| ACCOUNT_DELETED | 403 | |
| DEVICE_ACCOUNT_LIMIT_REACHED | 400 | 3 accounts on same deviceId |
| RATE_LIMITED | 429 | per-IP auth limits |
| INVALID_REQUEST | 400 | Zod body |

### Manual / seeded scenarios (not in collection)
- **403** account states: adjust user.status in DB (suspended / deactivating / deleted).
- **401 PASSWORD_NOT_SET**: user exists with identifier but no password row (e.g. OAuth-created).
`

const collection = {
  info: {
    name: 'Auth API — errors & scenarios',
    description: infoDesc,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'sessionId', value: '' },
    { key: 'userId', value: '' },
    { key: 'testEmail', value: 'testuser@example.com' },
    { key: 'testPhone', value: '+15551234567' },
    { key: 'testPublicId', value: '34216590' },
    { key: 'testPassword', value: 'ValidPass1!' },
    { key: 'deviceId', value: '11111111-1111-1111-1111-111111111111' },
    { key: 'deviceName', value: 'Postman Client' },
    { key: 'oauthOnlyEmail', value: 'oauth-only-user@example.com' },
  ],
  item: [
    folder(
      '01 — Check availability',
      '| Case | Status | code |\n|------|--------|------|\n| Not registered | 200 | exists:false |\n| Registered | 200 | exists:true, authMethods[], passwordSet |\n| Bad email | 400 | INVALID_EMAIL |\n| Bad phone | 400 | INVALID_PHONE |\n| Bad body | 400 | INVALID_REQUEST |',
      [
        req(
          '200 — email not registered (unique)',
          'POST',
          '/check-availability',
          { provider: 'email', identifier: 'noreply-{{$timestamp}}@example.com' },
          'Expect: `{ exists: false, authMethods: [] }`',
          ["pm.test('HTTP 200', () => pm.expect(pm.response.code).to.eql(200));", "pm.test('exists false', () => pm.expect(pm.response.json().exists).to.eql(false));"],
        ),
        req(
          '200 — registered user (edit {{testEmail}})',
          'POST',
          '/check-availability',
          { provider: 'email', identifier: '{{testEmail}}' },
          'Expect: `{ exists: true, authMethods, passwordSet }`. Set **testEmail** in environment.',
          ["pm.test('HTTP 200', () => pm.expect(pm.response.code).to.eql(200));", "if (pm.response.code===200) { const j=pm.response.json(); pm.expect(j).to.have.property('passwordSet'); }"],
        ),
        req(
          '200 — phone lookup',
          'POST',
          '/check-availability',
          { provider: 'phone', identifier: '{{testPhone}}' },
          'Use E.164 **testPhone** in environment. Same response shape as email.',
          ['pm.test("HTTP 200", () => pm.expect(pm.response.code).to.eql(200));'],
        ),
        req(
          '400 — INVALID_EMAIL',
          'POST',
          '/check-availability',
          { provider: 'email', identifier: 'not-an-email' },
          'Service validates email format → AppError.',
          expect(400),
        ),
        req(
          '400 — INVALID_PHONE',
          'POST',
          '/check-availability',
          { provider: 'phone', identifier: '123' },
          'Not E.164 → INVALID_PHONE.',
          expect(400),
        ),
        req(
          '400 — INVALID_REQUEST (bad provider)',
          'POST',
          '/check-availability',
          { provider: 'google', identifier: 'x@y.com' },
          'Zod: provider must be email | phone.',
          expect(400),
        ),
      ],
      false,
    ),
    folder(
      '02 — Login /password — EMAIL',
      'Body: `provider:"email"`, `identifier`, `password`, `deviceName`, `deviceId`.\n\n| code | HTTP | When |\n|------|------|------|\n| USER_NOT_FOUND | 404 | Unknown email |\n| INVALID_CREDENTIALS | 401 | Wrong password |\n| PASSWORD_NOT_SET | 401 | OAuth-only user |\n| ACCOUNT_SUSPENDED | 403 | |\n| ACCOUNT_DEACTIVATING | 403 | details.canReactivate |\n| ACCOUNT_DELETED | 403 | |\n| INVALID_REQUEST | 400 | Zod |\n| DEVICE_ACCOUNT_LIMIT_REACHED | 400 | 3 accounts on device |\n| RATE_LIMITED | 429 | Too many tries |',
      [
        req(
          '200 — success (set {{testEmail}} {{testPassword}})',
          'POST',
          '/login/password',
          {
            provider: 'email',
            identifier: '{{testEmail}}',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'Saves accessToken, refreshToken, sessionId, userId to **collection variables** on 200.',
          saveTokensOn200,
        ),
        req(
          '404 — USER_NOT_FOUND',
          'POST',
          '/login/password',
          {
            provider: 'email',
            identifier: 'does-not-exist-{{$timestamp}}@example.com',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          '',
          expect(404),
        ),
        req(
          '401 — INVALID_CREDENTIALS',
          'POST',
          '/login/password',
          {
            provider: 'email',
            identifier: '{{testEmail}}',
            password: 'WrongPass9!',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'User must exist.',
          expect(401),
        ),
        req(
          '401 — PASSWORD_NOT_SET (manual)',
          'POST',
          '/login/password',
          {
            provider: 'email',
            identifier: '{{oauthOnlyEmail}}',
            password: 'AnyPass1!',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'Set **oauthOnlyEmail** to a user with **no** AuthPassword row. Expect **401** \\\`PASSWORD_NOT_SET\\\`. Wrong/missing user → **404**.',
          [
            'pm.test("401 PASSWORD_NOT_SET or 404", () => pm.expect([401,404]).to.include(pm.response.code));',
            "try { const j = pm.response.json(); if (j.code) console.log(j.code); } catch (e) {}",
          ],
        ),
        req(
          '400 — INVALID_REQUEST (empty deviceId)',
          'POST',
          '/login/password',
          {
            provider: 'email',
            identifier: '{{testEmail}}',
            password: '{{testPassword}}',
            deviceName: 'x',
            deviceId: '',
          },
          'deviceId min length 1.',
          expect(400),
        ),
        req(
          '400 — INVALID_REQUEST (invalid provider)',
          'POST',
          '/login/password',
          {
            provider: 'sms',
            identifier: '{{testEmail}}',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          '',
          expect(400),
        ),
      ],
      false,
    ),
    folder(
      '03 — Login /password — PHONE',
      'Same error codes as email; identifier must be valid E.164 after validation.',
      [
        req(
          '200 — success',
          'POST',
          '/login/password',
          {
            provider: 'phone',
            identifier: '{{testPhone}}',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'Set **testPhone** to registered user E.164.',
          saveTokensOn200,
        ),
        req(
          '404 — USER_NOT_FOUND',
          'POST',
          '/login/password',
          {
            provider: 'phone',
            identifier: '+19999999999',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'Unassigned E.164 (adjust if your DB uses this range).',
          expect(404),
        ),
        req(
          '400 — INVALID_PHONE (identifier)',
          'POST',
          '/login/password',
          {
            provider: 'phone',
            identifier: 'not-e164',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'Fails in validateProvider before DB.',
          expect(400),
        ),
        req(
          '401 — INVALID_CREDENTIALS',
          'POST',
          '/login/password',
          {
            provider: 'phone',
            identifier: '{{testPhone}}',
            password: 'WrongPass9!',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          '',
          expect(401),
        ),
      ],
      false,
    ),
    folder(
      '04 — Login /password — PUBLIC ID',
      '`provider: "publicId"`, `identifier` string of digits (e.g. `"34216590"`).\n\n| code | HTTP |\n|------|------|\n| INVALID_PUBLIC_ID | 400 | non-integer or negative |\n| USER_NOT_FOUND | 404 | unknown id |\n| (same auth errors as email) | |',
      [
        req(
          '200 — success',
          'POST',
          '/login/password',
          {
            provider: 'publicId',
            identifier: '{{testPublicId}}',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'Set **testPublicId** to user’s numeric public id (string).',
          saveTokensOn200,
        ),
        req(
          '400 — INVALID_PUBLIC_ID (non-numeric)',
          'POST',
          '/login/password',
          {
            provider: 'publicId',
            identifier: 'abc',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          '',
          expect(400),
        ),
        req(
          '400 — INVALID_PUBLIC_ID (negative)',
          'POST',
          '/login/password',
          {
            provider: 'publicId',
            identifier: '-1',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          '',
          expect(400),
        ),
        req(
          '404 — USER_NOT_FOUND',
          'POST',
          '/login/password',
          {
            provider: 'publicId',
            identifier: '999999999999999',
            password: '{{testPassword}}',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          'Use an id that does not exist.',
          expect(404),
        ),
        req(
          '401 — INVALID_CREDENTIALS',
          'POST',
          '/login/password',
          {
            provider: 'publicId',
            identifier: '{{testPublicId}}',
            password: 'WrongPass9!',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          '',
          expect(401),
        ),
      ],
      false,
    ),
    folder(
      '05 — Signup (OTP + password)',
      '| Step | Route | Errors |\n|------|-------|--------|\n| Send OTP | POST /signup/send-otp | 400 IDENTIFIER_TAKEN, 400 INVALID_*, 429 |\n| Verify | POST /signup/verify-otp | 400 OTP_INVALID, 429 |\n| Create | POST /signup/create-password | 400 WEAK_PASSWORD, OTP_NOT_VERIFIED, 409 USER_EXISTS, 201 OK |\n\nPassword rules: min 8, upper, lower, digit, special from set !@#$%^&*',
      [
        req(
          'signup/send-otp — 200 (new email)',
          'POST',
          '/signup/send-otp',
          { provider: 'email', identifier: 'newuser-{{$timestamp}}@example.com' },
          'May hit rate limit if repeated.',
          ['pm.test("200 or 429", () => pm.expect([200,429]).to.include(pm.response.code));'],
        ),
        req(
          'signup/send-otp — 400 IDENTIFIER_TAKEN',
          'POST',
          '/signup/send-otp',
          { provider: 'email', identifier: '{{testEmail}}' },
          'Use an email already registered.',
          expect(400),
        ),
        req(
          'signup/verify-otp — 400 OTP_INVALID',
          'POST',
          '/signup/verify-otp',
          { provider: 'email', identifier: 'any@example.com', otp: '00000' },
          'Wrong OTP.',
          expect(400),
        ),
        req(
          'signup/create-password — 400 OTP_NOT_VERIFIED',
          'POST',
          '/signup/create-password',
          {
            provider: 'email',
            identifier: 'neververified@example.com',
            password: 'ValidPass1!',
          },
          'No prior verify-otp.',
          expect(400),
        ),
        req(
          'signup/create-password — 400 WEAK_PASSWORD',
          'POST',
          '/signup/create-password',
          {
            provider: 'email',
            identifier: 'verified@example.com',
            password: 'weak',
          },
          'Only after OTP verified for that identifier (else OTP_NOT_VERIFIED first).',
          ['pm.test("400", () => pm.expect(pm.response.code).to.eql(400));'],
        ),
      ],
      false,
    ),
    folder(
      '06 — Complete profile (auth)',
      'Requires **Bearer {{accessToken}}** (temp JWT from create-password). Folder inherits Bearer auth.\n\nErrors: **401** UNAUTHORIZED, **409** PROFILE_ALREADY_COMPLETE, **400** INVALID_REQUEST, **400** if only one of deviceId/deviceName.',
      [
        req(
          '200 — complete profile (web defaults)',
          'POST',
          '/signup/complete-profile',
          {
            firstName: 'Test',
            lastName: 'User',
            country: 'US',
            gender: 'other',
          },
          'Omits deviceId → server uses `web-{userIdPrefix}` placeholder.',
          saveTokensOn200,
        ),
        req(
          '200 — with deviceId + deviceName (mobile)',
          'POST',
          '/signup/complete-profile',
          {
            firstName: 'Test',
            lastName: 'User',
            country: 'US',
            gender: 'other',
            deviceId: '{{deviceId}}',
            deviceName: '{{deviceName}}',
          },
          'Send **both** deviceId and deviceName or **neither**.',
          saveTokensOn200,
        ),
        req(
          '401 — no token (disable folder auth for this request)',
          'POST',
          '/signup/complete-profile',
          { firstName: 'A', lastName: 'B', country: 'US', gender: 'other' },
          'In Postman: Auth tab → **No auth** for this request only (overrides folder Bearer).',
          expect(401),
        ),
        req(
          '400 — deviceId without deviceName',
          'POST',
          '/signup/complete-profile',
          {
            firstName: 'A',
            lastName: 'B',
            country: 'US',
            gender: 'other',
            deviceId: '{{deviceId}}',
          },
          'Zod refine fails.',
          expect(400),
        ),
        req(
          '409 — PROFILE_ALREADY_COMPLETE',
          'POST',
          '/signup/complete-profile',
          {
            firstName: 'A',
            lastName: 'B',
            country: 'US',
            gender: 'other',
          },
          'Run only when user **status** is already **active** (repeat after first success).',
          expect(409),
        ),
      ],
      true,
    ),
    folder(
      '07 — Refresh',
      '',
      [
        req(
          '200 — rotate tokens',
          'POST',
          '/refresh',
          { refreshToken: '{{refreshToken}}' },
          '',
          [
            'pm.test("200", () => pm.expect(pm.response.code).to.eql(200));',
            'if (pm.response.code === 200) {',
            '  const j = pm.response.json();',
            "  if (j.accessToken) pm.collectionVariables.set('accessToken', j.accessToken);",
            "  if (j.refreshToken) pm.collectionVariables.set('refreshToken', j.refreshToken);",
            '}',
          ],
        ),
        req(
          '401 — INVALID_REFRESH_TOKEN',
          'POST',
          '/refresh',
          { refreshToken: 'invalid.token.here' },
          '',
          expect(401),
        ),
      ],
      false,
    ),
    folder(
      '08 — Logout & session revoke',
      'Folder uses Bearer {{accessToken}}.',
      [
        req(
          '200 — logout (current session)',
          'POST',
          '/logout',
          {},
          '',
          ['pm.test("200", () => pm.expect(pm.response.code).to.eql(200));'],
        ),
        req(
          '200 — session/revoke by sessionId',
          'POST',
          '/session/revoke',
          { sessionId: '{{sessionId}}', revokeAllSessions: false },
          'Fails 400 if sessionId invalid UUID or not yours.',
          ['pm.test("200 or 400", () => pm.expect([200,400]).to.include(pm.response.code));'],
        ),
        req(
          '400 — session/revoke missing id and flag',
          'POST',
          '/session/revoke',
          {},
          'Empty body: need sessionId or revokeAllSessions.',
          expect(400),
        ),
      ],
      true,
    ),
    folder(
      '09 — Password reset',
      'Flow: send-otp → verify-otp (reset token) → confirm. Errors: **404** USER_NOT_FOUND, **400** NO_PASSWORD, OTP_INVALID, WEAK_PASSWORD, SAME_PASSWORD, **429**.',
      [
        req(
          'password/reset/send-otp',
          'POST',
          '/password/reset/send-otp',
          { identifier: '{{testEmail}}' },
          'Looks up by identifier across providers.',
          ['pm.test("200 or 404", () => pm.expect([200,404]).to.include(pm.response.code));'],
        ),
        req(
          'password/reset/send-otp — 404',
          'POST',
          '/password/reset/send-otp',
          { identifier: 'missing-{{$timestamp}}@example.com' },
          '',
          expect(404),
        ),
        req(
          'password/reset/verify-otp — 400 OTP_INVALID',
          'POST',
          '/password/reset/verify-otp',
          { identifier: '{{testEmail}}', provider: 'email', otp: '00000' },
          '',
          expect(400),
        ),
        req(
          'password/reset/confirm — 400 RESET_TOKEN_INVALID',
          'POST',
          '/password/reset/confirm',
          {
            resetToken: '00000000-0000-0000-0000-000000000000',
            newPassword: 'ValidPass1!',
          },
          '',
          expect(400),
        ),
      ],
      false,
    ),
    folder(
      '10 — Legacy login OTP (deprecated)',
      'Prefer /login/password. Errors: **404** USER_NOT_FOUND, **400** OTP_INVALID, account **403** same as password login.',
      [
        req(
          'login/send-otp — 404 USER_NOT_FOUND',
          'POST',
          '/login/send-otp',
          { provider: 'email', identifier: 'ghost-{{$timestamp}}@example.com' },
          '',
          expect(404),
        ),
        req(
          'login/verify-otp — 400 OTP_INVALID',
          'POST',
          '/login/verify-otp',
          {
            provider: 'email',
            identifier: '{{testEmail}}',
            otp: '00000',
            deviceName: '{{deviceName}}',
            deviceId: '{{deviceId}}',
          },
          '',
          expect(400),
        ),
      ],
      false,
    ),
    folder(
      '11 — OAuth (body validation)',
      'Real **200** needs valid provider tokens. Below: Zod **INVALID_REQUEST**.',
      [
        req(
          'oauth/google — 400 INVALID_REQUEST',
          'POST',
          '/oauth/google',
          { idToken: '', deviceName: 'x', deviceId: '{{deviceId}}' },
          'Empty idToken.',
          expect(400),
        ),
        req(
          'oauth/facebook — 400',
          'POST',
          '/oauth/facebook',
          { accessToken: '', deviceName: 'x', deviceId: '{{deviceId}}' },
          '',
          expect(400),
        ),
        req(
          'oauth/apple — 400',
          'POST',
          '/oauth/apple',
          { identityToken: '', deviceName: 'x', deviceId: '{{deviceId}}' },
          '',
          expect(400),
        ),
      ],
      false,
    ),
    folder(
      '12 — Settings / devices (auth)',
      '**GET** /settings — folder Bearer.',
      [
        {
          name: 'GET /settings — 200 or 401',
          request: {
            method: 'GET',
            header: [],
            url: '{{baseUrl}}/api/v1/auth/settings',
            description: 'Requires valid accessToken.',
          },
          event: [
            {
              listen: 'test',
              script: {
                exec: [
                  'pm.test("200 or 401", () => pm.expect([200,401]).to.include(pm.response.code));',
                ],
                type: 'text/javascript',
              },
            },
          ],
        },
      ],
      true,
    ),
  ],
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(collection, null, 2), 'utf8')
console.log('Wrote', out)
