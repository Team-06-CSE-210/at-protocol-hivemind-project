# Local PDS Hosting Setup (Spaces Alpha)

## Purpose

This documents the initial local AT Protocol PDS setup for the CSE 210 Hivemind project. The PDS is standard AT Protocol infrastructure; the Hivemind Coordinator is a separate service and has not yet been connected.

## Tested environment

- Intel Mac running macOS Monterey 12.7.6
- Docker Desktop with a working Docker Engine
- Image: `ghcr.io/bluesky-social/atproto:pds-spaces-alpha`
- Local endpoint: `http://localhost:3000`

## Start the local PDS

Pull the image:

```sh
docker pull ghcr.io/bluesky-social/atproto:pds-spaces-alpha
```

Generate **development-only** secrets in the same terminal used to start the container:

```sh
export PDS_JWT_SECRET="$(openssl rand -hex 32)"
export PDS_ADMIN_PASSWORD="$(openssl rand -hex 32)"
export PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX="$(openssl rand -hex 32)"
```

Run the container:

```sh
docker run --rm \
  --name hivemind-pds-test \
  -p 127.0.0.1:3000:3000 \
  -e PDS_HOSTNAME=localhost \
  -e PDS_DEV_MODE=true \
  -e PDS_DATA_DIRECTORY=/app/data \
  -e PDS_BLOBSTORE_DISK_LOCATION=/app/data/blobs \
  -e PDS_JWT_SECRET \
  -e PDS_ADMIN_PASSWORD \
  -e PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX \
  ghcr.io/bluesky-social/atproto:pds-spaces-alpha
```

Leave this terminal running. From another terminal, verify:

```sh
curl -i http://localhost:3000/xrpc/_health
curl -s http://localhost:3000/xrpc/com.atproto.server.describeServer
```

## Verified results (November 15, 2026)

- Health endpoint returned `HTTP/1.1 200 OK`.
- `describeServer` returned `"spacesAlpha": true` and `"inviteCodeRequired": true`.
- Created a single-use invite code through the admin-authenticated `com.atproto.server.createInviteCode` endpoint.
- Created a local `.test` account using `com.atproto.server.createAccount`.
- Successfully authenticated with `com.atproto.server.createSession` (`LOGIN SUCCESS`).

These checks verify local PDS startup, advertised Spaces Alpha support, and account registration/login. **They do not yet verify creation or access control of an actual Space.**

## Remaining work

1. Test Space creation, membership/access, and authenticated reads/writes using the Spaces Alpha API.
2. Connect the Hivemind Coordinator and its SDK adapters to the real local PDS.
3. Run end-to-end tests against the local alpha stack.
4. Add persistent Docker storage and reproducible configuration before retaining any test data.
5. For a future public deployment, configure a real domain, HTTPS, and appropriate DID/service identity records.

## Safety and limitations

- `PDS_DEV_MODE=true` and `localhost` are for **local development only**, not production.
- The command uses `--rm` without a persistent volume: container data can disappear after the container is removed.
- Spaces Alpha is experimental; do not use sensitive or irreplaceable data.
- Never commit or share actual JWTs, passwords, PLC private keys, invite codes, or session tokens.
- The Hivemind Coordinator's planned JSON/Postgres operational database is **separate** from the PDS's own local database.

Reference: *Hivemind Preliminary Prototype Summary*, especially the deployment layout and “Steps to run on the Spaces alpha” (pp. 24–26).
