# andromeda-ng

Single-page web app for a video livestream with schedule and chat.

This repo is a monorepo:

- Frontend (SPA) at repo root
- Chat backend in chat/

## Stack

- React + TypeScript + Vite
- Tailwind CSS v4
- Bun
- Chat backend: Node + Express + SQLite (Docker)

## Scripts (frontend)

- bun run dev
- bun run build
- bun run preview
- bun run lint

## Frontend config

Frontend is configured for same-origin hosting:

- HLS: /iptv/session/1/hls.m3u8
- Schedule XML: /iptv/xmltv.xml
- Chat API base: /chat

These are set in App.tsx so no environment variables are required.

## Chat backend (chat/)

Endpoints:

- POST /auth/register
	- body: { "nickname": "name", "password": "secret" }
	- returns: { "nickname", "token" }
- POST /auth/login
	- body: { "nickname": "name", "password": "secret" }
	- returns: { "nickname", "token" }
- GET /messages
	- header: Authorization: Bearer <token>
	- returns: { "messages": [{ id, nickname, body, created_at }] }
- GET /messages/public
	- returns: { "messages": [{ id, nickname, body, created_at }] }
- GET /messages/stream
	- query: ?token=<jwt>
	- SSE stream (authenticated)
- GET /messages/public/stream
	- SSE stream (public)
- POST /messages
	- header: Authorization: Bearer <token>
	- body: { "body": "hello" }
	- returns: { "message": { id, nickname, body, created_at } }
- POST /admin/clear
	- header: X-Admin-Token: <token>
	- clears chat history and broadcasts clear

Chat constraints:

- Username rules: 3-24 chars, letters/numbers/_/-
- Password length: 6-72
- Message length: 1-500
- Message history capped at 100 (server enforces)

### Chat backend env (chat/.env)

Required:

- JWT_SECRET
- ADMIN_TOKEN

Optional:

- PORT (default 3001)
- DB_PATH (default /data/chat.db in Docker)
- CORS_ORIGIN (when running behind same-origin proxy, can be https://example.com)

### Chat backend Docker

From chat/:

```
docker compose up -d --build
```

If env changes, rebuild/restart the container.

### Admin clear

When using same-origin proxy:

```
curl -X POST https://example.com/chat/admin/clear \
	-H "X-Admin-Token: YOUR_ADMIN_TOKEN"
```

If hitting the chat backend directly:

```
curl -X POST https://chat.example.com/admin/clear \
	-H "X-Admin-Token: YOUR_ADMIN_TOKEN"
```

## Production deployment (self-hosted frontend)

This setup uses Cloudflared tunnel to route example.com to an NGINX container.

### Build and copy frontend

```
bun run build
```

Copy dist/ to the server (example path):

- /srv/andromeda-ng/dist

### NGINX container config

NGINX listens on 80 inside the container and the host maps 9884 -> 80.

Example server block (inside container):

```
server {
		listen 80;
		server_name example.com;

		root /usr/share/nginx/html;
		index index.html;

		location / {
				try_files $uri $uri/ /index.html;
		}

		location /chat/ {
			proxy_pass http://10.0.0.1:3834/;
				proxy_set_header Host $host;
				proxy_set_header X-Real-IP $remote_addr;
				proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
				proxy_set_header X-Forwarded-Proto $scheme;

				proxy_http_version 1.1;
				proxy_set_header Connection "";
				proxy_buffering off;
				proxy_request_buffering off;
				proxy_cache off;
				proxy_read_timeout 1h;
				proxy_send_timeout 1h;
				add_header X-Accel-Buffering no;
		}

		location /iptv/ {
			proxy_pass http://10.0.0.1:8409/iptv/;
				proxy_set_header Host $host;
				proxy_set_header X-Real-IP $remote_addr;
				proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
				proxy_set_header X-Forwarded-Proto $scheme;

				# Rewrite absolute http URLs in playlists
				sub_filter_types application/vnd.apple.mpegurl text/plain;
				sub_filter 'http://example.com/iptv/' 'https://example.com/iptv/';
				sub_filter_once off;
		}
}
```

### Cloudflared tunnel

Single route:

- example.com -> http://10.0.0.1:9884

Replace example domains, IPs, and paths with your own values.

### Restart flow

When deploying new frontend:

1) bun run build
2) Copy dist/ to server
3) Restart NGINX container

When deploying new chat backend:

1) Copy chat/ to server
2) docker compose up -d --build (from chat/)

## Troubleshooting

- 502 from tunnel: NGINX not reachable on port 9884 or wrong container port mapping.
- Chat not realtime: ensure NGINX /chat/ has proxy_buffering off and SSE timeouts.
- Mixed content: playlist contains http URLs; keep NGINX sub_filter in /iptv/.
- CORS errors: avoid cross-origin by proxying /chat and /iptv under the same origin.
