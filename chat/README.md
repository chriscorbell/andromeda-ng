# Chat Backend

Simple chat backend with nickname/password auth and a 100-message history cap.

## Endpoints

- POST /auth/register
  - body: { "nickname": "name", "password": "secret" }
  - returns: { "nickname", "token" }

- POST /auth/login
  - body: { "nickname": "name", "password": "secret" }
  - returns: { "nickname", "token" }

- GET /messages
  - header: Authorization: Bearer <token>
  - returns: { "messages": [{ id, nickname, body, created_at }] }

- POST /messages
  - header: Authorization: Bearer <token>
  - body: { "body": "hello" }
  - returns: { "message": { id, nickname, body, created_at } }

- POST /admin/clear
  - header: X-Admin-Token: <token>
  - returns: { "ok": true }

## Local dev

npm install
npm run dev

## Docker

- Build and run:
  - docker compose up -d --build

- Update JWT_SECRET before deploying.
- Set ADMIN_TOKEN to enable the admin clear endpoint.

## Notes

- Nickname must be 3-24 chars: letters, numbers, underscore, hyphen.
- Password length: 6-72 chars.
- Message length: 1-500 chars.
- Messages are trimmed to the latest 100 after each insert.
