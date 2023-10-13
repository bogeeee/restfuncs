import type {Server as HttpServer,} from "node:http";
import http, {createServer} from "node:http";
import expressApp, {Express} from "express";
import _ from "underscore";
import {RestfuncsOptions, ServerSession} from "./ServerSession";

export const PROTOCOL_VERSION = "1.1" // ProtocolVersion.FeatureVersion

export type SessionHeader = {
    /**
     * Random id
     *
     * TODO: For JWT: track a set of valid session ids in memory, so an attacker can't grab out an old session and replay it.
     */
    id: string

    /**
     * Increased every time, a value changed
     *
     * The http connection can't trust version jumps that were offered it (it might be a replay attack).
     * Contrary: The websocket connection can trust upjumps (it may have missed an update). Cause they were
     */
    version: number
}

/**
 * A plugin that allows you to keep track valid session tokens (whitelist). I.e. you could use a central (Redis) database.
 * <p>
 * Like Set (partial). The string argument to the methods is a composition of the session-id + version.
 * </p>
 *
 */
export type SessionValidator = Pick<Set<string>, "has" | "add" | "delete">


export type ServerOptions = {
    /**
     * TODO: like session
     * @default A randomized value
     */
    secret?: string | string[],

    // Let's make some smart default implementation so we don't have to place a security mention into the docs. Again 1 line saved ;)
    // As soon as the user switches to a multi-node environment by setting the secret, this will trigger an Error that guides the user into deciding for an explicit choice. Keeps the docs short.
    /**
     * TODO: Implement
     * TODO: If secret is set, we assume a multi-node environment. Force this option to be explicitly set then.
     * TODO: Implement / mention timeouts.
     * How to track, that an attacker cannot switch / replay the session to an old state by presenting an old jwt session token ?
     *   - memory (default): A whitelist of valid tokens is kept in memory. This is as safe as traditional non-JWT sessions but does not work on a multi-node environment !
     *   - {@link SessionValidator}: Plug in your own. I.e. use a fast Redis database.
     *   - false: No tracking. Sessions can be replayed as mentioned. Be aware of this in your app design. I.e. by just storing only the userId and eventually permissions in the session and other replay-sensitive stuff, like the basket items, in the database.
     * <p>
     * {@link https://redis.com/blog/json-web-tokens-jwt-are-dangerous-for-user-sessions/ More info on security and performance}
     * </p>
     * <p>
     * Note ob blacklisting: Blacklisting (through external server / database) is not offered by restfuncs:
     * We've seen some JWT implementations and suggestions in the wild that offer those but let's be honest: This will never scale, be fast and keep security at the same time.
     * Imagine the time gap between the central database having the blacklisting transaction saved and published to all nodes. An attacker will just target that gap (i.e. try this a 1000 times on 2 nodes and you'll very likely get a lucky hit on that microsecond gap - it's just statistics)
     * </p>
     */
    sessionValidityTracking?: "memory" | SessionValidator | false
}

/*
export type TransportToken = {
    tokenType: string
}
*/


/**
 * The content is encrypted and can only be read by this server, or another server that shares {@link Server#secret}
 * <p>
 * Encrypted (+MAC'ed) value in a box that points to the correct secret key that should be used to decrypt it.
 * </p>
 * - The box was encrypted by the server and it's authenticity can be trusted. It's meant to be decrypted by the server again / the client can't see the content.
 * - It stores a content type to prevent spoofing with a token on stock with a different types
 *
 */
export type ServerPrivateBox<Content> = {
    /**
     * Key index (keep names short to fit in cookie JWT's)
     */
    keyIdx: string,

    /**
     * Encrypted content
     */
    enc: string;
}

/**
 * Additionally stores the type
 */
type Server2ServerEncryptedBox_inner = {
    /**
     * <p>The typescript/js type name of value.</p>
     * We store the type so that an attacker can't confuse the server with a perfectly legal value but of a different type which may still have some interesting, intersecting properties.
     */
    type: string,

    value: unknown
}



/**
 * The restfuncs http and websockets server
 * Comes with session handler and methods to retrieve the csrfToken
 * Secrets to
 *
 * All Services are registered here, once they're instantiated.
 * Makes sure then, they have unique IDs and use the same initial session value
 */
export type RestfuncsServer = RestfuncsServerOOP & Express


/**
 * Declare it in a nice OOP way and in the end it becomes merged into Express (= 'import express from Express')
 * Note that express is the main object, so instanceof does not work. See constructor
 * TODO: how to subclass this
 */
class RestfuncsServerOOP {
    serverOptions: ServerOptions

    /**
     * Secrets, indexed by a 64bit hash, so a token can quickly point which secret should be used for encryption
     */
    indexedSecrets!: Record<string, string>

    /**
     * id -> service
     * The ServerSession constructor registers itself here. TODO
     */
    private services = new Map<string, typeof ServerSession>()

    // Hope we don't get to the point where we need the group object (not only the id) - as it will always turn out so ;)
    private cache_service2SecurityGroupIdMap?: Map<typeof ServerSession, string>

    expressApp: Express;

    private expressOriginalMethods: Partial<Express> = {};

    /**
     * the low-level http server where this is attached to
     */
    public httpServer?: HttpServer;

    /**
     * The low-level (node:)http server (or a similar interface) where this RestfuncsServer will be attached to as a handler
     * @param options
     * @param httpServerToAttachTo
     */
    constructor(options: ServerOptions) {
        // TODO: Copy the properties from the default/fallback server to this


        this.serverOptions = options;

        function extend(target: {[index: string]: any }, base: {[index: string]: any }) {
            [...Object.keys(base), ..._.functions(base)].map(propName => {
                target[propName] = base[propName];
            })
        }

        // *** Merge an express-app with this ***

        this.expressApp  = expressApp()

        // Safe the original methods before they get overwritten
        _.functions(this).map(method => {
            // @ts-ignore
            this.expressOriginalMethods[method] = this.expressApp[method]; // save method
        })

        const result = this.expressApp;
        extend(result, this);

        /*
        // We could use this variant with the following nice error handler. But then we might have a situation, where ie. req.app returns the expressApp because it still has it saved in some closure. It's risky to hard to find errors.

        // Handler functions that returns a better error message cause we would have no chance to install the websockets handler via createServer(app)
        const result = () => {
            throw new Error("Don't use http.createServer(app) or createServer(app). Use app.attachTo(createServer()) instead.")
        }

        extend(result, this.expressApp)
        extend(result, this)
        */

        this.constructor2.apply(result, [])

        return <RestfuncsServer> <any> result;
    }

    protected constructor2() {
        // Within here, we can properly use "this" again:

        this.indexedSecrets = {} //TODO

        //TODO: install CORS and csrfprotection handler for legacy express routes
        //TODO: install session handler

        // Register single instance:
        if(instance === undefined) {
            instance = <RestfuncsServer> <any> this;
        }
        else {
            // TODO: if(instance.diagnosis_isFallback) throw new Error("A fallback RestfuncsExpress already exists. Make sure to initialize 'app = RestfuncsExpress()' before any ServerSession is instantiated."); // TODO: include the stacktrace in diagnosis_isFallback
            instance = "multipleInstancesExist"
        }
    }

    /**
     * Replacement of the listen methods
     * @param args
     */
    listen(...args: unknown[]): HttpServer {
        // @ts-ignore
        const server: HttpServer =  this.expressOriginalMethods.listen.apply(this, args);
        this.installWebsocketsHandler(server)
        return server;
    }

    protected installWebsocketsHandler(server: HttpServer) {
        // TODO:
    }

    attachTo(server: HttpServer) {

    }

    /**
     * Encrypts the token with this servers' secret key
     * @param token
     * @param tokenType
     */
    public encryptToken<T>(token: T, tokenType: string): ServerPrivateBox<T> {
        const content: Server2ServerEncryptedBox_inner = {
            type: tokenType,
            value: token
        }
        throw new Error("TODO")
    }

    /**
     * Decrypts the token with one of the secret keys and checks if matches the expected type
     * @param encryptedToken
     * @param expectedType
     */
    public decryptToken<T extends object>(encryptedToken: ServerPrivateBox<T>, expectedType: string): T{
        // TODO: check expectedType
        throw new Error("TODO")
    }

    public registerService(service: typeof ServerSession) {
        if(this.cache_service2SecurityGroupIdMap) {
            throw new Error("Cannot add a service after cache_service2SecurityGroupIdMap has been computed");
        }

        // TODO: check uniqueness and stuff like in ServerSession.checkIfIdIsUnique()

        this.services.set(service.id, service);
    }

    /**
     * Don't override. Not part of the API
     * @param serviceClass
     * @return A hash that groups together services with the same security relevant settings.
     * TODO: write testcases
     */
    public getSecurityGroupIdOfService(serviceClass: typeof ServerSession): string {
        const result = this.getService2SecurityGroupIdMap().get(serviceClass);
        if(result === undefined) {
            throw new Error("Illegal state: serviceClass not inside service2SecurityGroupIdMap. Was it registered for another server ?")
        }
        return result;
    }

    private getService2SecurityGroupIdMap() {
        if(this.cache_service2SecurityGroupIdMap) { // Has been computed yet ?
            return this.cache_service2SecurityGroupIdMap
        }

        const relevantProperties: (keyof RestfuncsOptions)[] = ["basicAuth", "allowedOrigins", "csrfProtectionMode", "devForceTokenCheck"]
        // Go through all services and collect the groups
        const groups: {options: RestfuncsOptions, members: (typeof ServerSession)[]}[] = []
        this.services.forEach((service) => {
            for(const group of groups) {
                if(  _(relevantProperties).find( key => group.options[key] !== service.options[key] ) === undefined ) { // Found a group where all relevantProperties match ?
                    group.members.push(service); // add to existing
                }
                else {
                    groups.push({options: service.options, members:[service]}); // create a new one
                }
            }
        });

        // Compose result:
        this.cache_service2SecurityGroupIdMap = new Map<typeof ServerSession, string>()
        for(const group of groups) {
            // Calculate groupId:
            let tokens = relevantProperties.map(key => {
                const value = group.options[key];
                if(typeof value === "function") {
                    return "function_used_by_" +  group.members.map(m => m.id).sort().join("_");
                }
                else {
                    return value;
                }
            });
            const groupId = JSON.stringify(tokens); // TODO hash and limit to 48bit

            for(const service of group.members) {
                this.cache_service2SecurityGroupIdMap.set(service, groupId);
            }
        }

        return this.cache_service2SecurityGroupIdMap
    }

    /**
     * <p>The tokens (multiple) for all services, comma separated.</p>
     * You can use this multi-value string everywhere where a single token is expected. They're tried out all then. To reduce overhead when dealing with a large number of services, services with the same security properties share the same token.
     * @param session
     */
    public getCsrfTokens(session: object): string {
        return Array.from(this.getService2SecurityGroupIdMap().values()).map( (groupId) => {
            throw new Error("TODO: implement")
        }).join(",")
    }
}

let instance: RestfuncsServer | undefined | "multipleInstancesExist"

/**
 * Drop in replacement for
 *
 * <pre>
 * const app = express()
 * </pre>
 *
 * @param options
 */
export function restfuncsExpress(options?: ServerOptions): RestfuncsServer {

    return <RestfuncsServer> new RestfuncsServerOOP(options || {});
}

/**
 * Gets the one and only global server instance. Throws an error if multiple exist. Creates a fallback instance if needed (for standalone case TODO)
 */
export function getServerInstance() {
    if(!instance) {
        throw new Error("TODO: handle case with no explicitly created Server. Create a default one and flag it as fallback") // safe the stacktrace in instance.diagnosis_isFallback

        throw new Error("No RestfuncsServer has been created yet. Please do so first via TODO")
    }
    if(instance === "multipleInstancesExist") {
        throw new Error("Multiple RestfuncsServer instances exist Please specify it explicitly")
    }
    return instance;
}

export function develop_resetGlobals() {
    instance = undefined;
}

/*
export function attach(httpServer: HttpServer, options: ServerOptions) {
    const server = new RestfuncsServerOOP(options);
    server.attachTo(httpServer);
    return server;
}
*/




