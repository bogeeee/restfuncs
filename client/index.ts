import _ from "underscore"
import axios, {Method} from "axios";

/**
 * A method that's called here get's send as a REST call to the server.
 * @see createRESTFuncsClient
 */
export class RESTFuncsClient {
    readonly [index: string]: any;

    /**
     * Base url (relative to the current url in the browser)
     */
    public url!: string;
    public method = "POST";

    public async calleRemoteMethod(methodName: string, args: any[]) {

        let requestUrl: string;
        if(this.url) {
            requestUrl = new URL(methodName, this.url + (this.url.endsWith("/")?"":"/")).toString();
        }
        else {
            requestUrl=methodName;
        }


        try {
            const result = await axios(requestUrl, {
                method: this.method,
                headers: {},
                data: args,

            });
            return result.data;
        }
        catch (e: any) {
            if(e?.response?.data) {
                const serverError = e.response.data;
                throw new Error(`Server error: ${serverError.message || serverError}` + (serverError.stack?`\nServer stack:${serverError.stack}`:''));
            }
            throw e;
        }
    }

    /**
     *
     * @param props see the public fields (of this class)
     */
    constructor(props: Partial<RESTFuncsClient>) {
        _.extend(this, props); // just copy all given props to this instance (effortless constructor)

        // Create the proxy that translates this.myMethod(..args) into this.remoteMethodCall("myMethod", args)
        return new Proxy(this, {
            get(target: RESTFuncsClient, p: string | symbol, receiver: any): any {

                // Reject symbols (don't know what it means but we only want strings as property names):
                if(typeof p != "string") {
                    throw new Error(`Unhandled : ${String(p)}` );
                }

                // Handle normal property access:
                if(target[p] !== undefined) {
                    return target[p];
                }

                // Handle the rest: p is the name of the remote method
                return function(...args: any) { return target.calleRemoteMethod(p, args)}
            }
        });
    }
}

/**
 * Convenience. see readme.md
 */
export function createRESTFuncsClient<Service>(url: string): Service {
    // @ts-ignore
    return new RESTFuncsClient({url: url});
}

