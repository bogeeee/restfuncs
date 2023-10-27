import _ from "underscore"
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify"
import {CSRFProtectionMode, IServerSession, WelcomeInfo} from "restfuncs-common";
import {ClientSocketConnection} from "./ClientSocketConnection";

const SUPPORTED_SERVER_PROTOCOL_MAXVERSION = 1
const REQUIRED_SERVER_PROTOCOL_FEATUREVERSION = 1 // we need the brillout-json feature

/**
 * Redundant type exists on server
 */


/**
 * Thrown when there was an Error/exception thrown on the server during method call.
 */
export class ServerError extends Error {
    name= "ServerError"
    /**
     * The Error or exception string that was thrown on the server. We can't keep the orginal class hierarchy, so Errors will just become plain objects.
     */
    cause: any

    httpStatusCode?: Number

    constructor(message: string, options: ErrorOptions, httpStatusCode: Number | undefined) {
        super(message, options);
        this.httpStatusCode = httpStatusCode;
    }
}

/**
 * A filter / mapper for the service:
 * - Only methods (no fields)
 * - Sync methods are mapped to async methods, so you get an error if you forget the 'await'
 */
export type ClientProxy<S> = {
    [K in keyof S]: S[K] extends (...args: any) => Promise<any> ? S[K] : // All async methods
        S[K] extends (...args: infer P) => infer R ? (...args: P) => Promise<R> : // + remap the sync methods to async ones, so we must await them
            never;
};

/**
 * These fields are fetched and retried, if failed, in an atomic step.
 */
type PreparedSocketConnection = {
    /**
     * Retrieved from the server
     */
    serverSessionClassId: string,

    /**
     * Now here's the connection Shared with other services.
     * Undefined, if the server sayed, it did not support it.
     * @protected
     */
    conn?: ClientSocketConnection
};

/**
 * A method that's called here (on .proxy) get's send as a REST call to the server.
 *
 * @example Usage
 * <pre>
 * const remote = new RestfuncsClient<MyService>("/api").proxy
 * await remote.myMethod()
 * </pre>
 * @see restfuncsClient
 */
export class RestfuncsClient<S extends IServerSession> {
    readonly [index: string]: any;

    /**
     * Base url of the ServerSession (can be relative to the current url in the browser).
     * Either /[api route] or http(s)://your-server/[api route].
     * <p>'api route' is what you used on the server by 'app.use("[api route]", MyServerSession)'</p>
     */
    public url!: string;

    /**
     * Whether to use a fast engine.io (web-) socket for communication.
     * <p>
     * When using callbacks, this is needed.
     * </p>
     */
    public useSocket: boolean = true

    /**
     * HTTP Method for sending all (non-websocket) requests
     */
    public method = "POST";

    /**
     * This indicates to the server, how <strong>this client's</strong> session must be protected.
     */
    csrfProtectionMode: CSRFProtectionMode = "corsReadToken"

    /**
     * Remotely call (sync or async) methods on your ServerSession instance.
     */
    public proxy: ClientProxy<S>

    /**
     * Like proxy but for internal use. Goes straight to doCall_http
     * @protected
     */
    protected controlProxy_http: ClientProxy<S>

    protected _corsReadToken?: string

    public csrfToken?: string


    protected _preparedSocketConnection?: Promise<PreparedSocketConnection>

    get absoluteUrl() {
        // Validity check
        if(!this.url) {
            throw new Error("Url not set.");
        }

        if(typeof window !== 'undefined' && window?.location) { // In browser ?
            return new URL(this.url, window.location.href);
        }
        else {
            return new URL(this.url);
        }
    }

    /**
     * Creates the PreparedSocketConnection in one atomic step.
     * @protected
     */
    protected get preparedSocketConnection(): Promise<PreparedSocketConnection> {
        if(this._preparedSocketConnection) { // Promise is already initialized ?
            return this._preparedSocketConnection
        }

        return this._preparedSocketConnection = (async () => { // no 'await', just pass that promise on.
            try {
                const welcomeInfo = await this.controlProxy_http.getWelcomeInfo();
                let conn;
                if(welcomeInfo.engineIoPath) {

                    // Safety check:
                    if(ClientSocketConnection.engineIoOptions.path && ClientSocketConnection.engineIoOptions.path != welcomeInfo.engineIoPath) {
                        throw new Error(`SocketConnection.engineIoOptions.path has already been set to a different value.`)
                    }

                    ClientSocketConnection.engineIoOptions.path = welcomeInfo.engineIoPath;

                    // Compose url: ws(s)://host/port
                    const fullUrl = new URL(this.absoluteUrl.toString().replace(/^http/, "ws"))
                    fullUrl.pathname="";fullUrl.search="";fullUrl.hash=""; // Clear everything after host and port

                    conn = await ClientSocketConnection.getInstance(fullUrl.toString(), this);
                }
                return {
                    serverSessionClassId: welcomeInfo.classId,
                    conn
                };
            }
            catch (e) {
                this._preparedSocketConnection = undefined; // I.e. in case the server was just temporarily down, We don't leave a rejected promise forever. The next caller will try it's luck again.
                throw e;
            }
        })();
    }

    /**
     * Called on every remote method call. I.e.
     * <code><pre>
     *     this.proxy.**remoteMethodName**(**args**)
     * </pre></code>
     *
     * Override this method to intercept calls, handle errors, check for auth, filter args / results, ... whatever you like
     *
     * For accessing http specific options, override {@link doFetch} instead
     * @param remoteMethodName
     * @param args
     */
    public async doCall(remoteMethodName:string, args: any[]) {
        if(this.useSocket) {
            return await this.doCall_socket(remoteMethodName, args);
        }
        else {
            return await this.doCall_http(remoteMethodName, args);
        }
    }

    protected async doCall_socket(remoteMethodName: string, args: any[]) {
        const pConn = await this.preparedSocketConnection;
        if (!pConn.conn) { // Server did not offer sockets ?
            return await this.doCall_http(remoteMethodName, args); // Fallback to http
        }

        return await pConn.conn.doCall(pConn.serverSessionClassId, remoteMethodName, args);
    }

    protected async doCall_http(remoteMethodName: string, args: any[]) {
        const exec = async () => {
            let requestUrl: string;
            if(this.url) {
                requestUrl = `${this.url}${this.url.endsWith("/")?"":"/"}${remoteMethodName}`;
            }
            else {
                requestUrl=remoteMethodName;
            }

            // Prepare request:
            const req: RequestInit = {
                method: this.method,
                headers: {
                    'Content-Type': 'application/brillout-json',
                    'Accept': "application/brillout-json",
                    // Make sure you list these headers under Access-Control-Allow-Headers in server/index.js
                    // add keys only if needed:
                    ...(this.csrfProtectionMode?{csrfProtectionMode: this.csrfProtectionMode}: {}),
                    ...(this._corsReadToken?{corsReadToken: this._corsReadToken}:{}),
                    ...(this.csrfToken?{csrfToken: this.csrfToken}:{})
                },
                redirect: "follow",
                credentials: "include"
            }

            const r = await this.doFetch(remoteMethodName, args, requestUrl, req);
            return r.result;
        }

        try {
            return await exec();
        }
        catch (e) {
            // @ts-ignore
            if(typeof e === "object" && e?.httpStatusCode === 480) { // Invalid token error ? (we cant use "instanceof ServerError" for target:es5)
                await this.fetchCorsReadToken()
                return await exec(); // try once again;
            }
            else {
                throw e;
            }
        }
    }


    /**
     * Override this to intercept calls and have access to or modify http specific info.
     *
     *
     * @param funcName
     * @param args Args of the function. They get serialized to json in the request body
     * @param url
     * @param req The request, already prepared to be sent (without the body yet). You can still modify it. See https://developer.mozilla.org/en-US/docs/Web/API/Request
     */
    protected async doFetch(funcName: string, args: any[], url: string, req: RequestInit): Promise<{ result: any, resp: Response }> {
        req.body = brilloutJsonStringify(args);

        // Exec fetch:
        const response = <Response>await this.httpFetch(url, req);

        // Check server protocol version:
        const serverProtocolVersion = response.headers.get("restfuncs-protocol");
        if (serverProtocolVersion) {
            const [majorVersion, featureVersion] = serverProtocolVersion.split(".").map(str => Number(str));
            if (majorVersion > SUPPORTED_SERVER_PROTOCOL_MAXVERSION) {
                throw new Error(`Restfuncs server uses a newer protocol version: ${serverProtocolVersion}. Please upgrade the 'restfuncs-client' package`)
            }
            if (featureVersion < REQUIRED_SERVER_PROTOCOL_FEATUREVERSION) {
                throw new Error(`Restfuncs server uses a a too old protocol feature version: ${serverProtocolVersion}. Please upgrade the 'restfuncs' or the 'restfuncs-server' package on the server`)
            }
        } else {
            const responseText = await response.text();
            throw new Error(`Invalid response. Seems like '${this.url}' is not served by restfuncs cause there's no 'restfuncs-protocol' header field. Response body:\n${responseText}`);
        }

        if (response.status >= 200 && response.status < 300) { // 2xx ?
            // Parse result:
            const result = brilloutJsonParse(await response.text()); // Note: await response.json() makes some strange things with {} objects so strict comparision fails in tests
            return {result, resp: response};
        } else if (response.status == 550) { // "throw legal value" (non-error)
            const result = brilloutJsonParse(await response.text()); // Parse result:
            throw result;
        } else { // Other / Error
            const responseText = await response.text();

            let responseJSON;
            try {
                responseJSON = JSON.parse(responseText);
            } catch (e) { // Error parsing as json ?
                throw new Error(`Server error: ${responseText}`);
            }

            const formatError = (e: any): string => {
                if (typeof (e) == "object") {
                    return (e.name ? (e.name + ": ") : "") + (e.message || e) +
                        (e.stack ? `\nServer stack:\n ${e.stack}` : '') +
                        (e.fileName ? `\nFile: ${e.fileName}` : '') + (e.lineNumber ? `, Line: ${e.lineNumber}` : '') + (e.columnNumber ? `, Column: ${e.columnNumber}` : '') +
                        (e.cause ? `\nCause: ${formatError(e.cause)}` : '')
                } else {
                    return e;
                }
            }

            throw new ServerError(formatError(responseJSON), {cause: responseJSON}, response.status);
        }
    }

    /**
     * Like fetch (from the browser api) but with a better errormessage and fixed session handling in the testcases, cause support for session is missing when run from node
     * @param request
     */
    async httpFetch(url: string, request: RequestInit) {
        let response;
        try {
            return await fetch(url, request);
        } catch (e) {
            // @ts-ignore
            if (e?.cause) {
                // TODO: throw a better message than just "fetch failed" -> nah, the runtime sometimes doesn't show the cause properly. Try recompiling
            }
            throw e;
        }
    }

    async fetchCorsReadToken() {
        this._corsReadToken = await (this.proxy as any).getCorsReadToken();
    }

    /**
     *
     * @param url Base url of the ServerSession (can be relative to the current url in the browser).
     * Either /[api route] or http(s)://your-server/[api route].
     * <p>'api route' is what you used on the server by 'app.use("[api route]", MyServerSession)'</p>
     * @param options see the public fields (of this class)
     */
    constructor(url: string, options: Partial<RestfuncsClient<any>> = {}) {
        this.url = url;
        _.extend(this, options); // just copy all given options to this instance (effortless constructor)

        const client = this;
        // Create the proxy that translates this.myMethod(..args) into this.remoteMethodCall("myMethod", args)
        this.proxy = new Proxy({}, {
            get(target: {}, p: string | symbol, receiver: any): any {

                // Reject symbols (don't know what it means but we only want strings as property names):
                if(typeof p != "string") {
                    throw new Error(`Unhandled : ${String(p)}` );
                }

                // Handle the rest: p is the name of the remote method
                return function(...args: any) { return client.doCall(p, args)}
            }
        }) as ClientProxy<S>;

        // Same for the control proxy:
        this.controlProxy_http = new Proxy({}, {
            get(target: {}, p: string | symbol, receiver: any): any {
                // Reject symbols (don't know what it means but we only want strings as property names):
                if(typeof p != "string") {
                    throw new Error(`Unhandled : ${String(p)}` );
                }

                // Handle the rest: p is the name of the remote method
                return function(...args: any) { return client.doCall_http(p, args)}
            }
        }) as ClientProxy<S>;
    }

    /**
     * Close all associated connections
     */
    public async close() {
        if(this._preparedSocketConnection) {
            let conn = await this.preparedSocketConnection;
            conn.conn?.close();
            // TODO: instead, unregister from ClientSocketConnection.instances and it should close it implicitly then, when no other client is connected
        }
    }
}