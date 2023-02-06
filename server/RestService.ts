import {Request, Response} from "express";
import _ from "underscore";
import {RestfuncsOptions} from "./index";
import {reflect, ReflectedMethod} from "typescript-rtti";
import {enhanceViaProxyDuringCall} from "./Util";

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
 * Throws an exception if you're not allowed to call the method from the outside
 * @param reflectedMethod
 */
function checkMethodAccessibility(reflectedMethod: ReflectedMethod) {
    if(reflectedMethod.isProtected) {
        throw new Error("Method is protected.")
    }
    if(reflectedMethod.isPrivate) {
        throw new Error("Method is private.")
    }

    // The other blocks should have already caught it. But just to be safe for future language extensions we explicitly check again:
    if(reflectedMethod.visibility !== "public") {
        throw new Error("Method is not public")
    }
}

/**
 * Throws an exception if args does not match the parameters of reflectedMethod
 * @param reflectedMethod
 * @param args
 */
function checkParameterTypes(reflectedMethod: ReflectedMethod, args: Readonly<any[]>) {
    // Make a stack out of args so we can pull out the first till the last. This wqy we can deal with ...rest params
    let argsStack = [...args]; // shallow clone
    argsStack.reverse();

    const errors: string[] = [];
    for(const i in reflectedMethod.parameters) {
        const parameter = reflectedMethod.parameters[i];
        if(parameter.isOmitted) {
            throw new Error("Omitted arguments not supported");
        }
        if(parameter.isRest) {
            argsStack.reverse();

            // Validate argsStack against parameter.type:
            const collectedErrorsForThisParam: Error[] = [];
            const ok = parameter.type.matchesValue(argsStack, collectedErrorsForThisParam); // Check value
            if(!ok || collectedErrorsForThisParam.length > 0) {
                errors.push(`Invalid value for parameter ${parameter.name}: ${collectedErrorsForThisParam.map(e => e.message).join(", ")}`);
            }

            argsStack = [];
            continue;
        }
        if(parameter.isBinding) {
            throw new Error(`Runtime typechecking of destructuring arguments is not yet supported`);
        }

        const arg =  argsStack.length > 0?argsStack.pop():undefined;

        // Allow undefined for optional parameter:
        if(parameter.isOptional && arg === undefined) {
            continue;
        }

        // Validate arg against parameter.type:
        const collectedErrorsForThisParam: Error[] = [];
        const ok = parameter.type.matchesValue(arg, collectedErrorsForThisParam); // Check value
        if(!ok || collectedErrorsForThisParam.length > 0) {
            errors.push(`Invalid value for parameter ${parameter.name}: ${collectedErrorsForThisParam.map(e => e.message).join(", ")}`);
        }
    }

    if(argsStack.length > 0) {
        throw new Error(`Too many arguments. Expected ${reflectedMethod.parameters.length}, got ${args.length}`);
    }

    if(errors.length > 0) {
        throw new Error(errors.join("; "))
    }
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
     * Security checks the method name and args and executes the methods call.
     * @param evil_methodName
     * @param evil_args
     * @param enhancementProps These fields will be temporarily added to this during the call.
     * @param options
     */
    public async validateAndDoCall(evil_methodName: string, evil_args: any[], enhancementProps: Partial<this>, options: RestfuncsOptions): Promise<any> {

        // typing was only for the caller. We go back to "any" so must check again:
        const methodName = <any> evil_methodName;
        const args = <any> evil_args;

        // Check methodName:
        if(!methodName) {
            throw new Error(`methodName not set`);
        }
        if(typeof methodName !== "string") {
            throw new Error(`methodName is not a string`);
        }
        if(new (class extends RestService{})()[methodName] !== undefined || {}[methodName] !== undefined) { // property exists in an empty service ?
            throw new Error(`You are trying to call a remote method that is a reserved name: ${methodName}`);
        }
        if(this[methodName] === undefined) {
            throw new Error(`You are trying to call a remote method that does not exist: ${methodName}`);
        }
        const method = this[methodName];
        if(typeof method != "function") {
            throw new Error(`${methodName} is not a function`);
        }

        // Make sure that args is an array:
        if(!args || args.constructor !== Array) {
            throw new Error("args is not an array");
        }

        // Runtime type checking of args:
        if(options.checkArguments || (options.checkArguments === undefined && isTypeInfoAvailable(this))) { // Checking required or available ?
            const reflectedMethod = reflect(this).getMethod(methodName); // we could also use reflect(method) but this doesn't give use params for anonymous classes - strangely'
            checkMethodAccessibility(<ReflectedMethod> reflectedMethod);
            checkParameterTypes(<ReflectedMethod> reflectedMethod,args);
        }

        // Check enhancementProps (for the very paranoid):
        if(!enhancementProps || typeof enhancementProps !== "object" || _.functions(enhancementProps).length > 0) {
            throw new Error("Invalid enhancementProps argument");
        }
        const allowed: Record<string, boolean> = {req:true, resp: true, session: true}
        Object.keys(enhancementProps).map(key => {if(!allowed[key]) { throw new Error(`${key} not allowed in enhancementProps`)}})

        let result;
        await enhanceViaProxyDuringCall(this, enhancementProps, async (restService) => { // make .req and .resp safely available during call
            result = await restService.doCall(methodName, args); // Call method with user's doCall interceptor;
        }, methodName);

        return result
    }

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
     * @param options
     */
    public static initializeRestService(restServiceObj: object, options: RestfuncsOptions): RestService {
        /**
         * Nonexisting props and methods get copied to the target so that it's like the target exends the base class .
         * @param target
         * @param base
         */
        function baseOn(target: {[index: string]: any }, base: {[index: string]: any }) {
            [...Object.keys(base), ..._.functions(base)].map(propName => {
                if(target[propName] === undefined) {
                    target[propName] = base[propName];
                }
            })
        }


        if(!(restServiceObj instanceof RestService)) {
            baseOn(restServiceObj, new RestService());
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