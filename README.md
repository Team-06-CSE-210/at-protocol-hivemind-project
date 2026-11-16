# at-protocol-hivemind-project

Hivemind protocol contracts and service implementations.

Run a step-by-step offer-routing demonstration with Node.js 24.x; this version
needs no package installation and uses test validators:

```sh
npm run demo:offers:local
```

To run the same demonstration with generated AT Protocol validators:

```sh
npm ci
npm run demo:offers
npm test
```

Requires Node.js 24.x. The build generates the protocol types and validators using
the AT Protocol Spaces alpha pinned in [ADR-001](docs/ADR.md). The example uses
generated validators and in-memory transport/storage. `npm run test:unit` runs
the routing unit tests without installed dependencies or generated code.

See [Offer routing](docs/offer-routing.md) for the flow, module boundaries,
dependencies to supply, and integration checks.
