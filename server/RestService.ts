import {Request, Response} from "express";
import _ from "underscore";
import {RestfuncsOptions} from "./index";
import {reflect} from "typescript-rtti";

function diagnosis_isAnonymousObject(o: object) {
    if(o.constructor?.name === "Object") {
        return true;
    }

    return false;
}

export function isTypeInfoAvailable(restService: object) {
    const r = reflect(restService);

    // *** Some heuristic checks: (the rtti api currently has no really good way to check it)
    // TODO: improve checks for security reasons !

    /*
    if(r.methods.length === 0) {
        return false;
    }
    // Still this check was not enough because we received  the methods of the prototype
    */

    if(r.getProperty("xxyyyyzzzzzdoesntExist") !== undefined) { // non existing property reported as existing ?
        return false;
    }

    return true
}



/**
 * Service base class. Extend it and use {@see restfuncs} on it.
 */
export class RestService {
    [index: string]: any

    /**
     * The currently running (express) request. See https://expressjs.com/en/4x/api.html#req
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
        // @ts-ignore // TODO: make req | null in 1.0 API
    protected req!: Request = null;

    /**
     * Response for the currently running (express) request. You can modify any header fields as you like. See https://expressjs.com/en/4x/api.html#res
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
        // @ts-ignore // TODO: make req | null in 1.0 API
    protected resp!: Response = null;


    /**
     * The browser/client session (for the currently running request). You can add any user defined content to it.
     * What you set as initial value here will also be the initial value of EVERY new session. Note that this initial session is not deeply cloned.
     *
     * When restfuncs is used with express, you must install the session handler in express yourself (follow the no-sessionhandler errormessage for guidance).
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected session: {} | null = {};

    /**
     * Allows you to intercept calls. Override and implement it with the default body:
     * <pre><code>
     *      return  await this[funcName](...args) // Call the original function
     * </code></pre>
     *
     * You have access to this.req, this.resp and this.session as usual.
     *
     * @param funcName name of the function to be called
     * @param args args of the function to be called
     */
    protected async doCall(funcName: string, args: any[]) {
        return await this[funcName](...args) // Call the original function
    }


    /**
     * Internal
     * @private
     */
    _sessionPrototype?: object;

    /**
     * Internal: Must be called by every adapter (i.e. express) before the service is used.
     * @param restServiceObj
     */
    public static initializeRestService(restServiceObj: object, options: RestfuncsOptions): RestService {
        if(!(restServiceObj instanceof RestService)) {
            _.extend(restServiceObj, [new RestService(), restServiceObj]); // Add the functions of RestService to restServiceObj. Then again, add all restServiceObj props and functions, cause they should dominate. I.e. see the docs where the user can just add a doCall function
        }

        const restService = <RestService> restServiceObj;

        restService._sessionPrototype = restService.session || {}; // The user maybe has some initialization code for his session: Ie. {counter:0}  - so we want to make that convenient
        // Safety: Any non-null value for these may be confusing when (illegally) accessed from the outside.
        // @ts-ignore
        restService.req = null; restService.resp = null; restService.session = null;

        // Warn/error if type info is not available:
        if(!isTypeInfoAvailable(restService)) {
            const diagnosis_whyNotAvailable = diagnosis_isAnonymousObject(restService)?"Probably this is because your service is an anonymous object and not defined as a class.":"To enable runtime arguments typechecking, See https://github.com/bogeeee/restfuncs#runtime-arguments-typechecking-shielding-against-evil-input";
            if(options.checkArguments) {
                throw new Error("Runtime type information is not available.\n" +  diagnosis_whyNotAvailable);
            }
            else if(options.checkArguments === undefined) {
                console.warn("**** SECURITY WARNING: Runtime type information is not available. This can be a security risk as your func's arguments cannot be checked automatically !\n" + diagnosis_whyNotAvailable)
            }
        }

        return restService;
    }

}