# pi-cosmic-core

Shared Effect v4 foundations for the extensions in the cosmic-pi workspace.

This package does not register a pi extension. It exposes Pi's host API as an Effect service, creates managed runtimes for Pi-hosted programs, and provides narrow Node filesystem/path and HTTP layers. Its JSON document and HTTP services translate platform failures into typed, secret-safe errors.

Additional shared schemas, lifecycle services, and test support will move here as each extension is migrated. The package is under active development on the Effect-first rearchitecture branch, and its API is not stable yet.
