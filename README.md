# jwtify ("jotify")

A TypeScript library for injecting JWTs into static file requests via service workers.
Can be used by applications that wish to use static files from Opencast, authorized via JWTs.
This library intercepts all Opencast requests, injecting a JWT as appropriate.
The JWT must be supplied by you (via specified callback).
Supports batching and caching.

> **Note**: still in early development!

TOOD: explain more, describe how to use.
