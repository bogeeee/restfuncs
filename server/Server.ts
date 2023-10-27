// Diagnosis for web packagers. Please keep this at the file header:
import {Buffer} from 'node:buffer'; // *** If you web packager complains about this line, it did not properly (tree-)shake off your referenced ServerSession class and now wants to include ALL your backend code, which is not what we want. It can be hard to say exactly, why it decides to follow (not tree-shake) it, so Keep an eye on where you placed the line: `new RestfuncsClient<YourServerSession>(...)` or where you included YourServerSession in a return type. **
Buffer.alloc(0); // Provoke usage of some stuff that the browser doesn't have. Keep this here !

import type {Server as HttpServer,} from "node:http";
import crypto from "node:crypto";
import http, {createServer} from "node:http";
import expressApp, {application, Express} from "express";
import {
    attach as engineIoAttach,
    AttachOptions,
    Server,
    ServerOptions as EngineIoServerOptions,
    Socket
} from "engine.io"
import _ from "underscore";
import {getAllFunctionNames, getMethodNames} from "./Util";
import {ServerSessionOptions, ServerSession} from "./ServerSession";
import session from "express-session";
import {ServerSocketConnection} from "./ServerSocketConnection";


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
     * A secret to sign the session cookies (TODO: use word 'encrypt', depending on implementation) and to encrypt other necessary server2server tokens.
     * In a multi node environment, this must be shared with all instances.
     * @default A randomized value
     */
    secret?: String | Buffer,

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

    engineIoOptions?: AttachOptions & EngineIoServerOptions

    /**
     * Set to false, if you want to use your own session handler in express.
     * Default: true
     */
    installSessionHandler?: boolean

    /**
     * <strong>Not yet implemented</strong>
     * Holds all session values as references (in memory, plain, natual), instead of serializing it into a cookie string. The cookie will then contain only the id.
     * Enable, if you're not in a multi node environment (/no need to be stateless) and if you want to:
     *  - store the values directly (i.e. the user object instead of the user id)
     *  - improve performance
     *  - have unlimited space for your session values without hitting cookie-size limits.
     *
     * But keep in mind that DOS attacks could aim to blow up your memory then.
     *
     * Default: false
     */
    inMemorySessions?: boolean

    /**
     * Performance: Disable this (recommended), to only fetch an access proof per security group.
     * Keep in mind the rare case, that, if you have a proxy that tries to block the url to a certain ServerSession, this won't work anymore.
     * Therefore the default is: true (enabled)
     */
    socket_requireAccessProofForIndividualServerSession?: boolean
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

    /**
     * Fake property. To make ServerPrivateBox typesafe, we must reference 'Content' somewhere
     */
    _type: Content
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


export class SecurityGroup {
    static relevantProperties: (keyof ServerSessionOptions)[] = ["basicAuth", "allowedOrigins", "csrfProtectionMode", "devForceTokenCheck"];
    options: ServerSessionOptions
    members: (typeof ServerSession)[]  = []

    protected _id?: string
    get id() {
        return this._id || (this._id = this.calculateId()); // from cache or calculate
    }

    constructor(options: ServerSessionOptions, members: typeof ServerSession[]) {
        this.options = options;
        this.members = members;
    }

    protected calculateId() {
        let tokens = SecurityGroup.relevantProperties.map(key => {
            const value = this.options[key];
            if (typeof value === "function") {
                return "function_used_by_" + this.members.map(m => m.id).sort().join("_");
            } else {
                return value;
            }
        });
        const jsonString = JSON.stringify(tokens);

        // Return a hash of jsonString:
        const hash = crypto.createHash('sha256');
        hash.update(jsonString);
        return hash.digest('base64').substring(0, 8);  // 48bit entropy should be enough - just need to prevent collisions
    }
};

/**
 * Declare it in a nice OOP way and in the end it becomes merged into Express (= 'import express from Express')
 * Note that express is the main object, so instanceof does not work. See constructor
 * TODO: how to subclass this
 */
class RestfuncsServerOOP {
    readonly serverOptions: Readonly<ServerOptions>


    /**
     * Secret from {@link serverOptions#secret} as a Buffer. Initialized in the constructor.
     */
    secret!: Buffer

    /**
     * id -> service
     * The ServerSession constructor registers itself here.
     */
    serverSessionClasses = new Map<string, typeof ServerSession>()

    /**
     * computed / cached values, after all serverSessionClasses have been registered.
     * @private
     */
    _computed?: {
        securityGroups: Map<string, SecurityGroup>
        service2SecurityGroupMap: Map<typeof ServerSession, SecurityGroup>

        diagnosis_triggeredBy: Error;
    }

    /**
     * Internal wrapped express app.
     * <p>
     * Use it externally, when there's no other way.
     * </p>
     */
    public expressApp: Express;

    private expressOriginalMethods: Partial<Express> = {};

    /**
     * the low-level http server where this is attached to
     */
    public httpServer?: HttpServer;

    public engineIoServers = new Set<Server>();

    public getEngineIoPath() {
        return this.serverOptions.engineIoOptions?.path || "/engine.io_restfuncs"
    }

    diagnosis_creatorCallStack!: Error

    /**
     * The low-level (node:)http server (or a similar interface) where this RestfuncsServer will be attached to as a handler
     * @param options
     * @param httpServerToAttachTo
     */
    constructor(options: ServerOptions) {
        // TODO: Copy the properties from the default/fallback server to this


        this.serverOptions = options;

        function extend(target: {[index: string]: any }, base: {[index: string]: any }) {
            [...Object.keys(base), ...Array.from(getMethodNames(base)) as string[]].map(propName => {
                target[propName] = base[propName];
            })
        }

        // *** Merge an express-app with this ***

        this.expressApp  = expressApp()

        // Safe the original methods before they get overwritten
        getAllFunctionNames(this).forEach(n => {
            const name = n as keyof Express
            if(this.expressApp[name as keyof Express]) {
                this.expressOriginalMethods[name] = this.expressApp[name]; // save method
            }
        });

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

        // initialize this.secret:
        this.secret = ((): Buffer => {
            const secret = this.serverOptions.secret;
            if (secret === undefined) {
                return crypto.randomBytes(32)
            }
            if (secret instanceof Buffer) {
                    return secret
            } else if (typeof secret === "string") {
                if(secret === "") {
                    throw new Error("Secret must not be an empty string")
                }
                else if(secret.length < 8) {
                    throw new Error("Secret too short")
                }
                return Buffer.from(secret);
            }
            throw new Error("Invalid type for secret: " + secret);
        })()

        // Install session handler:
        if(this.serverOptions.installSessionHandler !== false) {
            // Install session handler: TODO: code own JWT cookie handler
            this.expressApp.use(session({
                secret: this.secret.toString("hex"),
                cookie: {sameSite: false}, // sameSite is not required for restfuncs's security but you could still enable it to harden security, if you really have no cross-site interaction.
                saveUninitialized: false, // Privacy: Only send a cookie when really needed
                unset: "destroy",
                store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against growing memory by a DOS attack. See https://www.npmjs.com/package/express-session
                resave: false
            }));
        }

        // Register single instance:
        if(instance) {
            throw new Error("A RestfuncsServer instance already exists. There can be only one.", {cause: instance.diagnosis_creatorCallStack});
        }
        instance = <RestfuncsServer> <any> this;
        this.diagnosis_creatorCallStack = new Error("This one created the other instance"); // Diagnosis
    }

    /**
     * Replacement of the listen method
     * @param args
     */
    listen(...args: unknown[]): HttpServer {
        // @ts-ignore
        const server: HttpServer =  this.expressOriginalMethods.listen.apply(this, args);
        const engineIoServer = this.installEngineIoServer(server);
        return server;
    }

    public installEngineIoServer(server: HttpServer) {
        const engineIoServer = engineIoAttach(server, {
            ...(this.serverOptions.engineIoOptions || {}),
            path: this.getEngineIoPath(),
        });

        // Modify closeAllConnections function to also close the engineIoServer. Otherwise we leave unwanted side effects / open resources. This also makes the jest testcases hang.
        const closeAllConnections_orig = server.closeAllConnections;
        server.closeAllConnections = () => {
            closeAllConnections_orig.apply(server, []); // Call original
            engineIoServer.close();
        }

        this.engineIoServers.add(engineIoServer);

        engineIoServer.on('connection', (socket: Socket) => {
           new ServerSocketConnection(this as any as RestfuncsServer, socket);
        });

        return engineIoServer;
    }

    /**
     * Attach to an existing server
     * @param server
     */
    attachTo(server: HttpServer) {
        throw new Error("This method does not work. Please use listen(...) if possible. If not possible, then use:\n const server = http.createServer(app.expressApp);\n app.installEngineIoServer(server);")
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

    public registerServerSessionClass(clazz: typeof ServerSession) {
        if(this._computed) {
            throw new Error("Cannot register a ServerSession class after dependant values have already been computed. Make sure that you register / app.use(YourServerSession.createExpressHandler()) all your classes before the first use (http request).", {cause: this._computed.diagnosis_triggeredBy});
        }

        if(!clazz.id) {
            throw new Error("id not set");
        }

        // Check uniqueness:
        let existingClazz = this.serverSessionClasses.get(clazz.id);
        if(existingClazz && existingClazz !== clazz) {
            throw new Error(`There is already another ServerSession class registered with the id: '${clazz.id}'. Make sure, you have unique class names or otherwise implement the id field accessor in your class(es)`);
        }

        this.serverSessionClasses.set(clazz.id, clazz);
    }

    /**
     * Don't override. Not part of the API
     * @param serviceClass
     * @return A hash that groups together serverSessionClasses with the same security relevant settings.
     * TODO: write testcases
     */
    public getSecurityGroupOfService(serviceClass: typeof ServerSession): SecurityGroup {
        const result = this.getComputed().service2SecurityGroupMap.get(serviceClass);
        if(result === undefined) {
            throw new Error("Illegal state: serviceClass not inside service2SecurityGroupIdMap. Was it registered for another server ?")
        }
        return result;
    }

    getComputed()  {
        if(this._computed) {
            return this._computed;
        }

        return this._computed = {
            ...this.computeSecurityGroups(),
            diagnosis_triggeredBy: new Error("This call triggered the computation. Make sure that this is AFTER all your classes have been registered.")
        };
    }
    protected computeSecurityGroups() {

        // Go through all serverSessionClasses and collect the securityGroups
        const securityGroups = new Map<string, SecurityGroup>();
        this.serverSessionClasses.forEach((service) => {
            function matchesGroup(group: SecurityGroup) {
                return _(SecurityGroup.relevantProperties).find(key => group.options[key] !== service.options[key]) === undefined;
            }

            const matchedGroups = Array.from(securityGroups.values()).filter( g => matchesGroup(g));

            if(matchedGroups.length == 0) {
                const newGroup = new SecurityGroup(service.options, [service]);

                // Safety check:
                if(securityGroups.has(newGroup.id)) {
                    throw new Error("id not unique");
                }

                securityGroups.set(newGroup.id, newGroup);
            }
            else if(matchedGroups.length == 1) {

                matchedGroups[0].members.push(service); // add to existing
            }
            else {
                throw new Error("Illegal state")
            }
        });


        // Compose serviceClass2SecurityGroupMap:
        const service2SecurityGroupMap = new Map<typeof ServerSession, SecurityGroup>()
        for (const group of securityGroups.values()) {
            for (const service of group.members) {
                service2SecurityGroupMap.set(service, group);
            }
        }

        return {securityGroups, service2SecurityGroupMap}
    }


    /**
     * <p>The tokens (multiple) for all serverSessionClasses, comma separated.</p>
     * You can use this multi-value string everywhere where a single token is expected. They're tried out all then. To reduce overhead when dealing with a large number of serverSessionClasses, serverSessionClasses with the same security properties share the same token.
     * @param session
     */
    public getCsrfTokens(session: object): string {
        return Array.from(this.getComputed().service2SecurityGroupMap.values()).map( (group) => {
            throw new Error("TODO: implement")
        }).join(",")
    }
}



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

let instance: RestfuncsServer | undefined

/**
 * Gets the one and only global server instance. Creates a fallback instance if needed
 */
export function getServerInstance() {
    if(!instance) {
        instance = restfuncsExpress(); // Create an instance as fallback
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




