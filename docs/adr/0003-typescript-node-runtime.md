# Use TypeScript and Node.js for the service and CLI

The HTTP service, Agent kernel, and reference CLI will share a TypeScript and Node.js runtime. This accepts Node-specific operational choices in exchange for one typed contract across asynchronous runs, tools, storage, and client code, while avoiding a polyglot first release.
