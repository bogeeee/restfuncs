import _ from "underscore"
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify"
import {CSRFProtectionMode, IServerSession, WelcomeInfo} from "restfuncs-common";
import {ClientSocketConnection} from "./ClientSocketConnection";
import {isNode, SingleRetryableOperation} from "./Util";

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

    static formatError(e: any): string {
        if (typeof (e) == "object") {
            return (e.name ? (e.name + ": ") : "") + (e.message || e) +
                (e.stack ? `\nServer stack:\n ${e.stack}` : '') +
                (e.fileName ? `\nFile: ${e.fileName}` : '') + (e.lineNumber ? `, Line: ${e.lineNumber}` : '') + (e.columnNumber ? `, Column: ${e.columnNumber}` : '') +
                (e.cause ? `\nCause: ${ServerError.formatError(e.cause)}` : '')
        } else {
            return e;
        }
    }

    constructor(rawErrorObject: unknown, options: ErrorOptions, httpStatusCode: Number | undefined) {
        const message = ServerError.formatError(rawErrorObject)
        super(message, {cause: rawErrorObject ,...options});
        this.cause = rawErrorObject;
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
    controlProxy_http: ClientProxy<S>

    protected _corsReadToken?: string

    public csrfToken?: string

    /**
     * The node fetch implementation lacks of cookie support, so we implement this ourself
     * @protected
     */
    protected _nodeCookie?: string;

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

    protected _getWelcomeInfoOp = new SingleRetryableOperation<WelcomeInfo>()

    async getWelcomeInfo(): Promise<WelcomeInfo> {
        return await this._getWelcomeInfoOp.exec(async () => await this.controlProxy_http.getWelcomeInfo());
    }

    protected _getClientSocketConnectionOp = new SingleRetryableOperation<ClientSocketConnection | undefined>()
    /**
     * Creates the ClientSocketConnection, synchronized for multiple simultaneous calls.     *
     * @protected
     * @return the connection or undefined if the server does not support it.
     */
    protected async getClientSocketConnection(): Promise<ClientSocketConnection | undefined> {
        return await this._getClientSocketConnectionOp.exec(async () => {
            const welcomeInfo = await this.getWelcomeInfo();

            if(!welcomeInfo.engineIoPath) {
                return undefined;
            }

            // Safety check:
            if (ClientSocketConnection.engineIoOptions.path && ClientSocketConnection.engineIoOptions.path != welcomeInfo.engineIoPath) {
                throw new Error(`SocketConnection.engineIoOptions.path has already been set to a different value.`)
            }

            ClientSocketConnection.engineIoOptions.path = welcomeInfo.engineIoPath;

            // Compose url: ws(s)://host/port
            const fullUrl = new URL(this.absoluteUrl.toString().replace(/^http/, "ws"))
            fullUrl.pathname = "";
            fullUrl.search = "";
            fullUrl.hash = ""; // Clear everything after host and port

            return await ClientSocketConnection.getInstance(fullUrl.toString(), this);
        });
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
        const conn = await this.getClientSocketConnection();
        if (!conn) { // Server did not offer sockets ?
            return await this.doCall_http(remoteMethodName, args); // Fallback to http
        }

        return await conn.doCall(this, (await this.getWelcomeInfo()).classId, remoteMethodName, args);
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

            throw new ServerError(responseJSON, {}, response.status);
        }
    }

    /**
     * Like fetch (from the browser api) but with a better errormessage and poly filled session handling for  node
     * @param request
     */
    async httpFetch(url: string, request: RequestInit) {
        if(isNode && this._nodeCookie) {
            request.headers = {...(request.headers || {}), "Cookie": this._nodeCookie}
        }

        try {
            const result = await fetch(url, request);

            if(isNode) {
                const setCookie = result.headers.get("Set-Cookie");
                if (setCookie) {
                    this._nodeCookie = setCookie;
                }
            }

            return result;
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
     * Closes all associated connections (if not shared and used by other clients)
     */
    public async close() {
        if(!this._getClientSocketConnectionOp.resultPromise) { // We have not tried to open a ClientSocketConnection yet ?
            return;
        }
        const conn = await this.getClientSocketConnection();
        conn?.unregisterClient(this);
    }
}