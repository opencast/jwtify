// Some types for better code readability.
export type Milliseconds = number;
export type Seconds = number;

/** An Opencast event ID */
export type EventId = string;
/** Timestamp in seconds (since UNIX epoch) */
export type Timestamp = number;
/** A full JWT */
export type Jwt = string;
/** ID of a service worker client (usually a page), see `FetchEvent.clientId`. */
export type ClientId = string;

/** Additional information passed to the `getJwts` callback. */
export type GetJwtsInfo = {
    /**
     * ID of the client (usually a page) whose requests need these JWTs.
     * Batching is done per client, so all requested events belong to this
     * client. Can be passed to `self.clients.get()`. Is `""` for requests
     * without a client, e.g. navigation requests (static file opened directly
     * in a tab).
     */
    clientId: ClientId;
};

/** Configuration. See `DEFAULT_CONFIG` for default values! */
export type Config = {
    /**
     * All origins that serve static Opencast files. Requests with different
     * hosts are ignored. Note: only specify hosts you trust! While JWTs passed
     * to those hosts do not contain secrets, a MitM could use the JWTs to
     * access static files. Example: `["https://oc.example.com"]`.
     */
    trustedOcOrigins: string[];

    /**
     * List of possible path prefixes that should be handled. For most Opencast
     * systems, the default `["/static/"]` is fine.
     *
     * This corresponds to `org.opencastproject.download.url` in `custom.properties`
     * or `org.opencastproject.distribution.aws.s3.distribution.base` in
     * `org.opencastproject.distribution.aws.s3.AwsS3DistributionServiceImpl.cfg`.
     *
     * Must start and end with `/`.
     */
    pathPrefixes?: string[];

    /**
     * Callback to retrieve JWTs for events. This would usually be a fetch
     * request to your backend server which holds the private key to sign the
     * JWTs. That route would need to perform authorization, usually by checking
     * the session cookie.
     *
     * First argument is a list of Opencast IDs (of events). Must return a `Map`
     * that maps from Opencast event IDs to JWTs. Usually the map contains one
     * entry per entry in `eventIds`, but if access to an event should not be
     * granted, don't include a JWT for that event. The function takes multiple
     * event IDs to allow batching (to reduce number of API requests).
     *
     * The second argument holds additional information, see `GetJwtsInfo`.
     */
    getJwts: (eventsIds: Set<EventId>, info: GetJwtsInfo) => Promise<Map<EventId, Jwt>>;

    /**
     * Minimum time (in seconds) that JWTs still have to be valid for in order
     * for them to be used. JWTs with `exp - cacheMinTokenTimeLeft` in the past
     * are considered stale. Needs to be shorter than the total JWT validity
     * time (configured in the JWT generator), otherwise cached JWTs are never
     * used.
     */
    cacheMinTokenTimeLeft?: Seconds;

    /**
     * Number of milliseconds to wait for other requests in order to batch
     * multiple "get JWT for event" operations. Defaults to a small number, just
     * big enough to batch requests that occur basically at the same time (e.g.
     * on page load or scrolling multiple loading="lazy" images into view). Only
     * requests from the same client are batched together. Set to 0 to disable
     * batching.
     */
    batchWindow?: Milliseconds;

    /**
     * Whether modified requests should use `mode: "cors"`. This is required
     * when they are cross origin (i.e. different domain). If you can disable
     * it, do it as it saves some requests. But for most it's likely required,
     * thus the default is `true`.
     */
    cors?: boolean;

    /** If `true`, this library emits debugging logs via `console.debug`. */
    debugLog?: boolean;
};

/** Configuration defaults. */
export const DEFAULT_CONFIG = {
    pathPrefixes: ["/static/"],
    cors: true,
    cacheMinTokenTimeLeft: 5,
    batchWindow: 3,
    debugLog: false,
} satisfies Partial<Config>;

type FullConfig = Required<Config>;

// For correct TS typing
declare let self: ServiceWorkerGlobalScope;

// Declare experimental APIs not yet supported by all browsers.
declare const URLPattern: {
    new(input: object): unknown;
} | undefined;
type InstallEventExt = ExtendableEvent & {
    addRoutes?: (routes: Array<{
        condition: object;
        source: "network" | "fetch-event";
    }>) => void;
};

/**
 * Type of the message a page sends to the active service worker if the page is
 * not controlled by it, e.g. after a hard reload (which bypasses the service
 * worker). The service worker then clears its JWT cache and claims all clients.
 */
const RESET_AND_CLAIM = "jwtify:reset-and-claim";

/** Returned by `setUpServiceWorker`. */
export type Handle = {
    cache: {
        /** Adds a JWT to the cache, same as if it was returned from `getJwts()` */
        add: (eventId: EventId, token: Jwt) => void;
    };
};

/**
 * Sets up the service worker to intercept & authenticate OC requests. Usually,
 * you only have to call this in your service worker. Adds the `install`,
 * `activate`, `fetch` and `message` event handlers.
 */
export const setUpServiceWorker = (configIn: Config): Handle => {
    const ctx = new Context(configIn);
    ctx.log("Setting up service worker with full config: ", ctx.config);

    // Make sure a downloaded service worker is immediately activated and starts
    // controlling all clients (pages).
    self.addEventListener("install", (event: InstallEventExt) => {
        ctx.log("on 'install'");
        self.skipWaiting();

        if (event.addRoutes && URLPattern) {
            ctx.log("static routing supported: registering routes");

            // We only want to only intercept specific requests and default to
            // "network". Earlier rules have higher priority, so we first define
            // what requests to intercept and then have catch-all.
            event.addRoutes([
                {
                    condition: {
                        // As far as I can tell, there is no support for "alternatives" in
                        // the URL pattern API, so we manually construct all possible
                        // origin + prefix combinations. A single regex with that knowledge
                        // could be faster, but it's fine for now.
                        or: ctx.config.trustedOcOrigins.flatMap(origin => (
                            ctx.config.pathPrefixes.map(prefix => ({
                                urlPattern: `${origin}${prefix}*`,
                            }))
                        )),
                    },
                    source: "fetch-event",
                },
                {
                    condition: {
                        urlPattern: new URLPattern({}),
                    },
                    source: "network",
                },
            ]);
        }
    });

    self.addEventListener("activate", e => {
        ctx.log("on 'activate'");
        e.waitUntil(self.clients.claim());
    });

    self.addEventListener("fetch", e => onFetch(e, ctx));

    // Sent by `setUpClient` if the page is not controlled by us although we are
    // active. That's usually due to a hard reload, which we treat as "start
    // fresh", so we also clear the cache.
    self.addEventListener("message", e => {
        if (e.data?.type === RESET_AND_CLAIM) {
            ctx.log("on 'message': clearing cache and claiming clients");
            ctx.cache.clear();
            e.waitUntil(self.clients.claim());
        }
    });

    return {
        cache: {
            add: (eventId: EventId, token: Jwt) => {
                ctx.cache.add(eventId, token);
            },
        },
    };
};


/** Options for `setUpClient`. */
export type SetUpClientOptions = {
    /** If `false`, the service worker is unregistered instead. Default: `true`. */
    enabled?: boolean;

    /**
     * Scope of the service worker, passed to `register()`. Default: the
     * directory of the service worker script.
     */
    scope?: string;

    /** Maximum time to wait for the page to be controlled. Default: 3000. */
    timeout?: Milliseconds;
};

/**
 * Result of `setUpClient`:
 * - `"controlled"`: the page is controlled by the service worker.
 * - `"disabled"`: `enabled` was `false`, the service worker got unregistered
 *   (if it was registered before).
 * - `"timeout"`: the page did not get controlled within the timeout.
 * - `"failed"`: registering or unregistering threw an error (which is logged).
 * - `"unsupported"`: the browser has no service worker API, e.g. because the
 *   page is not served via HTTPS.
 */
export type SetUpClientResult = "controlled" | "timeout" | "failed" | "unsupported" | "disabled";

/**
 * Sets up the page side: registers the service worker at `scriptUrl` and
 * waits until it controls this page. Call this on every page load, as early
 * as possible. Requests made before the page is controlled bypass the service
 * worker and thus won't have a JWT attached. So you likely want to wait for
 * the returned promise before loading static files. If the page is already
 * controlled, the promise resolves immediately.
 *
 * If `enabled` is `false`, the service worker is unregistered instead, so that
 * it does not linger after the feature has been disabled. This is meant for a
 * global config switch: all pages in the scope have to agree on it, otherwise
 * they keep unregistering each other's service worker. Note that pages that are
 * already controlled stay so until they are closed or navigate away.
 *
 * Never rejects, errors are logged instead.
 */
export const setUpClient = async (
    scriptUrl: string,
    options: SetUpClientOptions = {},
): Promise<SetUpClientResult> => {
    const { enabled = true, scope, timeout = 3000 } = options;

    if (!("serviceWorker" in navigator)) {
        if (enabled) {
            // eslint-disable-next-line no-console
            console.warn("[jwtify] Service workers not supported: "
                + "requests for static files won't have JWTs attached");
        }
        return "unsupported";
    }

    if (enabled) {
        // Whether the page is controlled by our SW. We need to check the path, to
        // ignore controllers for a larger scope.
        const scriptPath = new URL(scriptUrl, document.baseURI).pathname;
        const isControlled = () => {
            const controller = navigator.serviceWorker.controller;
            return !!controller && new URL(controller.scriptURL).pathname === scriptPath;
        };

        // Listen before registering to not miss the event.
        const controllerChanged = new Promise<void>(resolve => {
            navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        });

        // Register SW, even if the page is already controlled to apply changed script URLs.
        const registeredAndControlled = navigator.serviceWorker
            .register(scriptUrl, { scope, updateViaCache: "none" })
            .then(
                registration => {
                    // If our SW is already active, but does not control this
                    // page, this is usually due to a hard reload. In that case,
                    // the SW would never take control on its own. On the first
                    // visit, there is no active SW yet, and it claims this page
                    // when it gets activated.
                    if (!isControlled() && registration.active) {
                        registration.active.postMessage({ type: RESET_AND_CLAIM });
                    }
                    return controllerChanged.then(() => "controlled" as const);
                },
                e => {
                    // eslint-disable-next-line no-console
                    console.error("[jwtify] Failed to register service worker", e);
                    return "failed" as const;
                },
            );

        // Check whether the page is already controlled, for example when this is
        // not the first visit.
        if (isControlled()) {
            return "controlled";
        }

        // Wait for SW to control this page (with timeout).
        //
        // We can't use `navigator.serviceWorker.ready` here: it only waits for an
        // active SW, which does not mean that this page is controlled (e.g. after
        // a hard reload, it isn't). And it never rejects.
        const result = await Promise.race([
            registeredAndControlled,
            new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), timeout)),
        ]);

        if (result === "timeout") {
            // eslint-disable-next-line no-console
            console.warn(`[jwtify] Page not controlled by service worker after ${timeout}ms: `
                + "requests for static files won't have JWTs attached");
        }
        return result;
    } else {
        // Like `register()`, resolve a given scope relative to the page, and
        // default to the script's directory.
        const scopeUrl = scope === undefined
            ? new URL("./", new URL(scriptUrl, document.baseURI))
            : new URL(scope, document.baseURI);

        try {
            // `getRegistration` returns the registration whose scope is the
            // longest prefix of the given URL. If ours does not exist, that
            // could be an unrelated service worker with a wider scope, so we
            // check that the scope matches exactly.
            const registration = await navigator.serviceWorker.getRegistration(scopeUrl.href);
            if (registration?.scope === scopeUrl.href) {
                await registration.unregister();
            }
            return "disabled";
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error("[jwtify] Failed to unregister service worker", e);
            return "failed";
        }
    }
};


const onFetch = (event: FetchEvent, ctx: Context) => {
    ctx.log("on 'fetch' for ", event.request.method, event.request.url);
    const url = new URL(event.request.url);
    if (!ctx.trustedOcOrigins.has(url.origin)) {
        return;
    }

    // If the path is not one we recognize, we don't change the request.
    const parsed = parsePath(url.pathname, ctx.config);
    if (!parsed) {
        return;
    }

    // Inject JWT
    event.respondWith((async () => {
        const cachedJwt = ctx.cache.get(parsed.eventId);
        let jwt;
        if (cachedJwt) {
            ctx.log("using cached JWT for", parsed.eventId);
            jwt = cachedJwt;
        } else {
            jwt = await ctx.getJwt(parsed.eventId, event.clientId);
        }

        // If we get a JWT for the event, we inject it into the request.
        let req = event.request;
        if (jwt) {
            const headers = new Headers(event.request.headers);
            headers.set("Authorization", `Bearer ${jwt}`);
            req = new Request(event.request, {
                headers,
                // We have to use CORS as we set the `Authorization` header for
                // cross origin requests.
                ...ctx.config.cors && { mode: "cors" },
            });
        } else {
            ctx.log("No JWT for request for", req.url);
        }
        return fetch(req);
    })());
};


class Context {
    public config: FullConfig;
    public trustedOcOrigins: Set<string>;
    public log: (s: string, ...rest: unknown[]) => void;
    public cache: Cache;
    /** Currently open batches, at most one per client. */
    public batches: Map<ClientId, {
        task: Promise<Map<EventId, Jwt>>;
        eventIds: Set<EventId>;
    }> = new Map();
    /**
     * Lookups currently in progress, per client and event. Keyed by client as
     * well, as different clients might answer differently.
     */
    public pending: Map<ClientId, Map<EventId, Promise<Jwt | null>>> = new Map();

    public constructor(configIn: Config) {
        this.config = { ...DEFAULT_CONFIG, ...configIn };

        // Check config
        if (this.config.pathPrefixes.some(p => !p.startsWith("/") || !p.endsWith("/"))) {
            throw new Error("config error: pathPrefixes must start and end with '/'");
        }
        if (this.config.batchWindow < 0.0) {
            throw new Error("config error: `batchWindow` must not be negative");
        }
        if (Number.isNaN(this.config.batchWindow) || !Number.isFinite((this.config.batchWindow))) {
            throw new Error("config error: `batchWindow` must be finite and not NaN");
        }

        this.cache = new Cache(this.config);
        this.trustedOcOrigins = new Set(this.config.trustedOcOrigins);
        this.log = this.config.debugLog
            // eslint-disable-next-line no-console
            ? (s: string, ...rest: unknown[]) => console.debug("[jwtify] " + s, ...rest)
            : (..._: unknown[]) => {};
    }

    /**
     * Gets a JWT for the event and adds it to the cache. If a lookup for the
     * same client and event is already in progress, waits for that one instead
     * of starting another.
     */
    public getJwt(eventId: EventId, clientId: ClientId): Promise<Jwt | null> {
        const pendingOfClient = this.pending.get(clientId)
            ?? new Map<EventId, Promise<Jwt | null>>();
        const existing = pendingOfClient.get(eventId);
        if (existing) {
            this.log(`waiting for pending lookup (client '${clientId}') for`, eventId);
            return existing;
        }

        const lookup = (async () => {
            try {
                const jwt = await this.getJwtBatched(eventId, clientId);
                if (jwt) {
                    this.cache.add(eventId, jwt);
                }
                return jwt;
            } finally {
                // This runs after the `set` calls below, as there is at least
                // one `await` before.
                pendingOfClient.delete(eventId);
                if (pendingOfClient.size === 0) {
                    this.pending.delete(clientId);
                }
            }
        })();
        pendingOfClient.set(eventId, lookup);
        this.pending.set(clientId, pendingOfClient);
        return lookup;
    }

    /**
     * Gets a JWT for the event, potentially batching multiple requests of the
     * same client.
     */
    private async getJwtBatched(eventId: EventId, clientId: ClientId): Promise<Jwt | null> {
        const info = { clientId };
        let jwts;
        if (this.config.batchWindow <= 0) {
            // If batching is disabled, just immediately fetch.
            this.log(`batching disabled, immediately fetching JWT (client '${clientId}') for`, eventId);
            jwts = await this.getJwtsCallback(new Set([eventId]), info);
        } else {
            let batch = this.batches.get(clientId);
            if (batch) {
                this.log(`adding to batch (client '${clientId}'):`, eventId);
                batch.eventIds.add(eventId);
            } else {
                this.log(`starting new batch (client '${clientId}') with`, eventId);
                const eventIds = new Set([eventId]);
                batch = {
                    eventIds,
                    // The promise is simply a sleep for `batchWindow` and then
                    // a fetch.
                    task: new Promise(resolve => {
                        setTimeout(() => {
                            this.log(`fetching batch (client '${clientId}') with ${eventIds.size} events`);
                            // Remove the batch right before we're starting the
                            // fetch so that a new batch can be started. Otherwise,
                            // event IDs added to the batch would be ignored.
                            this.batches.delete(clientId);
                            this.getJwtsCallback(eventIds, info).then(jwts => {
                                resolve(jwts);
                            });
                        }, this.config.batchWindow);
                    }),
                };
                this.batches.set(clientId, batch);
            }

            // Awaiting batch task. Meaning all concurrent executions waiting on
            // it will wake up at the same time.
            jwts = await batch.task;
        }

        return jwts.get(eventId) ?? null;
    }

    private async getJwtsCallback(
        eventIds: Set<EventId>,
        info: GetJwtsInfo,
    ): Promise<Map<EventId, Jwt>> {
        try {
            const out = await this.config.getJwts(eventIds, info);
            if (!eventIds.isSubsetOf(out)) {
                // Not a problem, as that's how `getJwts` denies access.
                this.log(
                    `'getJwts' returned no JWT for some events (client '${info.clientId}'):`,
                    [...eventIds].filter(id => !out.has(id)),
                );
            }
            return out;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error("'getJwts' callback errored!", e);
            return new Map();
        }
    }
}


/** Caching JWTs for reuse while they are still fresh enough. */
class Cache {
    private cacheMinTokenTimeLeft: Seconds;
    private tokens: Map<EventId, {
        exp: Timestamp;
        token: Jwt;
    }> = new Map();
    private purgePlanned = false;

    public constructor(config: FullConfig) {
        this.cacheMinTokenTimeLeft = config.cacheMinTokenTimeLeft;
    }

    public get(eventId: EventId): Jwt | null {
        const entry = this.tokens.get(eventId);
        if (!entry) {
            return null;
        }
        if (!isExpFresh(entry.exp, this.cacheMinTokenTimeLeft)) {
            this.tokens.delete(eventId);
            return null;
        }
        return entry.token;
    }

    public add(eventId: EventId, token: Jwt) {
        let exp;
        try {
          exp = expOfJwt(token);
        } catch (e) {
          console.warn("failed to get 'exp' from JWT, not adding to cache", e);
          return;
        }
        const entry = this.tokens.get(eventId);
        if (entry) {
            if (entry.exp < exp) {
                entry.exp = exp;
                entry.token = token;
            }
        } else {
            this.tokens.set(eventId, { exp, token });
        }
        this.planPurge();
    }

    public clear() {
        this.tokens.clear();
    }

    private planPurge() {
        if (!this.purgePlanned) {
            this.purgePlanned = true;
            const nextExp = Math.min(...this.tokens.values().map(entry => entry.exp));
            const msTillStale = 1000 * (nextExp - Date.now() / 1000 - this.cacheMinTokenTimeLeft);
            // Add 500ms as buffer and protect against 32bit overflow.
            const delay = Math.min(msTillStale + 500, 2 ** 31 - 1);
            setTimeout(() => {
                this.purgeStaleEntries();
                this.purgePlanned = false;
                if (this.tokens.size > 0) {
                    this.planPurge();
                }
            }, delay);
        }
    }

    private purgeStaleEntries() {
        for (const [key, entry] of this.tokens.entries()) {
            if (!isExpFresh(entry.exp, this.cacheMinTokenTimeLeft)) {
                this.tokens.delete(key);
            }
        }
    }
}


/** Whether `exp` is at least `minTimeLeft` seconds in the future. */
const isExpFresh = (exp: Timestamp, minTimeLeft: Seconds): boolean => (
    exp >= Date.now() / 1000 + minTimeLeft
);

/**
 * Extracts the `exp` claim from a JWT, throwing an error if the JWT is
 * malformed or has no valid `exp` claim. Note: the signature is NOT verified!
 */
export const expOfJwt = (jwt: Jwt): Timestamp => {
    const parts = jwt.split(".");
    if (parts.length != 3) {
      throw new Error("JWT not valid");
    }

    // `btoa` uses a different alphabet than JWT, so we need to adjust it.
    const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");

    // In the future, replace by `Uint8Array.fromBase64`
    const binString = atob(base64);
    const bytes = Uint8Array.from(binString, m => m.codePointAt(0)!);
    const utf8Json = new TextDecoder().decode(bytes);
    const payload = JSON.parse(utf8Json);

    if (!("exp" in payload) || typeof payload.exp !== "number") {
        throw new Error("JWT does not have valid 'exp' claim");
    }
    return payload.exp;
};

type ParsedPath = {
    prefix: string;
    org: string;
    channel: string;
    eventId: string;
    suffix: string;
};

const parsePath = (path: string, config: FullConfig): ParsedPath | null => {
    const prefix = config.pathPrefixes.find(prefix => path.startsWith(prefix));
    if (!prefix) {
        return null;
    }

    const withoutPrefix = path.slice(prefix.length);
    const parts = withoutPrefix.split("/");
    if (parts.length < 4) {
        return null;
    }

    const [org, channel, eventId, ...suffix] = parts;
    return {
        prefix,
        org,
        channel,
        eventId,
        suffix: suffix.join("/"),
    };
};
