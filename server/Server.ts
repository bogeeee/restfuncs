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
import {getAllFunctionNames, getMethodNames, isTypeInfoAvailable} from "./Util";
import {ServerSessionOptions, ServerSession} from "./ServerSession";
import session from "express-session";
import {ServerSocketConnection} from "./ServerSocketConnection";
import nacl from "tweetnacl";
import nacl_util from "tweetnacl-util"
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";
import {CookieSession, ServerPrivateBox} from "restfuncs-common";
import {reflect, ReflectedClass, ReflectedProperty} from "typescript-rtti";

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
 * These values should form one record in your session validation table. Or you could simply concatenate these to a string.
 */
export type ValidSessionRecord = {
    id: string,
    version: number,

    /**
     * See CookieSession#bpSalt
     */
    bpSalt: string
}

/**
 * A plugin that allows you to keep track of valid session records (whitelist). I.e. you could use a central (Redis) database.
 * The implementation also cares about the timing-out of records itself (not called from external)
 */
export abstract class SessionValidator {
    /**
     * Seconds, after which the records will time out. Undefined = no timeout
     */
    protected timeout?: Number

    /**
     *
     * @param timeout See {@link timeout}
     */
    constructor(timeout: Number) {
        this.timeout = timeout;
    }

    abstract add(record: ValidSessionRecord): Promise<void>;
    abstract has(record: ValidSessionRecord): Promise<boolean>;
    abstract delete(record: ValidSessionRecord): Promise<void>;
}

export class MemorySessionValidator extends SessionValidator {
    protected entries = new Set<string>()

    // TODO: Implement timeout

    protected recordToString(record: ValidSessionRecord) {
        return `${record.id}_${record.version}_${record.bpSalt}`
    }

    async add(record: ValidSessionRecord) {
        this.entries.add(this.recordToString(record));
    }

    async has(record: ValidSessionRecord) {
        return this.entries.has(this.recordToString(record));
    }

    async delete(record: ValidSessionRecord) {
        this.entries.delete(this.recordToString(record));
    }
}


export type ServerOptions = {

    /**
     * A secret to sign the session cookies (TODO: use word 'encrypt', depending on implementation) and to encrypt other necessary server2server tokens.
     * In a multi node environment, this must be shared with all instances.
     * @default A randomized value
     */
    secret?: String | Uint8Array,

    // Let's make some smart default implementation so we don't have to place a security mention into the docs. Again 1 line saved ;)
    // As soon as the user switches to a multi-node environment by setting the secret, this will trigger an Error that guides the user into deciding for an explicit choice. Keeps the docs short.
    /**
     * How to track, that an attacker cannot switch / replay the session to an old state by presenting an old jwt session token ?
     *   - memory (default): A whitelist of valid tokens is kept in memory. This is as safe as traditional non-JWT sessions but does not work on a multi-node environment !
     *   - {@link SessionValidator}: Plug in your own. I.e. use a fast Redis database.
     *   - false: No tracking. Sessions can be replayed as mentioned. Be aware of this in your app design. I.e. by just storing only the userId and eventually permissions in the session and other replay-sensitive stuff, like the basket items, in the database.
     * <p>
     * {@link https://redis.com/blog/json-web-tokens-jwt-are-dangerous-for-user-sessions/ More info on security and performance}
     * </p>
     * <p>
     * Note on blacklisting: Blacklisting (through external server / database) is not offered by restfuncs:
     * We've seen some JWT implementations and suggestions in the wild that offer those but let's be honest: This will never scale, be fast and keep security at the same time.
     * Imagine the time gap between the central database having the blacklisting transaction saved and published to all nodes. An attacker will just target that gap (i.e. try this a 1000 times on 2 nodes and you'll very likely get a lucky hit on that microsecond gap - it's just statistics)
     * </p>
     */
    sessionValidityTracking?: "memory" | SessionValidator | false

    /**
     * Default: 1 hour.
     */
    sessionTimeoutInSeconds?: number

    /**
     * Allows clients to connect via engine.io transports (websockets, long-polling, ...)
     * Default: true
     * @see engineIoOptions
     */
    installEngineIoServer?: boolean

    engineIoOptions?: AttachOptions & EngineIoServerOptions

    /**
     * Set to false, if you want to use your own session handler in express. {@link sessionValidityTracking} is not possible then !
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

    /**
     * Disable some conenience checks. You'll be notified when you need this.
     */
    _diagnosis_skipValidatingServerSessionFieldTypes?: boolean
}

/*
export type TransportToken = {
    tokenType: string
}
*/


/**
 * Additionally stores the type
 */
type Server2ServerEncryptedBox_inner<T> = {
    /**
     * <p>The typescript/js type name of value.</p>
     * We store the type so that an attacker can't confuse the server with a perfectly legal value but of a different type which may still have some interesting, intersecting properties.
     */
    type: string,

    value: T
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
     * Needed for NACL
     * @private
     */
    static readonly SECRET_LENGTH = 32;

    /**
     * Secret from {@link serverOptions#secret}  properly initialized as a SECRET_LENGTH sized Uint8Array. Initialized in the constructor.
     */
    secret!: Uint8Array

    /**
     * id -> service
     * The ServerSession constructor registers itself here.
     */
    serverSessionClasses = new Map<string, typeof ServerSession>()

    protected diagnosis_cookieSessionFieldTypes = new Map<string, ReflectedProperty>()

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

    public sessionValidator?: SessionValidator

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
        function normalizeSecret(secret: ServerOptions["secret"]): Uint8Array {
            if (secret === undefined) {
                return nacl.randomBytes(RestfuncsServerOOP.SECRET_LENGTH)
            }
            if (secret instanceof Uint8Array) {
                if(secret.length == RestfuncsServerOOP.SECRET_LENGTH) {
                    return secret;
                }
            }
            else if (typeof secret === "string") {
                if(secret === "") {
                    throw new Error("Secret must not be an empty string")
                }
            }
            else {
                throw new Error("Invalid type for secret: " + secret);
            }

            const hash = crypto.createHash('sha256');
            hash.update(secret);
            return hash.digest()

        }
        this.secret = normalizeSecret(this.serverOptions.secret);


        // Install session handler:
        if(this.serverOptions.installSessionHandler !== false) {
            // Install session handler: TODO: code own JWT cookie handler. It should also perform a validation, if used outside of a ServerSession's Express hander
            this.expressApp.use(session({
                secret: nacl_util.encodeBase64(this.secret),
                cookie: {sameSite: false}, // sameSite is not required for restfuncs's security but you could still enable it to harden security, if you really have no cross-site interaction.
                saveUninitialized: false, // Privacy: Only send a cookie when really needed
                unset: "destroy",
                store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against growing memory by a DOS attack. See https://www.npmjs.com/package/express-session
                resave: false
            }));

            // Install a Session validator:
            if(this.serverOptions.sessionValidityTracking === undefined) {
                if(this.serverOptions.secret) {
                    throw new Error("It seems, you are in a multi-node environment (ServerOptions#secret is set). You must then choose for a ServerOptions#sessionValidityTracking strategy. See the JsDoc there.");
                }

                this.sessionValidator = new MemorySessionValidator(this.serverOptions.sessionTimeoutInSeconds || 3600) // Default
            }
            else if(this.serverOptions.sessionValidityTracking === "memory"){
                this.sessionValidator = new MemorySessionValidator(this.serverOptions.sessionTimeoutInSeconds || 3600);
            }

            this.sessionValidator = undefined; // Hack, until we have out JWT session handler implemented. TODO: remove line
        }
        else {
            if(this.serverOptions.sessionValidityTracking) {
                throw new Error("Invalid ServerOptions: installSessionHandler is set to false, but sessionValidityTracking is set.")
            }
        }

        if(this.serverOptions.secret && this.serverOptions.installSessionHandler === false && this.serverOptions.installEngineIoServer !== false) {
            throw new Error("It seems, you are in a multi-node environment (ServerOptions#secret is set). You can't have at the same time serverOptions#installSessionHandler=false and serverOptions#installEngineIoServer=true (default)");
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
        if(this.serverOptions.installEngineIoServer !== false) {
            this.installEngineIoServer(server);
        }
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
     * Encrypts the value with this servers' secret key
     * @param value
     * @param type
     */
    public server2serverEncryptToken<T>(value: T, type: string): ServerPrivateBox<T> {
        const content: Server2ServerEncryptedBox_inner<T> = {
            type,
            value
        }

        const nonce = nacl.randomBytes(24);
        const encryptedToken = nacl.secretbox(nacl_util.decodeUTF8(brilloutJsonStringify(content)), nonce, this.secret);

        return {
            nonce: nacl_util.encodeBase64(nonce),
            content: nacl_util.encodeBase64(encryptedToken)
        }
    }

    /**
     * Decrypts the token with one of the secret keys and checks if matches the expected type.
     * @param encryptedToken Also does a safety check of any evil input
     * @param expectedType
     */
    public server2serverDecryptToken<T>(encryptedToken: ServerPrivateBox<T>, expectedType: string): T{
        // Safety check of evil input:
        if(!encryptedToken || typeof encryptedToken !== "object" || typeof encryptedToken.content !== "string" || typeof encryptedToken.nonce !== "string") {
            throw new Error("invalid token");
        }

        const nonceUint8Array = nacl_util.decodeBase64(encryptedToken.nonce);
        const tokenUint8Array = nacl_util.decodeBase64(encryptedToken.content);

        const contentUint8Array = nacl.secretbox.open(tokenUint8Array,nonceUint8Array, this.secret);
        if(contentUint8Array === null) {
            throw new Error("Token decryption failed. Make sure that all servers have the same ServerOptions#secret set.");
        }

        const content = brilloutJsonParse(nacl_util.encodeUTF8(contentUint8Array)) as Server2ServerEncryptedBox_inner<T>;
        if(content.type !== expectedType) {
            throw new Error(`The token has the wrong type. Expected: ${expectedType}, actual: ${content.type} `);
        }

        return content.value;
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

        if(isTypeInfoAvailable(clazz)) {
            this.diagnosis_validateServiceFieldTypes(clazz);
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
     * Makes sure, that the types of newService are compatible with the ones of already registered serverSessionClasses,
     * meaning they share the same cookie, so they must not declare a field with the same name but conflicting types
     */
    diagnosis_validateServiceFieldTypes(newService: typeof ServerSession) {
        if(this.serverOptions._diagnosis_skipValidatingServerSessionFieldTypes) {
            return;
        }

        if(!isTypeInfoAvailable(newService)) {
            throw new Error("Type info is not available for " + newService.name);
        }

        reflect(newService).properties.forEach(reflectedProp => {
            if(reflectedProp.isStatic) {
                return;
            }
            if(reflectedProp.class.class === ServerSession) {
                return; // Skip check for ServerSession's own fields
            }

            let existingProp = this.diagnosis_cookieSessionFieldTypes.get(reflectedProp.name); // Determine existing prop from other (registered) service
            if(existingProp) {
                if (reflectedProp.type.equals(existingProp.type)) {
                    return;
                }

                let sameStringified
                try {
                    sameStringified = reflectedProp.type.toString() === existingProp.type.toString();
                }
                catch (e) {
                    throw new Error(`Error (likely a bug), while checking the fields ${newService.name}#${reflectedProp.name} and ${existingProp.class.class.name}#${existingProp.name} for type compatibility: ${(e as Error)?.message || e}. \n Please enable ServerOptions#_diagnosis_skipValidatingServiceFieldTypes`);
                }
                if(!sameStringified) {
                    throw new Error(`It seems like the property ${newService.name}#${reflectedProp.name} is not compatible with ${existingProp.class.class.name}#${existingProp.name}. \nNote: This check is done because ServerSessions will share overlapping values via the same cookieSession (there's only one). \nUnfortunately this check sometimes generates false positives for fields of type object. In that case, enable ServerOptions#_diagnosis_skipValidatingServiceFieldTypes`);
                }
            }
            else {
                this.diagnosis_cookieSessionFieldTypes.set(reflectedProp.name, reflectedProp)
            }
        })
    }

    /**
     * Checks the validator, if the session is valid.
     * Creates an entry on demand, if this is a legal newer version of valid entry.
     * <p>
     * Internal, do not override.
     * </p>
     * @param cookieSession
     */
    async cookieSessionIsValid(cookieSession: CookieSession): Promise<boolean> {
        if (!this.sessionValidator) { // Validation disabled ?
            return true;
        }

        const record = {id: cookieSession.id, version: cookieSession.version, bpSalt: cookieSession.bpSalt};
        if (await this.sessionValidator.has(record)) {
            return true;
        }

        // It failed, but check, if this is a newer version:
        if(cookieSession.previousBpSalt) {
            const previousSessionRecord: ValidSessionRecord = {
                id: cookieSession.id,
                version: cookieSession.version - 1,
                bpSalt: cookieSession.previousBpSalt
            }
            if (!await this.sessionValidator.has(previousSessionRecord)) { // Yes, it is a newer version ?
                await this.sessionValidator.add(record)
                return true;
            }
        }

        return false;
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




