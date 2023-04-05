import {Request, Response} from "express";
import _ from "underscore";
import {RestError, RestfuncsOptions} from "./index";
import {reflect, ReflectedMethod, ReflectedMethodParameter} from "typescript-rtti";
import {Camelize, enhanceViaProxyDuringCall} from "./Util";

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
        throw new RestError("Method is protected.")
    }
    if(reflectedMethod.isPrivate) {
        throw new RestError("Method is private.")
    }

    // The other blocks should have already caught it. But just to be safe for future language extensions we explicitly check again:
    if(reflectedMethod.visibility !== "public") {
        throw new RestError("Method is not public")
    }
}

/**
 * Throws an exception if args does not match the parameters of reflectedMethod
 * @param reflectedMethod
 * @param args
 */
export function checkParameterTypes(reflectedMethod: ReflectedMethod, args: Readonly<any[]>) {
    // Make a stack out of args so we can pull out the first till the last. This wqy we can deal with ...rest params
    let argsStack = [...args]; // shallow clone
    argsStack.reverse();

    const errors: string[] = [];
    for(const i in reflectedMethod.parameters) {
        const parameter = reflectedMethod.parameters[i];
        if(parameter.isOmitted) {
            throw new RestError("Omitted arguments not supported")
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
            throw new RestError(`Runtime typechecking of destructuring arguments is not yet supported`)
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
        throw new RestError(`Too many arguments. Expected ${reflectedMethod.parameters.length}, got ${args.length}`)
    }

    if(errors.length > 0) {
        throw new RestError(errors.join("; "))
    }
}


export type RegularHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type ParameterSource = "string" | "json" | null; // Null means: Cannot be auto converted
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
     * @param httpMethod Http method that was used for the call. For websockets, you must make sure that you
     * @param evil_methodName
     * @param evil_args
     * @param enhancementProps These fields will be temporarily added to this during the call.
     * @param options
     */
    public async validateAndDoCall(httpMethod: string, evil_methodName: string, evil_args: any[], enhancementProps: Partial<this>, options: RestfuncsOptions): Promise<any> {

        // typing was only for the caller. We go back to "any" so must check again:
        const methodName = <any> evil_methodName;
        const args = <any> evil_args;

        // Check methodName:
        if(!methodName) {
            throw new RestError(`methodName not set`)
        }
        if(typeof methodName !== "string") {
            throw new RestError(`methodName is not a string`)
        }
        if(new (class extends RestService{})()[methodName] !== undefined || {}[methodName] !== undefined) { // property exists in an empty service ?
            throw new RestError(`You are trying to call a remote method that is a reserved name: ${methodName}`)
        }
        if(this[methodName] === undefined) {
            throw new RestError(`You are trying to call a remote method that does not exist: ${methodName}`)
        }
        const method = this[methodName];
        if(typeof method != "function") {
            throw new RestError(`${methodName} is not a function`)
        }

        if (httpMethod === "GET") {
            if (this.denyMethodByGet(methodName)) {
                throw new RestError(`${methodName} is not allowed to be called by http GET. See https://github.com/bogeeee/restfuncs#get-methods-can-be-triggered-cross-site`)
            }
        }
        else if(httpMethod === "POST" || httpMethod === "PUT" || httpMethod === "DELETE") {
            // allow
        }
        else {
            throw new RestError(`http ${httpMethod} not allowed`)
        }

        // Make sure that args is an array:
        if(!args || args.constructor !== Array) {
            throw new RestError("args is not an array")
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
     * You can override this as part of the API
     * @param query i.e. book=1984&author=George%20Orwell&keyWithoutValue
     * @return I.e. {
     *      result: {book: "1984", author="George Orwell", keyWithoutValue:"true"}
     *      containsStringValuesOnly: true // decides, which of the autoConvertValueForParameter_... methods is used.
     * }
     */
    parseQuery(query: string): {result: Record<string, any>|any [], containsStringValuesOnly: boolean} {
        // Query is a list i.e: "a,b,c" ?
        if(query.indexOf(",") > query.indexOf("=")) { // , before = means, we assume it is a comma separated list
            return {
                result: query.split(",").map( value => decodeURIComponent(value)),
                containsStringValuesOnly: true
            };
        }
        else if(query.indexOf("=") > 0 || query.indexOf("&") > -1){ // Query is a map (named) ?
            const result: Record<string, string> = {};
            const tokens = query.split("&");
            for (const token of tokens) {
                if (!token) {
                    continue;
                }
                if (token.indexOf("=") > -1) {
                    const [key, value] = token.split("=");
                    if (key) {
                        result[decodeURIComponent(key)] = decodeURIComponent(value);
                    }
                } else {
                    result[decodeURIComponent(token)] = "true";
                }
            }
            return {result, containsStringValuesOnly: true};
        }
        else {
            return {result: [decodeURIComponent(query)], containsStringValuesOnly: true}; // Single element
        }
    }

    /**
     * You can override this as part of the API
     * @param methodName method/function name
     * @see RestfuncsOptions#allowGET This setting still has precedence.
     */
    public denyMethodByGet(methodName: string) {
        return !methodName.startsWith("get");
    }

    /**
     * You can override this as part of the API
     * @param methodName
     */
    public hasMethod(methodName: string) {
        return this[methodName] && (typeof this[methodName] === "function");
    }

    /**
     * Retrieves, which method should be picked. I.e GET user -> getUser
     *
     * You can override this as part of the API
     * @param httpMethod
     * @param path the path portion that should represents the method name. No "/"s contained. I.e. "user" (meaning getUser or user)
     */
    public getMethodNameForCall(httpMethod: RegularHttpMethod, path: string): string | null {
        if (this.hasMethod(path)) { // Direct hit
            return path; // We are done and don't lose performance on other checks
        }

        // check: GET user -> getUser
        {
            const candidate = `${httpMethod.toLowerCase()}${Camelize(path)}`;
            if (this.hasMethod(candidate)) {
                return candidate;
            }
        }


        if (httpMethod === "PUT") {
            // check: PUT user -> updateUser
            {
                const candidate = `update${Camelize(path)}`;
                if (this.hasMethod(candidate)) {
                    return candidate;
                }
            }

            // check: PUT user -> setUser
            {
                const candidate = `set${Camelize(path)}`;
                if (this.hasMethod(candidate)) {
                    return candidate;
                }
            }
        }

        return null;
    }

    /**
     * @see #autoConvertValueForParameter_fromString
     * @see #autoConvertValueForParameter_fromJson
     */
    public autoConvertValueForParameter(value: any, parameter: ReflectedMethodParameter, source: ParameterSource): any {
        if(source === "string") {
            if(typeof value !== "string") {
                throw new RestError(`${parameter.name} parameter should be a string`)
            }
            return this.autoConvertValueForParameter_fromString(value, parameter);
        }
        else if(source === "json") {
            return this.autoConvertValueForParameter_fromJson(value, parameter);
        }
        else {
            // TODO: Auto convert Buffers into strings
            return value;
        }
    }

    /**
     * Values from the url path or the query are plain strings only.
     * This method is called to convert them to the actual needed parameter type.
     * If it doesn't know how to convert it, the value is returned as is. The validity/security is checked at a later stage again.
     *
     * You can override this as part of the API
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    public autoConvertValueForParameter_fromString(value: string, parameter: ReflectedMethodParameter): any {
        return value; // TODO
    }

    /**
     * Fixes values that were passed in the request body (json) to the actual needed parameter type.
     *
     * Currently this is only for Date objects, since json lacks of representing these.
     * Other values (i.e. parameter needs Number but value is a string) will be left untouched, so they will produce the right error message at the later validity/security checking stage.
     *
     * You can override this as part of the API
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    public autoConvertValueForParameter_fromJson(value: any, parameter: ReflectedMethodParameter): any {
        return value; // TODO
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
            if(options.checkArguments) {
                throw new RestError("Runtime type information is not available.\n" +  restService._diagnosisWhyIsRTTINotAvailable())
            }
            else if(options.checkArguments === undefined) {
                console.warn("**** SECURITY WARNING: Runtime type information is not available. This can be a security risk as your func's arguments cannot be checked automatically !\n" + restService._diagnosisWhyIsRTTINotAvailable())
            }
        }

        return restService;
    }

    public _diagnosisWhyIsRTTINotAvailable() {
        return diagnosis_isAnonymousObject(this) ? "Probably this is because your service is an anonymous object and not defined as a class." : "To enable runtime arguments typechecking, See https://github.com/bogeeee/restfuncs#runtime-arguments-typechecking-shielding-against-evil-input";
    }
}